const { Op } = require('sequelize');
const { addJob, addDeadLetterJob, registerWorker, isRedisEnabled } = require('../../core/queue/queueManager');
const { runInspectionAnalysis } = require('./analysis.service');
const {
  AiProcessingJob,
  Inspection,
  InspectionSubmission,
  InspectionEvent,
  InspectionMedia,
} = require('../../models');

const ANALYSIS_QUEUE = 'inspection-analysis';
const ANALYSIS_JOB_TYPE = 'AI_ANALYSIS';
const DEFAULT_INLINE_TIMEOUT_MS = 120000;
const DEFAULT_INLINE_CONCURRENCY = 2;
const DEFAULT_DEDUP_WINDOW_MS = 120000;
const STALE_RUNNING_FAILURE_MS = 180000;

const inlineQueue = [];
const inlineQueuedKeys = new Set();
let inlineActiveCount = 0;

const resolveMaxAttempts = () => {
  const value = Number(process.env.ANALYSIS_QUEUE_ATTEMPTS || process.env.QUEUE_ATTEMPTS || 3);
  if (Number.isFinite(value) && value > 0) {
    return Math.min(value, 10);
  }
  return 3;
};

const resolveInlineTimeoutMs = () => {
  const value = Number(process.env.ANALYSIS_INLINE_JOB_TIMEOUT_MS || DEFAULT_INLINE_TIMEOUT_MS);
  if (Number.isFinite(value) && value >= 15000) {
    return value;
  }
  return DEFAULT_INLINE_TIMEOUT_MS;
};

const resolveInlineConcurrency = () => {
  const value = Number(process.env.ANALYSIS_INLINE_CONCURRENCY || DEFAULT_INLINE_CONCURRENCY);
  if (Number.isFinite(value) && value > 0) {
    return Math.min(value, 8);
  }
  return DEFAULT_INLINE_CONCURRENCY;
};

const resolveDedupWindowMs = () => {
  const value = Number(process.env.ANALYSIS_DEDUP_WINDOW_MS || DEFAULT_DEDUP_WINDOW_MS);
  if (Number.isFinite(value) && value >= 10000) {
    return value;
  }
  return DEFAULT_DEDUP_WINDOW_MS;
};

const buildInlineTaskKey = ({
  inspectionId,
  submissionId = null,
  imageId = null,
  jobType = ANALYSIS_JOB_TYPE,
}) =>
  `type:${String(jobType || ANALYSIS_JOB_TYPE)}|inspection:${inspectionId}|submission:${submissionId || 'none'}|image:${imageId || 'none'}`;

const withTimeout = async (promise, timeoutMs, timeoutCode = 'INLINE_ANALYSIS_TIMEOUT') => {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Inline analysis timed out after ${timeoutMs}ms`);
          error.code = timeoutCode;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

const buildDeterministicJobId = ({
  inspectionId,
  submissionId,
  imageId = null,
  requestContext,
}) => {
  if (submissionId && imageId) {
    return `inspection:${inspectionId}:submission:${submissionId}:image:${imageId}`;
  }
  if (imageId) {
    return `inspection:${inspectionId}:image:${imageId}`;
  }
  if (submissionId) {
    return `inspection:${inspectionId}:submission:${submissionId}`;
  }
  if (requestContext?.reprocess) {
    const token =
      String(requestContext.reprocessToken || requestContext.requestId || '').trim() ||
      `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return `inspection:${inspectionId}:reprocess:${token}`;
  }
  return `inspection:${inspectionId}:latest`;
};

const sanitizeRequestContext = (requestContext = {}) => {
  const safe = requestContext && typeof requestContext === 'object' ? requestContext : {};
  const user = safe.user && typeof safe.user === 'object' ? safe.user : null;
  const headers = safe.headers && typeof safe.headers === 'object' ? safe.headers : null;
  const safeHeaders = {};

  const userAgent = headers?.['user-agent'] || headers?.['User-Agent'] || null;
  const forwardedFor = headers?.['x-forwarded-for'] || headers?.['X-Forwarded-For'] || null;
  if (userAgent) {
    safeHeaders['user-agent'] = String(userAgent).slice(0, 300);
  }
  if (forwardedFor) {
    safeHeaders['x-forwarded-for'] = String(forwardedFor).slice(0, 200);
  }

  return {
    requestId: safe.requestId ? String(safe.requestId).slice(0, 120) : null,
    ip: safe.ip ? String(safe.ip).slice(0, 120) : null,
    reprocess: Boolean(safe.reprocess),
    reprocessToken: safe.reprocess
      ? String(safe.reprocessToken || '').trim() || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      : null,
    user: user
      ? {
          id: user.id || null,
          tenantId: user.tenantId || null,
          isSuperAdmin: Boolean(user.isSuperAdmin),
          roleCodes: Array.isArray(user.roleCodes) ? user.roleCodes.slice(0, 20) : [],
        }
      : null,
    headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : null,
  };
};

const createProcessingJobRecord = async ({
  inspectionId,
  tenantId = null,
  submissionId = null,
  imageId = null,
  jobType = ANALYSIS_JOB_TYPE,
  queueJobId = null,
  payload = null,
  maxAttempts = 3,
}) =>
  AiProcessingJob.create({
    tenant_id: tenantId,
    inspection_id: inspectionId,
    submission_id: submissionId,
    image_id: imageId,
    job_type: String(jobType || ANALYSIS_JOB_TYPE),
    queue_name: ANALYSIS_QUEUE,
    queue_job_id: queueJobId,
    status: 'queued',
    attempts: 0,
    max_attempts: maxAttempts,
    queued_at: new Date(),
    payload: payload || null,
  });

const recordInspectionEvent = async ({
  inspectionId,
  tenantId = null,
  toiletId = null,
  imageId = null,
  eventType,
  eventStatus = null,
  payload = null,
}) =>
  InspectionEvent.create({
    tenant_id: tenantId,
    inspection_id: inspectionId,
    toilet_id: toiletId || null,
    image_id: imageId || null,
    event_type: eventType,
    event_status: eventStatus,
    source: 'queue',
    payload: payload || null,
    occurred_at: new Date(),
  });

const findRecentProcessingJob = async ({
  inspectionId,
  imageId = null,
  submissionId = null,
}) => {
  const dedupWindowMs = resolveDedupWindowMs();
  const recentCutoff = new Date(Date.now() - dedupWindowMs);
  const staleRunningCutoff = new Date(Date.now() - STALE_RUNNING_FAILURE_MS);

  const where = {
    inspection_id: inspectionId,
    status: { [Op.in]: ['queued', 'running'] },
    updated_at: { [Op.gte]: recentCutoff },
  };
  if (imageId) {
    where.image_id = imageId;
  }
  if (submissionId) {
    where.submission_id = submissionId;
  }

  const recent = await AiProcessingJob.findOne({
    where,
    order: [['updated_at', 'DESC']],
  });
  if (recent) {
    return recent;
  }

  if (!imageId) {
    return null;
  }

  const staleRunning = await AiProcessingJob.findOne({
    where: {
      inspection_id: inspectionId,
      image_id: imageId,
      status: 'running',
      updated_at: { [Op.lt]: staleRunningCutoff },
    },
    order: [['updated_at', 'DESC']],
  });
  if (!staleRunning) {
    return null;
  }

  await staleRunning.update({
    status: 'failed',
    last_error: 'Marked stale after timeout watchdog',
    updated_at: new Date(),
  });

  await InspectionMedia.update(
    {
      ai_status: 'AI_FAILED',
      validation_status: 'FAILED_SOURCE',
      validation_reason: 'Marked stale after timeout watchdog',
      review_required: true,
      ai_error: 'Marked stale after timeout watchdog',
      updated_at: new Date(),
    },
    {
      where: {
        id: imageId,
        ai_status: 'AI_PROCESSING',
      },
    }
  );

  await recordInspectionEvent({
    inspectionId,
    tenantId: staleRunning.tenant_id,
    imageId,
    eventType: 'analysis.job.stale_marked_failed',
    eventStatus: 'failed',
    payload: {
      staleQueueJobId: staleRunning.queue_job_id || null,
      staleJobId: staleRunning.id,
    },
  });

  return null;
};

const markInlineJobFailure = async ({
  inspectionId,
  tenantId = null,
  submissionId = null,
  imageId = null,
  queueJobId = null,
  jobType = ANALYSIS_JOB_TYPE,
  error,
}) => {
  const errorMessage = String(error?.message || error || 'Inline analysis failed').slice(0, 2000);

  const processingJob = queueJobId
    ? await AiProcessingJob.findOne({
        where: {
          queue_name: ANALYSIS_QUEUE,
          queue_job_id: queueJobId,
        },
        order: [['created_at', 'DESC']],
      })
    : null;

  if (processingJob) {
    await processingJob.update({
      status: 'failed',
      last_error: errorMessage,
      updated_at: new Date(),
    });
  }

  if (imageId) {
    await InspectionMedia.update(
      {
        ai_status: 'AI_FAILED',
        validation_status: 'FAILED_SOURCE',
        validation_reason: errorMessage.slice(0, 500),
        review_required: true,
        ai_error: errorMessage,
        updated_at: new Date(),
      },
      {
        where: {
          id: imageId,
          ai_status: { [Op.in]: ['AI_QUEUED', 'AI_PROCESSING', 'UPLOADED'] },
        },
      }
    );
  }

  const inspection = await Inspection.findByPk(inspectionId);
  if (inspection) {
    await inspection.update({
      processing_status: 'failed',
      pipeline_status: 'failed',
      review_required: true,
      last_processing_error: errorMessage,
      updated_at: new Date(),
    });
  }

  if (submissionId) {
    const submission = await InspectionSubmission.findByPk(submissionId);
    if (submission) {
      await submission.update({
        status: 'failed',
        updated_at: new Date(),
      });
    }
  }

  await recordInspectionEvent({
    inspectionId,
    tenantId: tenantId || inspection?.tenant_id || null,
    imageId,
    eventType: 'analysis.job.inline_failed',
    eventStatus: 'failed',
    payload: {
      queueJobId,
      type: String(jobType || ANALYSIS_JOB_TYPE),
      imageId,
      error: errorMessage,
    },
  });

  try {
    const { recomputeInspectionAggregates } = require('../inspections/inspectionEvidence.service');
    await recomputeInspectionAggregates(inspectionId, { updateToilet: true });
  } catch (_) {
    // best effort
  }
};

const runInlineTask = async (task) => {
  try {
    await withTimeout(
      runInspectionAnalysis({
        inspectionId: task.inspectionId,
        submissionId: task.submissionId,
        imageId: task.imageId,
        jobType: task.jobType,
        queueJobId: task.queueJobId,
        req: task.requestContext,
      }),
      resolveInlineTimeoutMs()
    );
  } catch (error) {
    await markInlineJobFailure({
      inspectionId: task.inspectionId,
      tenantId: task.tenantId,
      submissionId: task.submissionId,
      imageId: task.imageId,
      queueJobId: task.queueJobId,
      jobType: task.jobType,
      error,
    });
    // eslint-disable-next-line no-console
    console.error('Inline analysis processing failed:', error.message);
  }
};

const drainInlineQueue = () => {
  while (inlineActiveCount < resolveInlineConcurrency() && inlineQueue.length > 0) {
    const task = inlineQueue.shift();
    inlineActiveCount += 1;
    void runInlineTask(task)
      .catch(() => null)
      .finally(() => {
        inlineActiveCount = Math.max(inlineActiveCount - 1, 0);
        inlineQueuedKeys.delete(task.key);
        drainInlineQueue();
      });
  }
};

const enqueueInspectionAnalysis = async ({
  inspectionId,
  submissionId = null,
  imageId = null,
  tenantId = null,
  jobType = ANALYSIS_JOB_TYPE,
  requestContext = {},
}) => {
  const maxAttempts = resolveMaxAttempts();
  const safeRequestContext = sanitizeRequestContext(requestContext);
  const queueJobId = buildDeterministicJobId({
    inspectionId,
    submissionId,
    imageId,
    requestContext: safeRequestContext,
  });
  const payload = {
    type: String(jobType || ANALYSIS_JOB_TYPE).trim() || ANALYSIS_JOB_TYPE,
    inspectionId,
    submissionId,
    imageId,
    tenantId,
    requestContext: safeRequestContext,
  };

  const recentProcessingJob = await findRecentProcessingJob({
    inspectionId,
    imageId,
    submissionId,
  });
  if (recentProcessingJob) {
    return {
      queued: true,
      deduped: true,
      queueJobId: recentProcessingJob.queue_job_id || queueJobId,
      type: payload.type,
      imageId,
    };
  }

  const queued = await addJob(
    ANALYSIS_QUEUE,
    'process-inspection',
    payload,
    {
      jobId: queueJobId,
      attempts: maxAttempts,
      backoff: {
        type: 'exponential',
        delay: Number(process.env.ANALYSIS_QUEUE_BACKOFF_MS || process.env.QUEUE_BACKOFF_MS || 1000),
      },
      removeOnComplete: Number(process.env.ANALYSIS_QUEUE_REMOVE_COMPLETE || 200),
      removeOnFail: false,
    }
  );

  if (queued) {
    await createProcessingJobRecord({
      inspectionId,
      tenantId,
      submissionId,
      imageId,
      jobType: payload.type,
      queueJobId,
      payload,
      maxAttempts,
    });
    await recordInspectionEvent({
      inspectionId,
      tenantId,
      imageId,
      eventType: 'analysis.job.queued',
      eventStatus: 'queued',
      payload: {
        type: payload.type,
        imageId,
        queueJobId,
      },
    });
    return { queued: true, queueJobId, type: payload.type, imageId };
  }

  // Redis is unavailable: run in in-process queue with bounded concurrency.
  const degradedQueueJobId = `${queueJobId}:inline:${Date.now()}`;
  const inlineKey = buildInlineTaskKey({
    inspectionId,
    submissionId,
    imageId,
    jobType: payload.type,
  });

  if (inlineQueuedKeys.has(inlineKey)) {
    return {
      queued: true,
      deduped: true,
      queueJobId: degradedQueueJobId,
      type: payload.type,
      imageId,
    };
  }

  await createProcessingJobRecord({
    inspectionId,
    tenantId,
    submissionId,
    imageId,
    jobType: payload.type,
    queueJobId: degradedQueueJobId,
    payload: {
      ...payload,
      degradedMode: true,
    },
    maxAttempts: 1,
  });
  await recordInspectionEvent({
    inspectionId,
    tenantId,
    imageId,
    eventType: 'analysis.job.queued_inline_fallback',
    eventStatus: 'queued',
    payload: {
      type: payload.type,
      imageId,
      queueJobId: degradedQueueJobId,
    },
  });

  inlineQueuedKeys.add(inlineKey);
  inlineQueue.push({
    key: inlineKey,
    inspectionId,
    submissionId,
    imageId,
    tenantId,
    jobType: payload.type,
    queueJobId: degradedQueueJobId,
    requestContext: safeRequestContext,
  });
  drainInlineQueue();

  return {
    queued: false,
    inline: true,
    queueJobId: degradedQueueJobId,
    type: payload.type,
    imageId,
  };
};

const registerAnalysisWorker = () => {
  const worker = registerWorker(
    ANALYSIS_QUEUE,
    async (job) => {
      await runInspectionAnalysis({
        inspectionId: job.data.inspectionId,
        submissionId: job.data.submissionId || null,
        imageId: job.data.imageId || null,
        jobType: String(job.data.type || ANALYSIS_JOB_TYPE),
        queueJobId: String(job.id || job.data?.queueJobId || ''),
        req: job.data.requestContext || null,
      });
    },
    {
      concurrency: Number(process.env.ANALYSIS_WORKER_CONCURRENCY || process.env.QUEUE_WORKER_CONCURRENCY || 2),
    }
  );

  if (!worker) {
    return null;
  }

  worker.on('failed', async (job, error) => {
    try {
      const queueJobId = String(job?.id || job?.data?.queueJobId || '');
      const processingJob = queueJobId
        ? await AiProcessingJob.findOne({
            where: {
              queue_name: ANALYSIS_QUEUE,
              queue_job_id: queueJobId,
            },
            order: [['created_at', 'DESC']],
          })
        : null;

      const attemptsMade = Number(job?.attemptsMade || 0);
      const attemptsLimit = Number(job?.opts?.attempts || resolveMaxAttempts());
      const terminalFailure = attemptsMade >= attemptsLimit;

      if (processingJob) {
        await processingJob.update({
          status: terminalFailure ? 'dead_letter' : 'failed',
          attempts: attemptsMade,
          last_error: String(error?.message || 'Unknown analysis worker failure').slice(0, 2000),
          dead_lettered_at: terminalFailure ? new Date() : null,
          updated_at: new Date(),
        });
      }

      if (terminalFailure) {
        await addDeadLetterJob(
          ANALYSIS_QUEUE,
          {
            queueJobId,
            inspectionId: job?.data?.inspectionId || null,
            submissionId: job?.data?.submissionId || null,
            imageId: job?.data?.imageId || null,
            type: String(job?.data?.type || ANALYSIS_JOB_TYPE),
            reason: String(error?.message || 'Unknown worker failure'),
          },
          {
            jobId: queueJobId ? `${queueJobId}:dlq` : undefined,
          }
        );

        const inspection = await Inspection.findByPk(job?.data?.inspectionId || null);
        if (inspection) {
          await inspection.update({
            processing_status: 'failed',
            pipeline_status: 'failed',
            review_required: true,
            last_processing_error: String(error?.message || 'Unknown worker failure').slice(0, 2000),
            updated_at: new Date(),
          });
          await InspectionEvent.create({
            tenant_id: inspection.tenant_id,
            inspection_id: inspection.id,
            toilet_id: inspection.toilet_unit_id || null,
            image_id: job?.data?.imageId || null,
            event_type: 'analysis.job.dead_letter',
            event_status: 'failed',
            source: 'worker',
            payload: {
              queueJobId,
              type: String(job?.data?.type || ANALYSIS_JOB_TYPE),
              imageId: job?.data?.imageId || null,
              attemptsMade,
              attemptsLimit,
              error: String(error?.message || 'Unknown worker failure'),
            },
            occurred_at: new Date(),
          });
        }

        if (job?.data?.submissionId) {
          const submission = await InspectionSubmission.findByPk(job.data.submissionId);
          if (submission) {
            await submission.update({
              status: 'failed',
              updated_at: new Date(),
            });
          }
        }
      }
    } catch (eventError) {
      // eslint-disable-next-line no-console
      console.error('Failed to handle worker failure lifecycle:', eventError.message);
    }
  });

  return worker;
};

module.exports = {
  ANALYSIS_QUEUE,
  ANALYSIS_JOB_TYPE,
  enqueueInspectionAnalysis,
  registerAnalysisWorker,
  isRedisEnabled,
};
