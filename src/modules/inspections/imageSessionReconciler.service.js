const { Op } = require('sequelize');
const {
  ImageSession,
  InspectionMedia,
  Inspection,
  InspectionEvent,
} = require('../../models');
const {
  headObjectFromS3,
  getPresignedPutObjectUrl,
  buildObjectUrl,
} = require('../media/s3.service');
const { enqueueInspectionAnalysis } = require('../analysis/analysis.queue');
const { IMAGE_PROCESSING_STATES } = require('./imageLifecycle.constants');

const DEFAULT_RECONCILE_INTERVAL_MS = 45 * 1000;
const DEFAULT_RECONCILE_BATCH_SIZE = 100;
const DEFAULT_MAX_RECONCILE_ATTEMPTS = 5;
const DEFAULT_SESSION_STALE_MS = 90 * 1000;

let reconcileTimer = null;
let reconcileRunning = false;

const isAutoAnalysisOnUploadEnabled = () =>
  String(process.env.ANALYSIS_TRIGGER_ON_UPLOAD || 'true').toLowerCase() === 'true';

const resolveReconcileIntervalMs = () => {
  const value = Number(process.env.IMAGE_SESSION_RECONCILE_INTERVAL_MS || DEFAULT_RECONCILE_INTERVAL_MS);
  if (Number.isFinite(value) && value >= 10000) return value;
  return DEFAULT_RECONCILE_INTERVAL_MS;
};

const resolveReconcileBatchSize = () => {
  const value = Number(process.env.IMAGE_SESSION_RECONCILE_BATCH_SIZE || DEFAULT_RECONCILE_BATCH_SIZE);
  if (Number.isFinite(value) && value >= 1) return Math.min(value, 500);
  return DEFAULT_RECONCILE_BATCH_SIZE;
};

const resolveSessionStaleMs = () => {
  const value = Number(process.env.IMAGE_SESSION_STALE_MS || DEFAULT_SESSION_STALE_MS);
  if (Number.isFinite(value) && value >= 30000) return value;
  return DEFAULT_SESSION_STALE_MS;
};

const resolveMaxAttempts = () => {
  const value = Number(process.env.IMAGE_SESSION_RECONCILE_MAX_ATTEMPTS || DEFAULT_MAX_RECONCILE_ATTEMPTS);
  if (Number.isFinite(value) && value > 0) return Math.min(value, 20);
  return DEFAULT_MAX_RECONCILE_ATTEMPTS;
};

const emitReconcileEvent = async ({
  inspection,
  media,
  eventType,
  eventStatus,
  payload = {},
}) => {
  await InspectionEvent.create({
    tenant_id: inspection?.tenant_id || null,
    inspection_id: inspection?.id || media?.inspection_id,
    toilet_id: media?.toilet_unit_id || inspection?.toilet_unit_id || null,
    image_id: media?.id || null,
    event_type: eventType,
    event_status: eventStatus || null,
    source: 'reconciler',
    actor_user_id: null,
    payload,
    occurred_at: new Date(),
  });
};

const markPermanentUploadFailure = async ({
  session,
  media,
  inspection,
  reason,
}) => {
  const now = new Date();
  if (media) {
    await media.update({
      upload_status: 'failed_permanent',
      processing_state: IMAGE_PROCESSING_STATES.UPLOAD_FAILED_PERMANENT,
      ai_status: 'PENDING_UPLOAD',
      review_required: true,
      manual_review_required_at: now,
      last_error_code: 'UPLOAD_SESSION_STALE',
      last_error_message: String(reason || 'Upload session stale and unrecoverable').slice(0, 2000),
      ai_error: String(reason || 'Upload session stale and unrecoverable').slice(0, 2000),
      next_retry_at: null,
      updated_at: now,
    });
  }

  await session.update({
    status: 'failed',
    reconcile_attempts: Number(session.reconcile_attempts || 0) + 1,
    reconciled_at: now,
    last_reconcile_error: String(reason || 'Upload session stale and unrecoverable').slice(0, 1000),
    updated_at: now,
  });

  await emitReconcileEvent({
    inspection,
    media,
    eventType: 'inspection.media.reconcile_failed_permanent',
    eventStatus: 'failed',
    payload: {
      imageSessionId: session.id,
      reason: String(reason || 'Upload session stale and unrecoverable').slice(0, 300),
    },
  });
};

const reconcileSingleSession = async (session) => {
  const now = new Date();
  const maxAttempts = resolveMaxAttempts();
  const media = session.media_id ? await InspectionMedia.findByPk(session.media_id) : null;
  const inspection = await Inspection.findByPk(session.inspection_id);

  const objectKey = String(session.object_key || media?.storage_key || '').trim();
  if (!objectKey) {
    await markPermanentUploadFailure({
      session,
      media,
      inspection,
      reason: 'Missing object key for stale upload session',
    });
    return { recovered: false, failed: true };
  }

  const head = await headObjectFromS3(objectKey);
  if (head && Number(head.contentLength || 0) > 0) {
    const contentType = head.contentType || session.content_type || 'image/jpeg';
    const resolvedSha =
      String(head.metadata?.sha256 || session.expected_sha256 || media?.sha256 || '').trim().toLowerCase() ||
      null;

    if (media) {
      await media.update({
        upload_status: 'confirmed',
        processing_state: IMAGE_PROCESSING_STATES.STORAGE_VERIFIED,
        ai_status: isAutoAnalysisOnUploadEnabled() ? 'AI_QUEUED' : 'UPLOADED',
        file_url: head.fileUrl || buildObjectUrl(objectKey),
        thumbnail_url: head.fileUrl || buildObjectUrl(objectKey),
        storage_key: objectKey,
        content_length: Number(head.contentLength || media.content_length || 0) || null,
        etag: head.eTag || media.etag || null,
        sha256: resolvedSha,
        uploaded_at: media.uploaded_at || now,
        confirmed_at: now,
        storage_verified_at: now,
        last_error_code: null,
        last_error_message: null,
        next_retry_at: null,
        updated_at: now,
      });
    }

    await session.update({
      status: 'confirmed',
      uploaded_at: session.uploaded_at || now,
      confirmed_at: now,
      reconciled_at: now,
      last_reconcile_error: null,
      updated_at: now,
    });

    if (inspection) {
      await inspection.update({
        pipeline_status: isAutoAnalysisOnUploadEnabled() ? 'queued_for_ai' : 'uploaded',
        processing_status: isAutoAnalysisOnUploadEnabled() ? 'queued' : inspection.processing_status,
        status: inspection.submitted_at ? 'SUBMITTED' : inspection.status || 'IN_PROGRESS',
        updated_at: now,
      });
    }

    await emitReconcileEvent({
      inspection,
      media,
      eventType: 'inspection.media.auto_confirmed_from_storage',
      eventStatus: 'uploaded',
      payload: {
        imageSessionId: session.id,
        objectKey,
      },
    });

    if (inspection && media && isAutoAnalysisOnUploadEnabled()) {
      await enqueueInspectionAnalysis({
        inspectionId: inspection.id,
        imageId: media.id,
        tenantId: inspection.tenant_id,
        requestContext: {
          requestId: `image-reconcile-${Date.now()}`,
          reprocess: true,
          reprocessToken: `media-${media.id}`,
        },
      });
    }

    return { recovered: true, failed: false };
  }

  const nextAttempts = Number(session.reconcile_attempts || 0) + 1;
  if (nextAttempts >= maxAttempts) {
    await markPermanentUploadFailure({
      session,
      media,
      inspection,
      reason: 'Object not found in storage after max reconciliation attempts',
    });
    return { recovered: false, failed: true };
  }

  const refreshedSession = await getPresignedPutObjectUrl({
    objectKey,
    contentType: session.content_type || 'image/jpeg',
    contentLength: Number(session.expected_size || 0) > 0 ? Number(session.expected_size) : null,
    metadata: session.expected_sha256
      ? {
          sha256: session.expected_sha256,
        }
      : null,
  });

  await session.update({
    status: 'created',
    upload_url_expires_at: new Date(refreshedSession.expiresAt),
    reconcile_attempts: nextAttempts,
    reconciled_at: now,
    last_reconcile_error: 'Object not found. Presigned URL reissued by reconciler.',
    updated_at: now,
  });

  if (media) {
    await media.update({
      upload_status: 'upload_session_created',
      processing_state: IMAGE_PROCESSING_STATES.QUEUED_FOR_UPLOAD,
      retry_count: nextAttempts,
      last_retry_at: now,
      next_retry_at: new Date(Date.now() + 30000),
      last_error_code: 'OBJECT_NOT_FOUND',
      last_error_message: 'Storage object missing. Upload session was reissued.',
      updated_at: now,
    });
  }

  await emitReconcileEvent({
    inspection,
    media,
    eventType: 'inspection.media.upload_session_reissued',
    eventStatus: 'pending_upload',
    payload: {
      imageSessionId: session.id,
      mediaId: media?.id || null,
      attempt: nextAttempts,
    },
  });

  return { recovered: false, failed: false };
};

const reconcileStaleImageSessions = async () => {
  if (reconcileRunning) {
    return { scanned: 0, recovered: 0, failed: 0 };
  }
  reconcileRunning = true;
  try {
    const staleCutoff = new Date(Date.now() - resolveSessionStaleMs());
    const now = new Date();
    const rows = await ImageSession.findAll({
      where: {
        status: 'created',
        [Op.or]: [
          { upload_url_expires_at: { [Op.lt]: now } },
          { updated_at: { [Op.lt]: staleCutoff } },
        ],
      },
      order: [['updated_at', 'ASC']],
      limit: resolveReconcileBatchSize(),
    });

    let recovered = 0;
    let failed = 0;
    for (const row of rows) {
      const result = await reconcileSingleSession(row);
      if (result.recovered) recovered += 1;
      if (result.failed) failed += 1;
    }

    return { scanned: rows.length, recovered, failed };
  } finally {
    reconcileRunning = false;
  }
};

const startImageSessionReconciler = () => {
  if (reconcileTimer) return;
  const interval = resolveReconcileIntervalMs();
  reconcileTimer = setInterval(() => {
    reconcileStaleImageSessions().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('image session reconciliation failed:', error.message);
    });
  }, interval);
  reconcileTimer.unref?.();
};

const stopImageSessionReconciler = () => {
  if (!reconcileTimer) return;
  clearInterval(reconcileTimer);
  reconcileTimer = null;
};

module.exports = {
  reconcileStaleImageSessions,
  startImageSessionReconciler,
  stopImageSessionReconciler,
};
