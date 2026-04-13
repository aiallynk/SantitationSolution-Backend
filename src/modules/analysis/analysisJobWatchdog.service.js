const { Op } = require('sequelize');
const {
  AiProcessingJob,
  InspectionMedia,
  InspectionEvent,
} = require('../../models');
const { enqueueInspectionAnalysis } = require('./analysis.queue');
const { IMAGE_PROCESSING_STATES } = require('../inspections/imageLifecycle.constants');

const WATCHDOG_DEFAULT_INTERVAL_MS = 30 * 1000;
const WATCHDOG_DEFAULT_STALE_MS = 3 * 60 * 1000;

let watchdogTimer = null;
let watchdogRunning = false;

const resolveWatchdogIntervalMs = () => {
  const value = Number(process.env.ANALYSIS_STALE_WATCHDOG_INTERVAL_MS || WATCHDOG_DEFAULT_INTERVAL_MS);
  if (Number.isFinite(value) && value >= 10000) return value;
  return WATCHDOG_DEFAULT_INTERVAL_MS;
};

const resolveWatchdogStaleMs = () => {
  const value = Number(process.env.ANALYSIS_PROCESSING_STALE_MS || WATCHDOG_DEFAULT_STALE_MS);
  if (Number.isFinite(value) && value >= 30000) return value;
  return WATCHDOG_DEFAULT_STALE_MS;
};

const markImageForRetry = async (job) => {
  if (!job.image_id) return;
  await InspectionMedia.update(
    {
      ai_status: 'AI_QUEUED',
      processing_state: IMAGE_PROCESSING_STATES.AI_RETRYING,
      retry_count: Number(job.attempts || 0),
      last_retry_at: new Date(),
      next_retry_at: null,
      last_error_code: 'ANALYSIS_STALE_LEASE',
      last_error_message: 'AI processing lease expired and was requeued',
      ai_error: 'AI processing lease expired and was requeued',
      updated_at: new Date(),
    },
    {
      where: { id: job.image_id },
    }
  );
};

const markImageDeadLetter = async (job, reason) => {
  if (!job.image_id) return;
  await InspectionMedia.update(
    {
      ai_status: 'AI_FAILED',
      processing_state: IMAGE_PROCESSING_STATES.MANUAL_REVIEW_REQUIRED,
      review_required: true,
      manual_review_required_at: new Date(),
      last_error_code: 'ANALYSIS_STALE_MAX_ATTEMPTS',
      last_error_message: String(reason || 'AI processing stalled and exceeded retry attempts').slice(0, 2000),
      ai_error: String(reason || 'AI processing stalled and exceeded retry attempts').slice(0, 2000),
      updated_at: new Date(),
    },
    {
      where: { id: job.image_id },
    }
  );
};

const emitWatchdogEvent = async (job, eventType, payload = {}) => {
  await InspectionEvent.create({
    tenant_id: job.tenant_id || null,
    inspection_id: job.inspection_id,
    toilet_id: null,
    image_id: job.image_id || null,
    event_type: eventType,
    event_status: payload.eventStatus || null,
    source: 'watchdog',
    actor_user_id: null,
    payload,
    occurred_at: new Date(),
  });
};

const reconcileStaleAnalysisJobs = async () => {
  if (watchdogRunning) return { scanned: 0, requeued: 0, deadLettered: 0 };
  watchdogRunning = true;

  try {
    const now = new Date();
    const staleCutoff = new Date(Date.now() - resolveWatchdogStaleMs());
    const staleJobs = await AiProcessingJob.findAll({
      where: {
        status: 'running',
        [Op.or]: [
          { leased_until: { [Op.lt]: now } },
          { updated_at: { [Op.lt]: staleCutoff } },
        ],
      },
      limit: 100,
      order: [['updated_at', 'ASC']],
    });

    let requeued = 0;
    let deadLettered = 0;
    for (const job of staleJobs) {
      const attempts = Number(job.attempts || 0);
      const maxAttempts = Number(job.max_attempts || 3);
      if (attempts < maxAttempts) {
        await job.update({
          status: 'queued',
          failure_classification: 'transient',
          last_error: 'Lease expired. Requeued by watchdog.',
          next_retry_at: new Date(),
          leased_until: null,
          last_heartbeat_at: null,
          updated_at: new Date(),
        });

        await markImageForRetry(job);
        await emitWatchdogEvent(job, 'analysis.job.stale_requeued', {
          queueJobId: job.queue_job_id || null,
          attempts,
          maxAttempts,
          eventStatus: 'queued',
        });

        await enqueueInspectionAnalysis({
          inspectionId: job.inspection_id,
          submissionId: job.submission_id || null,
          imageId: job.image_id || null,
          tenantId: job.tenant_id || null,
          jobType: job.job_type || 'AI_ANALYSIS',
          requestContext: {
            requestId: `watchdog-${Date.now()}`,
            reprocess: true,
            reprocessToken: `stale-${job.id}`,
          },
        });

        requeued += 1;
      } else {
        const reason = 'Lease expired and retry limit reached';
        await job.update({
          status: 'dead_letter',
          failure_classification: 'permanent',
          dead_letter_reason: reason,
          dead_lettered_at: new Date(),
          leased_until: null,
          last_heartbeat_at: null,
          updated_at: new Date(),
        });
        await markImageDeadLetter(job, reason);
        await emitWatchdogEvent(job, 'analysis.job.stale_dead_lettered', {
          queueJobId: job.queue_job_id || null,
          attempts,
          maxAttempts,
          eventStatus: 'failed',
        });
        deadLettered += 1;
      }
    }

    return {
      scanned: staleJobs.length,
      requeued,
      deadLettered,
    };
  } finally {
    watchdogRunning = false;
  }
};

const startAnalysisJobWatchdog = () => {
  if (watchdogTimer) return;
  const interval = resolveWatchdogIntervalMs();
  watchdogTimer = setInterval(() => {
    reconcileStaleAnalysisJobs().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('analysis watchdog reconcile failed:', error.message);
    });
  }, interval);
  watchdogTimer.unref?.();
};

const stopAnalysisJobWatchdog = () => {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
};

module.exports = {
  reconcileStaleAnalysisJobs,
  startAnalysisJobWatchdog,
  stopAnalysisJobWatchdog,
};
