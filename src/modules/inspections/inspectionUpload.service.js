const AppError = require('../../core/errors/AppError');
const {
  sequelize,
  Inspection,
  InspectionMedia,
  ImageSession,
  InspectionEvent,
} = require('../../models');
const {
  isS3Enabled,
  getPresignedPutObjectUrl,
  headObjectFromS3,
  buildObjectUrl,
} = require('../media/s3.service');
const { enqueueInspectionAnalysis } = require('../analysis/analysis.queue');
const { createAuditLog } = require('../audit/audit.service');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { recomputeInspectionAggregates } = require('./inspectionEvidence.service');

const ALLOWED_CAPTURE_STAGE = new Set(['before', 'after', 'evidence']);
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const normalizeContentType = (value) => String(value || '').trim().toLowerCase();

const normalizeHashHex = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-f0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
};

const normalizeEtag = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return normalized.replace(/^"+|"+$/g, '');
};

const isCompatibleContentType = (expected, actual) => {
  const left = normalizeContentType(expected);
  const right = normalizeContentType(actual);
  if (!left || !right) return true;
  if (left === right) return true;
  if ((left === 'image/jpeg' && right === 'image/jpg') || (left === 'image/jpg' && right === 'image/jpeg')) {
    return true;
  }
  return false;
};

const normalizeClientImageId = (value) => {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 120);
  if (!normalized) {
    throw new AppError('clientImageId is required for each image', 400, {
      code: 'VALIDATION_ERROR',
    });
  }
  return normalized;
};

const extensionFromContentType = (contentType) => {
  const normalized = String(contentType || '').toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('heic')) return '.heic';
  if (normalized.includes('heif')) return '.heif';
  return '.jpg';
};

const normalizeCaptureStage = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!ALLOWED_CAPTURE_STAGE.has(normalized)) {
    throw new AppError('captureStage must be one of before|after|evidence', 400, {
      code: 'VALIDATION_ERROR',
    });
  }
  return normalized;
};

const assertInspectionScope = async (req) => {
  const inspection = await Inspection.findByPk(req.params.id);
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return inspection;
};

const emitInspectionEvent = async ({
  inspection,
  req,
  eventType,
  eventStatus = null,
  source = 'api',
  imageId = null,
  toiletId = null,
  payload = {},
}) => {
  await InspectionEvent.create({
    tenant_id: inspection.tenant_id,
    inspection_id: inspection.id,
    toilet_id: toiletId || inspection.toilet_unit_id || null,
    image_id: imageId || null,
    event_type: eventType,
    event_status: eventStatus,
    source,
    actor_user_id: req.user?.id || null,
    payload,
    occurred_at: new Date(),
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    processingStatus: inspection.processing_status,
    pipelineStatus: inspection.pipeline_status,
    eventType,
    eventStatus,
    payload,
  });
};

const buildAnalysisRequestContext = (req) => {
  const safeHeaders = {};
  const userAgent = req?.headers?.['user-agent'];
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  if (userAgent) {
    safeHeaders['user-agent'] = String(userAgent).slice(0, 300);
  }
  if (forwardedFor) {
    safeHeaders['x-forwarded-for'] = String(forwardedFor).slice(0, 200);
  }

  return {
    requestId: req?.requestId || null,
    ip: req?.ip || null,
    user: req?.user
      ? {
          id: req.user.id || null,
          tenantId: req.user.tenantId || null,
          isSuperAdmin: Boolean(req.user.isSuperAdmin),
          roleCodes: Array.isArray(req.user.roleCodes) ? req.user.roleCodes.slice(0, 20) : [],
        }
      : null,
    headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : null,
  };
};

const isAutoAnalysisOnUploadEnabled = () =>
  String(process.env.ANALYSIS_TRIGGER_ON_UPLOAD || 'true').toLowerCase() === 'true';

const isUniqueConstraintError = (error) => {
  const code = String(error?.original?.code || error?.parent?.code || '').trim();
  return error?.name === 'SequelizeUniqueConstraintError' || code === '23505';
};

const createUploadSessions = async (req) => {
  if (!isS3Enabled()) {
    throw new AppError('Direct upload requires S3 configuration in this environment', 409, {
      code: 'DIRECT_UPLOAD_UNAVAILABLE',
    });
  }

  const inspection = await assertInspectionScope(req);
  const images = Array.isArray(req.body.images) ? req.body.images : [];
  if (images.length === 0) {
    throw new AppError('images array is required', 400, { code: 'VALIDATION_ERROR' });
  }
  if (images.length > 40) {
    throw new AppError('images array exceeds batch limit (40)', 400, {
      code: 'VALIDATION_ERROR',
    });
  }

  const sessions = [];
  await sequelize.transaction(async (transaction) => {
    for (const image of images) {
      const clientImageId = normalizeClientImageId(image.clientImageId);

      const captureStage = normalizeCaptureStage(image.captureStage);
      const contentType = String(image.contentType || 'image/jpeg').trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new AppError('contentType is not allowed', 400, {
          code: 'VALIDATION_ERROR',
        });
      }
      const contentLength = Number(image.contentLength || 0);
      const expectedSha256 = String(image.sha256 || '').trim().toLowerCase() || null;
      const extension = extensionFromContentType(contentType);
      const objectKey = `sanitation/${inspection.tenant_id}/inspections/${inspection.id}/${captureStage}/${clientImageId}${extension}`;

      const existingMedia = await InspectionMedia.findOne({
        where: {
          inspection_id: inspection.id,
          client_image_id: clientImageId,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      const mediaUpdatePayload = {
        toilet_unit_id: inspection.toilet_unit_id || null,
        worker_id: inspection.inspector_user_id || req.user?.id || null,
        assignment_id: inspection.assignment_id || null,
        client_image_id: clientImageId,
        capture_stage: captureStage,
        upload_status: 'upload_session_created',
        ai_status: 'PENDING_UPLOAD',
        validation_status: 'PENDING',
        validation_reason: null,
        scoring_rejected: false,
        storage_key: objectKey,
        sha256: expectedSha256,
        ordinal: Number.isFinite(Number(image.ordinal)) ? Number(image.ordinal) : null,
        captured_at: image.capturedAt ? new Date(image.capturedAt) : null,
        gps_lat: image.gpsLat ?? image.gps_lat ?? null,
        gps_lng: image.gpsLng ?? image.gps_lng ?? null,
        device_id: image.deviceId || image.device_id || null,
        watermark_meta:
          image.watermarkMeta && typeof image.watermarkMeta === 'object'
            ? image.watermarkMeta
            : null,
        overall_score: null,
        confidence_score: null,
        floor_score: null,
        commode_score: null,
        stain_score: null,
        garbage_score: null,
        water_score: null,
        issue_tags: null,
        issue_summary: null,
        severity: null,
        model_version: null,
        prompt_version: null,
        scoring_version: null,
        image_quality_status: 'unknown',
        image_quality_score: null,
        toilet_detected: false,
        visibility_score: null,
        perceptual_hash: null,
        similarity_score: null,
        explanation_summary: null,
        ai_processed_at: null,
        ai_error: null,
        updated_at: new Date(),
      };

      let media = existingMedia;
      if (!media) {
        try {
          media = await InspectionMedia.create(
            {
              inspection_id: inspection.id,
              media_type: 'image',
              metadata: {
                source: 'direct-upload-session',
                clientSubmissionId: req.body.clientSubmissionId || null,
              },
              ...mediaUpdatePayload,
            },
            { transaction }
          );
        } catch (error) {
          if (!isUniqueConstraintError(error)) {
            throw error;
          }

          media = await InspectionMedia.findOne({
            where: {
              inspection_id: inspection.id,
              client_image_id: clientImageId,
            },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          if (!media) {
            throw error;
          }
          await media.update(mediaUpdatePayload, { transaction });
        }
      } else {
        await media.update(
          {
            ...mediaUpdatePayload,
            sha256: expectedSha256 || media.sha256,
            ordinal: Number.isFinite(Number(image.ordinal))
              ? Number(image.ordinal)
              : media.ordinal,
            captured_at: image.capturedAt ? new Date(image.capturedAt) : media.captured_at,
            gps_lat:
              image.gpsLat !== undefined || image.gps_lat !== undefined
                ? image.gpsLat ?? image.gps_lat ?? null
                : media.gps_lat,
            gps_lng:
              image.gpsLng !== undefined || image.gps_lng !== undefined
                ? image.gpsLng ?? image.gps_lng ?? null
                : media.gps_lng,
            device_id: image.deviceId || image.device_id || media.device_id,
            watermark_meta:
              image.watermarkMeta && typeof image.watermarkMeta === 'object'
                ? image.watermarkMeta
                : media.watermark_meta,
          },
          { transaction }
        );
      }

      const uploadSession = await getPresignedPutObjectUrl({
        objectKey,
        contentType,
        contentLength:
          Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
        metadata: expectedSha256
          ? {
              sha256: expectedSha256,
            }
          : null,
      });

      const existingSession = await ImageSession.findOne({
        where: {
          inspection_id: inspection.id,
          client_image_id: clientImageId,
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });

      if (existingSession) {
        await existingSession.update(
          {
            tenant_id: inspection.tenant_id,
            media_id: media.id,
            client_submission_id:
              req.body.clientSubmissionId || existingSession.client_submission_id,
            capture_stage: captureStage,
            ordinal: Number.isFinite(Number(image.ordinal))
              ? Number(image.ordinal)
              : existingSession.ordinal,
            object_key: objectKey,
            upload_method: 'PUT',
            content_type: contentType,
            expected_size:
              Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
            expected_sha256: expectedSha256,
            status: 'created',
            upload_url_expires_at: new Date(uploadSession.expiresAt),
            metadata: {
              ...(existingSession.metadata || {}),
              watermarkMeta: image.watermarkMeta || null,
            },
            updated_at: new Date(),
          },
          { transaction }
        );
      } else {
        await ImageSession.create(
          {
            tenant_id: inspection.tenant_id,
            inspection_id: inspection.id,
            media_id: media.id,
            client_submission_id: req.body.clientSubmissionId || null,
            client_image_id: clientImageId,
            capture_stage: captureStage,
            ordinal: Number.isFinite(Number(image.ordinal)) ? Number(image.ordinal) : null,
            object_key: objectKey,
            upload_method: 'PUT',
            content_type: contentType,
            expected_size:
              Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
            expected_sha256: expectedSha256,
            status: 'created',
            upload_url_expires_at: new Date(uploadSession.expiresAt),
            metadata: {
              watermarkMeta: image.watermarkMeta || null,
            },
          },
          { transaction }
        );
      }

      sessions.push({
        mediaId: media.id,
        clientImageId,
        uploadUrl: uploadSession.uploadUrl,
        method: 'PUT',
        headers: uploadSession.headers,
        objectKey,
        expiresAt: uploadSession.expiresAt,
      });
    }

    await inspection.update(
      {
        pipeline_status: 'pending_upload',
        status: 'IN_PROGRESS',
        updated_at: new Date(),
      },
      { transaction }
    );
  });

  await recomputeInspectionAggregates(inspection.id, { updateToilet: false });

  await emitInspectionEvent({
    inspection,
    req,
    eventType: 'inspection.media.upload_session_created',
    eventStatus: 'pending_upload',
    payload: { count: sessions.length },
  });

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.media_upload_session.create',
    entityType: 'inspection',
    entityId: inspection.id,
    details: {
      count: sessions.length,
      clientSubmissionId: req.body.clientSubmissionId || null,
    },
  });

  return {
    inspectionId: inspection.id,
    sessions,
  };
};

const confirmUpload = async (req) => {
  const inspection = await assertInspectionScope(req);
  const media = await InspectionMedia.findOne({
    where: {
      id: req.params.mediaId,
      inspection_id: inspection.id,
    },
  });
  if (!media) {
    throw new AppError('Inspection media not found', 404, { code: 'MEDIA_NOT_FOUND' });
  }

  const clientImageId = String(req.body.clientImageId || media.client_image_id || '').trim();
  if (clientImageId && media.client_image_id && clientImageId !== media.client_image_id) {
    throw new AppError('clientImageId does not match media', 400, {
      code: 'VALIDATION_ERROR',
    });
  }

  const session = await ImageSession.findOne({
    where: {
      inspection_id: inspection.id,
      media_id: media.id,
    },
    order: [['updated_at', 'DESC']],
  });

  const objectKey = String(session?.object_key || media.storage_key || '').trim();
  if (!objectKey) {
    throw new AppError('Upload session object key missing', 409, { code: 'UPLOAD_SESSION_INVALID' });
  }
  if (session?.object_key && media.storage_key && session.object_key !== media.storage_key) {
    throw new AppError('Upload object key mismatch', 409, { code: 'UPLOAD_SESSION_INVALID' });
  }

  const head = await headObjectFromS3(objectKey);
  if (!head) {
    throw new AppError('Uploaded object not found in storage', 404, {
      code: 'OBJECT_NOT_FOUND',
    });
  }

  const expectedSize = Number(session?.expected_size || 0);
  const observedSize = Number(head.contentLength || 0);
  const requestSize = Number(req.body.contentLength || 0);
  if (expectedSize > 0 && observedSize > 0 && expectedSize !== observedSize) {
    throw new AppError('Uploaded object size mismatch', 409, {
      code: 'UPLOAD_SIZE_MISMATCH',
      details: { expectedSize, observedSize },
    });
  }
  if (requestSize > 0 && observedSize > 0 && requestSize !== observedSize) {
    throw new AppError('Upload confirm contentLength mismatch', 409, {
      code: 'UPLOAD_SIZE_MISMATCH',
      details: { requestSize, observedSize },
    });
  }

  const expectedHash =
    normalizeHashHex(session?.expected_sha256) || normalizeHashHex(media.sha256);
  const observedHash =
    normalizeHashHex(head?.metadata?.sha256) || normalizeHashHex(req.body.sha256);
  if (expectedHash && observedHash && expectedHash !== observedHash) {
    throw new AppError('Uploaded object hash mismatch', 409, {
      code: 'UPLOAD_HASH_MISMATCH',
    });
  }
  if (expectedHash && !observedHash) {
    throw new AppError('Uploaded object hash metadata missing', 409, {
      code: 'UPLOAD_HASH_MISSING',
    });
  }

  const expectedContentType = normalizeContentType(session?.content_type);
  const observedContentType = normalizeContentType(head.contentType || req.body.contentType);
  if (
    expectedContentType &&
    observedContentType &&
    !isCompatibleContentType(expectedContentType, observedContentType)
  ) {
    throw new AppError('Uploaded object contentType mismatch', 409, {
      code: 'UPLOAD_CONTENT_TYPE_MISMATCH',
      details: { expectedContentType, observedContentType },
    });
  }

  const now = new Date();
  const resolvedEtag = normalizeEtag(head.eTag) || normalizeEtag(req.body.etag) || media.etag;
  const resolvedSha256 = observedHash || expectedHash || normalizeHashHex(media.sha256);
  const resolvedContentLength =
    observedSize > 0
      ? observedSize
      : Number.isFinite(Number(media.content_length)) && Number(media.content_length) > 0
        ? Number(media.content_length)
        : null;
  await media.update({
    upload_status: 'confirmed',
    ai_status: 'UPLOADED',
    validation_status: 'PENDING',
    validation_reason: null,
    scoring_rejected: false,
    file_url: head.fileUrl || buildObjectUrl(objectKey),
    thumbnail_url: head.fileUrl || buildObjectUrl(objectKey),
    storage_key: objectKey,
    toilet_unit_id: inspection.toilet_unit_id || media.toilet_unit_id,
    worker_id: inspection.inspector_user_id || req.user?.id || media.worker_id,
    assignment_id: inspection.assignment_id || media.assignment_id,
    etag: resolvedEtag,
    sha256: resolvedSha256,
    content_length: resolvedContentLength,
    width: Number.isFinite(Number(req.body.width)) ? Number(req.body.width) : media.width,
    height: Number.isFinite(Number(req.body.height)) ? Number(req.body.height) : media.height,
    upload_duration_ms: Number.isFinite(Number(req.body.uploadDurationMs))
      ? Number(req.body.uploadDurationMs)
      : media.upload_duration_ms,
    overall_score: null,
    confidence_score: null,
    floor_score: null,
    commode_score: null,
    stain_score: null,
    garbage_score: null,
    water_score: null,
    issue_tags: null,
    issue_summary: null,
    severity: null,
    model_version: null,
    prompt_version: null,
    scoring_version: null,
    image_quality_status: 'unknown',
    image_quality_score: null,
    toilet_detected: false,
    visibility_score: null,
    perceptual_hash: null,
    similarity_score: null,
    explanation_summary: null,
    ai_processed_at: null,
    ai_error: null,
    uploaded_at: now,
    confirmed_at: now,
    updated_at: now,
  });

  if (session) {
    await session.update({
      status: 'confirmed',
      expected_size: expectedSize > 0 ? expectedSize : session.expected_size,
      expected_sha256: expectedHash || session.expected_sha256,
      uploaded_at: now,
      confirmed_at: now,
      updated_at: now,
    });
  }

  await inspection.update({
    pipeline_status: 'uploaded',
    status: 'IN_PROGRESS',
    updated_at: now,
  });

  await emitInspectionEvent({
    inspection,
    req,
    eventType: 'inspection.media.upload_confirmed',
    eventStatus: 'uploaded',
    imageId: media.id,
    payload: {
      mediaId: media.id,
      clientImageId: clientImageId || null,
    },
  });

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.media_upload.confirm',
    entityType: 'inspection_media',
    entityId: media.id,
    details: { inspectionId: inspection.id },
  });

  let analysisQueue = null;
  if (isAutoAnalysisOnUploadEnabled()) {
    await media.update({
      ai_status: 'AI_QUEUED',
      ai_error: null,
      updated_at: new Date(),
    });

    await inspection.update({
      processing_status: 'queued',
      pipeline_status: 'queued_for_ai',
      status: inspection.submitted_at ? 'SUBMITTED' : 'IN_PROGRESS',
      updated_at: new Date(),
    });

    analysisQueue = await enqueueInspectionAnalysis({
      inspectionId: inspection.id,
      imageId: media.id,
      tenantId: inspection.tenant_id,
      requestContext: buildAnalysisRequestContext(req),
    });

    await emitInspectionEvent({
      inspection,
      req,
      eventType: 'inspection.media.analysis_queued',
      eventStatus: 'queued_for_ai',
      imageId: media.id,
      payload: {
        mediaId: media.id,
        queueJobId: analysisQueue?.queueJobId || null,
        queued: Boolean(analysisQueue?.queued),
        type: analysisQueue?.type || 'AI_ANALYSIS',
      },
    });
  }

  await recomputeInspectionAggregates(inspection.id, { updateToilet: false });

  return {
    mediaId: media.id,
    uploadStatus: 'confirmed',
    aiStatus: isAutoAnalysisOnUploadEnabled() ? 'AI_QUEUED' : 'UPLOADED',
    fileUrl: media.file_url,
    thumbnailUrl: media.thumbnail_url || media.file_url,
    analysisQueue,
  };
};

const retryUploadSession = async (req) => {
  if (!isS3Enabled()) {
    throw new AppError('Direct upload requires S3 configuration in this environment', 409, {
      code: 'DIRECT_UPLOAD_UNAVAILABLE',
    });
  }

  const inspection = await assertInspectionScope(req);
  const media = await InspectionMedia.findOne({
    where: {
      id: req.params.mediaId,
      inspection_id: inspection.id,
    },
  });
  if (!media) {
    throw new AppError('Inspection media not found', 404, { code: 'MEDIA_NOT_FOUND' });
  }

  const objectKey =
    String(media.storage_key || '').trim() ||
    `sanitation/${inspection.tenant_id}/inspections/${inspection.id}/${media.capture_stage || 'evidence'}/${normalizeClientImageId(media.client_image_id || media.id)}.jpg`;
  const session = await ImageSession.findOne({
    where: {
      inspection_id: inspection.id,
      media_id: media.id,
    },
    order: [['updated_at', 'DESC']],
  });

  const contentType = normalizeContentType(
    req.body.contentType || session?.content_type || 'image/jpeg'
  );
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new AppError('contentType is not allowed', 400, {
      code: 'VALIDATION_ERROR',
    });
  }
  const contentLength = Number(
    req.body.contentLength || session?.expected_size || media.content_length || 0
  );
  const expectedSha256 =
    normalizeHashHex(req.body.sha256) ||
    normalizeHashHex(session?.expected_sha256) ||
    normalizeHashHex(media.sha256);
  const uploadSession = await getPresignedPutObjectUrl({
    objectKey,
    contentType,
    contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
    metadata: expectedSha256
      ? {
          sha256: expectedSha256,
        }
      : null,
  });

  await media.update({
    storage_key: objectKey,
    upload_status: 'upload_session_created',
    ai_status: 'PENDING_UPLOAD',
    sha256: expectedSha256 || media.sha256,
    updated_at: new Date(),
  });

  if (session) {
    await session.update({
      object_key: objectKey,
      status: 'created',
      content_type: contentType,
      expected_size: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
      expected_sha256: expectedSha256 || session.expected_sha256,
      upload_url_expires_at: new Date(uploadSession.expiresAt),
      updated_at: new Date(),
    });
  } else {
    await ImageSession.create({
      tenant_id: inspection.tenant_id,
      inspection_id: inspection.id,
      media_id: media.id,
      client_submission_id: null,
      client_image_id: media.client_image_id || media.id,
      capture_stage: media.capture_stage || 'evidence',
      ordinal: media.ordinal || null,
      object_key: objectKey,
      upload_method: 'PUT',
      content_type: contentType,
      expected_size: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
      expected_sha256: expectedSha256,
      status: 'created',
      upload_url_expires_at: new Date(uploadSession.expiresAt),
      metadata: null,
    });
  }

  await emitInspectionEvent({
    inspection,
    req,
    eventType: 'inspection.media.upload_retry_issued',
    eventStatus: 'pending_upload',
    imageId: media.id,
    payload: {
      mediaId: media.id,
    },
  });

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.media_upload.retry',
    entityType: 'inspection_media',
    entityId: media.id,
    details: { inspectionId: inspection.id },
  });

  return {
    mediaId: media.id,
    uploadUrl: uploadSession.uploadUrl,
    method: 'PUT',
    headers: uploadSession.headers,
    objectKey,
    expiresAt: uploadSession.expiresAt,
  };
};

module.exports = {
  createUploadSessions,
  confirmUpload,
  retryUploadSession,
};
