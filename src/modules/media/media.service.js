const AppError = require('../../core/errors/AppError');
const { Inspection, InspectionMedia } = require('../../models');
const { uploadImage, removeTempFile } = require('./storage.service');
const { enqueueInspectionAnalysis } = require('../analysis/analysis.queue');
const { createAuditLog } = require('../audit/audit.service');
const { recomputeInspectionAggregates } = require('../inspections/inspectionEvidence.service');

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

const uploadInit = async (req) => {
  const inspection = req.body.inspectionId
    ? await Inspection.findByPk(req.body.inspectionId)
    : null;
  if (req.body.inspectionId && !inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }

  const media = await InspectionMedia.create({
    inspection_id: req.body.inspectionId || null,
    toilet_unit_id: inspection?.toilet_unit_id || null,
    worker_id: inspection?.inspector_user_id || req.user.id,
    assignment_id: inspection?.assignment_id || null,
    media_type: req.body.mediaType || 'image',
    capture_stage: req.body.captureStage || 'evidence',
    upload_status: 'upload_session_created',
    ai_status: 'PENDING_UPLOAD',
    gps_lat: req.body.gpsLat ?? req.body.gps_lat ?? null,
    gps_lng: req.body.gpsLng ?? req.body.gps_lng ?? null,
    device_id: req.body.deviceId || req.body.device_id || null,
    metadata: {
      originalFileName: req.body.fileName || null,
      mimeType: req.body.mimeType || null,
      fileSize: req.body.fileSize || null,
      source: 'upload-init',
    },
  });

  await createAuditLog({
    req,
    action: 'media.upload_init',
    entityType: 'inspection_media',
    entityId: media.id,
    tenantId: req.user.tenantId,
  });

  return {
    mediaId: media.id,
    uploadEndpoint: `/api/v1/media/upload-complete?mediaId=${media.id}`,
    maxFileSizeBytes: Number(process.env.MEDIA_MAX_FILE_SIZE || 8 * 1024 * 1024),
  };
};

const uploadComplete = async (req) => {
  if (!req.file?.path) {
    throw new AppError('file is required for upload-complete', 400, {
      code: 'FILE_REQUIRED',
    });
  }
  const mediaId = req.query.mediaId || req.body.mediaId;
  if (!mediaId) {
    await removeTempFile(req.file.path);
    throw new AppError('mediaId is required', 400, { code: 'MEDIA_ID_REQUIRED' });
  }

  const media = await InspectionMedia.findByPk(mediaId);
  if (!media) {
    await removeTempFile(req.file.path);
    throw new AppError('Media record not found', 404, { code: 'MEDIA_NOT_FOUND' });
  }

  const targetFolder = `sanitation/${req.user.tenantId || 'global'}/inspections`;

  try {
    const uploaded = await uploadImage(req.file.path, targetFolder);
    await media.update({
      file_url: uploaded.fileUrl,
      storage_key: uploaded.storageKey,
      upload_status: 'confirmed',
      ai_status: isAutoAnalysisOnUploadEnabled() ? 'AI_QUEUED' : 'UPLOADED',
      metadata: {
        ...(media.metadata || {}),
        ...(uploaded.metadata || {}),
      },
      uploaded_at: new Date(),
      updated_at: new Date(),
    });
  } finally {
    await removeTempFile(req.file.path);
  }

  await createAuditLog({
    req,
    action: 'media.upload_complete',
    entityType: 'inspection_media',
    entityId: media.id,
    tenantId: req.user.tenantId,
  });

  let analysisQueue = null;
  if (isAutoAnalysisOnUploadEnabled() && media.inspection_id) {
    const inspection = await Inspection.findByPk(media.inspection_id);
    if (inspection) {
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
    }
  }

  if (media.inspection_id) {
    await recomputeInspectionAggregates(media.inspection_id, { updateToilet: false });
  }

  return {
    id: media.id,
    fileUrl: media.file_url,
    storageKey: media.storage_key,
    uploadedAt: media.uploaded_at,
    metadata: media.metadata,
    aiStatus: media.ai_status,
    analysisQueue,
  };
};

const getMediaById = async (req) => {
  const media = await InspectionMedia.findByPk(req.params.id);
  if (!media) {
    throw new AppError('Media not found', 404, { code: 'MEDIA_NOT_FOUND' });
  }
  return {
    id: media.id,
    inspectionId: media.inspection_id,
    toiletId: media.toilet_unit_id,
    mediaType: media.media_type,
    captureStage: media.capture_stage,
    fileUrl: media.file_url,
    storageKey: media.storage_key,
    thumbnailUrl: media.thumbnail_url,
    uploadStatus: media.upload_status,
    aiStatus: media.ai_status,
    imageQualityStatus: media.image_quality_status,
    score: media.overall_score !== null && media.overall_score !== undefined ? Number(media.overall_score) : null,
    confidenceScore:
      media.confidence_score !== null && media.confidence_score !== undefined
        ? Number(media.confidence_score)
        : null,
    issueTags: Array.isArray(media.issue_tags) ? media.issue_tags : [],
    reviewRequired: Boolean(media.review_required),
    metadata: media.metadata,
    uploadedAt: media.uploaded_at,
  };
};

const deleteMedia = async (req) => {
  const media = await InspectionMedia.findByPk(req.params.id);
  if (!media) {
    throw new AppError('Media not found', 404, { code: 'MEDIA_NOT_FOUND' });
  }
  await media.destroy();
  await createAuditLog({
    req,
    action: 'media.delete',
    entityType: 'inspection_media',
    entityId: req.params.id,
    tenantId: req.user.tenantId,
  });
  return { deleted: true };
};

module.exports = {
  uploadInit,
  uploadComplete,
  getMediaById,
  deleteMedia,
};
