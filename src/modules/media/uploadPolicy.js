const fs = require('fs');
const path = require('path');
const multer = require('multer');
const AppError = require('../../core/errors/AppError');
const { runtimeConfig } = require('../../config/runtime');

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.heic',
  '.heif',
]);

const MEDIA_MAX_FILE_SIZE = runtimeConfig.media.maxFileSizeBytes;

const normalizeContentType = (value) => String(value || '').trim().toLowerCase();

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
};

const isAllowedImageFile = ({ mimetype, originalName }) => {
  const normalizedMime = normalizeContentType(mimetype);
  const extension = path.extname(String(originalName || '')).toLowerCase();
  const isImageMime = normalizedMime.startsWith('image/');
  const canTrustExtension =
    (normalizedMime === '' || normalizedMime === 'application/octet-stream') &&
    ALLOWED_IMAGE_EXTENSIONS.has(extension);

  return {
    allowed: isImageMime || canTrustExtension,
    normalizedMime,
    extension: extension || null,
  };
};

const buildImageFileFilter = () => (req, file, cb) => {
  const result = isAllowedImageFile({
    mimetype: file?.mimetype,
    originalName: file?.originalname,
  });

  if (!result.allowed) {
    return cb(
      new AppError('Only image uploads are supported', 400, {
        code: 'INVALID_MEDIA_TYPE',
        details: {
          mimetype: result.normalizedMime || null,
          originalName: String(file?.originalname || '') || null,
          extension: result.extension,
        },
      })
    );
  }

  return cb(null, true);
};

const createImageDiskUpload = ({
  filenamePrefix = 'media',
  tempSubdir = '',
  maxFileSize = MEDIA_MAX_FILE_SIZE,
} = {}) => {
  const tempDir = ensureDir(
    path.join(process.cwd(), 'uploads', 'temp', String(tempSubdir || '').trim())
  );

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
      const extension = path.extname(file.originalname || '');
      cb(
        null,
        `${filenamePrefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
      );
    },
  });

  return multer({
    storage,
    limits: {
      fileSize: Number.isFinite(Number(maxFileSize))
        ? Number(maxFileSize)
        : MEDIA_MAX_FILE_SIZE,
      files: 1,
    },
    fileFilter: buildImageFileFilter(),
  });
};

module.exports = {
  ALLOWED_CONTENT_TYPES,
  ALLOWED_IMAGE_EXTENSIONS,
  MEDIA_MAX_FILE_SIZE,
  normalizeContentType,
  createImageDiskUpload,
  isAllowedImageFile,
};
