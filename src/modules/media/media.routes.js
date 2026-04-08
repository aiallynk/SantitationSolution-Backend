const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mediaController = require('./media.controller');
const AppError = require('../../core/errors/AppError');
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
    cb(null, `media-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: Number(process.env.MEDIA_MAX_FILE_SIZE || 8 * 1024 * 1024),
  },
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
        new AppError('Only image uploads are supported', 400, {
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

router.post('/media/upload-init', requirePermissions('inspection.create'), mediaController.postUploadInit);
router.post(
  '/media/upload-complete',
  requirePermissions('inspection.create'),
  upload.single('file'),
  mediaController.postUploadComplete
);
router.get('/media/:id', requirePermissions('dashboard.read'), mediaController.getMediaById);
router.delete('/media/:id', requirePermissions('inspection.review'), mediaController.deleteMedia);

module.exports = router;
