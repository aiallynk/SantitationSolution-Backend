const AppError = require('../../core/errors/AppError');
const { InspectionMedia } = require('../../models');
const { uploadImage, removeTempFile } = require('./storage.service');
const { createAuditLog } = require('../audit/audit.service');

const uploadInit = async (req) => {
  const media = await InspectionMedia.create({
    inspection_id: req.body.inspectionId || null,
    media_type: req.body.mediaType || 'image',
    capture_stage: req.body.captureStage || 'evidence',
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

  return {
    id: media.id,
    fileUrl: media.file_url,
    storageKey: media.storage_key,
    uploadedAt: media.uploaded_at,
    metadata: media.metadata,
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
    mediaType: media.media_type,
    captureStage: media.capture_stage,
    fileUrl: media.file_url,
    storageKey: media.storage_key,
    thumbnailUrl: media.thumbnail_url,
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
