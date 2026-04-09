const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const inspectionController = require('./inspection.controller');
const AppError = require('../../core/errors/AppError');
const { validate } = require('../../core/middleware/validate');
const {
  validateCreateInspection,
  validateInspectionListQuery,
  validateCreateMediaUploadSession,
  validateConfirmMediaUpload,
  validateRetryMediaUpload,
  validateInspectionImageUploadSession,
  validateInspectionImageConfirmUpload,
  validateSubmitInspection,
  validateReviewInspection,
} = require('./inspection.validator');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { withIdempotency } = require('../../core/idempotency/idempotency.middleware');
const { ingestionRateLimit } = require('../../core/security/rateLimit');

const router = express.Router();

const tempDir = path.join(process.cwd(), 'uploads', 'temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, tempDir),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || '');
    cb(null, `inspection-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MEDIA_MAX_FILE_SIZE || 8 * 1024 * 1024) },
  fileFilter: (req, file, cb) => {
    const mimetype = String(file.mimetype || '').toLowerCase();
    const originalName = String(file.originalname || '');
    const extension = path.extname(originalName).toLowerCase();
    const allowedExtensions = new Set([
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
      '.bmp',
      '.heic',
      '.heif',
    ]);
    const isImageMime = mimetype.startsWith('image/');
    const canTrustExtension =
      (mimetype === '' || mimetype === 'application/octet-stream') &&
      allowedExtensions.has(extension);

    if (!isImageMime && !canTrustExtension) {
      return cb(
        new AppError('Only image files are allowed', 400, {
          code: 'INVALID_MEDIA_TYPE',
          details: {
            mimetype: mimetype || null,
            originalName,
            extension: extension || null,
          },
        })
      );
    }
    return cb(null, true);
  },
});

router.use(protect);

router.post('/inspections', requirePermissions('inspection.create'), validate(validateCreateInspection), inspectionController.postInspection);
router.post(
  '/inspections/start',
  requirePermissions('inspection.create'),
  validate(validateCreateInspection),
  inspectionController.postInspectionStart
);
router.get('/inspections', requirePermissions('inspection.review'), validate(validateInspectionListQuery), inspectionController.getAllInspections);
router.get('/inspections/my', requirePermissions('inspection.create'), validate(validateInspectionListQuery), inspectionController.getMyInspections);
router.get('/toilets/:toiletId/inspections', requirePermissions('dashboard.read'), inspectionController.getToiletInspections);
router.get('/toilets/:id/details', requirePermissions('dashboard.read'), inspectionController.getToiletDetails);
router.get('/toilets/:id/latest-inspection', requirePermissions('dashboard.read'), inspectionController.getToiletLatestInspection);
router.get('/toilets/:id/score-trends', requirePermissions('dashboard.read'), inspectionController.getToiletScoreTrends);
router.get('/toilets/:id/inspection-history', requirePermissions('dashboard.read'), inspectionController.getToiletInspectionHistory);
router.get('/inspections/:id/images', requirePermissions('inspection.create'), inspectionController.getInspectionImages);
router.get('/inspections/:id/image-jobs', requirePermissions('inspection.create'), inspectionController.getInspectionImageJobs);
router.get('/inspections/:id/comparison', requirePermissions('dashboard.read'), inspectionController.getInspectionComparison);
router.get('/inspections/:id/trend', requirePermissions('dashboard.read'), inspectionController.getInspectionTrend);
router.get('/inspection-images/:imageId', requirePermissions('inspection.create'), inspectionController.getInspectionImageById);
router.post('/inspection-images/:imageId/trigger-ai', requirePermissions('inspection.create'), inspectionController.postInspectionImageTriggerAi);
router.post(
  '/inspection-images/upload-session',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.image.upload_session.create', {
    ttlMs: Number(process.env.S3_PRESIGNED_URL_TTL_SEC || 900) * 1000,
  }),
  validate(validateInspectionImageUploadSession),
  inspectionController.postInspectionImageUploadSession
);
router.post(
  '/inspection-images/confirm-upload',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.image.confirm_upload', {
    ttlMs: 30 * 60 * 1000,
  }),
  validate(validateInspectionImageConfirmUpload),
  inspectionController.postInspectionImageConfirmUpload
);
router.get('/inspections/:id', requirePermissions('dashboard.read'), inspectionController.getInspectionById);
router.post(
  '/inspections/:id/media/sessions',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.media.session.create', {
    ttlMs: Number(process.env.S3_PRESIGNED_URL_TTL_SEC || 900) * 1000,
  }),
  validate(validateCreateMediaUploadSession),
  inspectionController.postInspectionMediaUploadSessions
);
router.post(
  '/inspections/:id/media/:mediaId/confirm',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.media.confirm', {
    ttlMs: 30 * 60 * 1000,
  }),
  validate(validateConfirmMediaUpload),
  inspectionController.postInspectionMediaConfirm
);
router.post(
  '/inspections/:id/media/:mediaId/retry',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.media.retry', {
    ttlMs: 15 * 60 * 1000,
  }),
  validate(validateRetryMediaUpload),
  inspectionController.postInspectionMediaRetry
);
router.post(
  '/inspections/:id/media',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  upload.single('file'),
  inspectionController.postInspectionMedia
);
router.post(
  '/inspections/:id/submit',
  requirePermissions('inspection.create'),
  withIdempotency('inspection.submit', {
    ttlMs: 24 * 60 * 60 * 1000,
  }),
  validate(validateSubmitInspection),
  inspectionController.postSubmitInspection
);
router.patch(
  '/inspections/:id/review',
  requirePermissions('inspection.review'),
  validate(validateReviewInspection),
  inspectionController.patchReviewInspection
);

module.exports = router;
