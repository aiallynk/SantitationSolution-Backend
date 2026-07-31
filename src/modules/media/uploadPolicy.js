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

const ALLOWED_VIDEO_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/ogg',
]);

const ALLOWED_CSV_CONTENT_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.ms-excel',
  'text/plain',
]);

const ALLOWED_INSPECTION_ATTACHMENT_CONTENT_TYPES = new Set([
  ...ALLOWED_CONTENT_TYPES,
  ...ALLOWED_VIDEO_CONTENT_TYPES,
  ...ALLOWED_CSV_CONTENT_TYPES,
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

const ALLOWED_VIDEO_EXTENSIONS = new Set([
  '.mp4',
  '.webm',
  '.mov',
  '.ogv',
]);

const ALLOWED_CSV_EXTENSIONS = new Set(['.csv']);

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

const isAllowedInspectionAttachmentFile = ({ mimetype, originalName }) => {
  const normalizedMime = normalizeContentType(mimetype);
  const extension = path.extname(String(originalName || '')).toLowerCase();
  const canTrustExtension =
    (normalizedMime === '' || normalizedMime === 'application/octet-stream') &&
    (ALLOWED_IMAGE_EXTENSIONS.has(extension) ||
      ALLOWED_VIDEO_EXTENSIONS.has(extension) ||
      ALLOWED_CSV_EXTENSIONS.has(extension));

  if (normalizedMime.startsWith('image/') || ALLOWED_CONTENT_TYPES.has(normalizedMime)) {
    return {
      allowed: true,
      kind: 'image',
      normalizedMime,
      extension: extension || null,
    };
  }

  if (normalizedMime.startsWith('video/') || ALLOWED_VIDEO_CONTENT_TYPES.has(normalizedMime)) {
    return {
      allowed: true,
      kind: 'video',
      normalizedMime,
      extension: extension || null,
    };
  }

  if (ALLOWED_CSV_CONTENT_TYPES.has(normalizedMime) && ALLOWED_CSV_EXTENSIONS.has(extension)) {
    return {
      allowed: true,
      kind: 'csv',
      normalizedMime,
      extension: extension || null,
    };
  }

  if (canTrustExtension) {
    const kind = ALLOWED_CSV_EXTENSIONS.has(extension)
      ? 'csv'
      : ALLOWED_VIDEO_EXTENSIONS.has(extension)
        ? 'video'
        : 'image';
    return {
      allowed: true,
      kind,
      normalizedMime,
      extension: extension || null,
    };
  }

  return {
    allowed: false,
    kind: null,
    normalizedMime,
    extension: extension || null,
  };
};

const buildInspectionAttachmentFileFilter = () => (req, file, cb) => {
  const result = isAllowedInspectionAttachmentFile({
    mimetype: file?.mimetype,
    originalName: file?.originalname,
  });

  if (!result.allowed) {
    return cb(
      new AppError('Only image, video, or CSV uploads are supported', 400, {
        code: 'INVALID_MEDIA_TYPE',
        details: {
          mimetype: result.normalizedMime || null,
          originalName: String(file?.originalname || '') || null,
          extension: result.extension,
        },
      })
    );
  }

  req.uploadFileKind = result.kind;
  return cb(null, true);
};

const createInspectionAttachmentDiskUpload = ({
  filenamePrefix = 'attachment',
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
    fileFilter: buildInspectionAttachmentFileFilter(),
  });
};

const createCsvDiskUpload = ({
  filenamePrefix = 'csv',
  tempSubdir = '',
  maxFileSize = MEDIA_MAX_FILE_SIZE,
} = {}) => {
  const tempDir = ensureDir(
    path.join(process.cwd(), 'uploads', 'temp', String(tempSubdir || '').trim())
  );

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, tempDir),
    filename: (req, file, cb) => {
      const extension = path.extname(file.originalname || '') || '.csv';
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
    fileFilter: (req, file, cb) => {
      const result = isAllowedInspectionAttachmentFile({
        mimetype: file?.mimetype,
        originalName: file?.originalname,
      });
      if (!result.allowed || result.kind !== 'csv') {
        return cb(
          new AppError('Only CSV uploads are supported', 400, {
            code: 'INVALID_MEDIA_TYPE',
            details: {
              mimetype: result.normalizedMime || null,
              originalName: String(file?.originalname || '') || null,
              extension: result.extension,
            },
          })
        );
      }
      req.uploadFileKind = 'csv';
      return cb(null, true);
    },
  });
};

module.exports = {
  ALLOWED_CONTENT_TYPES,
  ALLOWED_VIDEO_CONTENT_TYPES,
  ALLOWED_CSV_CONTENT_TYPES,
  ALLOWED_INSPECTION_ATTACHMENT_CONTENT_TYPES,
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  ALLOWED_CSV_EXTENSIONS,
  MEDIA_MAX_FILE_SIZE,
  normalizeContentType,
  createImageDiskUpload,
  createInspectionAttachmentDiskUpload,
  createCsvDiskUpload,
  isAllowedImageFile,
  isAllowedInspectionAttachmentFile,
};
