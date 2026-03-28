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
  validateSubmitInspection,
  validateReviewInspection,
} = require('./inspection.validator');
const { protect, requirePermissions } = require('../../core/middleware/auth');

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
router.get('/inspections', requirePermissions('inspection.review'), validate(validateInspectionListQuery), inspectionController.getAllInspections);
router.get('/inspections/my', requirePermissions('inspection.create'), validate(validateInspectionListQuery), inspectionController.getMyInspections);
router.get('/inspections/:id/trend', requirePermissions('dashboard.read'), inspectionController.getInspectionTrend);
router.get('/inspections/:id', requirePermissions('dashboard.read'), inspectionController.getInspectionById);
router.post(
  '/inspections/:id/media',
  requirePermissions('inspection.create'),
  upload.single('file'),
  inspectionController.postInspectionMedia
);
router.post('/inspections/:id/submit', requirePermissions('inspection.create'), validate(validateSubmitInspection), inspectionController.postSubmitInspection);
router.patch(
  '/inspections/:id/review',
  requirePermissions('inspection.review'),
  validate(validateReviewInspection),
  inspectionController.patchReviewInspection
);

module.exports = router;
