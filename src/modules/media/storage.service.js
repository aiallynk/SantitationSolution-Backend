const fs = require('fs');
const path = require('path');
const cloudinary = require('../../config/cloudinary');
const { isS3Enabled, uploadFileToS3 } = require('./s3.service');
const { logger } = require('../../core/logging/logger');
const { runtimeConfig } = require('../../config/runtime');

const uploadRoot = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadRoot)) {
  fs.mkdirSync(uploadRoot, { recursive: true });
}
let s3BackoffUntilTs = 0;
let s3BackoffLogged = false;

const useCloudinary = () =>
  Boolean(
    runtimeConfig.media.cloudinary.cloudName &&
      runtimeConfig.media.cloudinary.apiKey &&
      runtimeConfig.media.cloudinary.apiSecret
  );

const allowS3FallbackToLocal = () => {
  return Boolean(runtimeConfig.media.s3FallbackToLocal);
};

const resolveMimeType = (filePath) => {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
  return 'image/jpeg';
};

const uploadToCloudinary = async (filePath, targetFolder) => {
  const uploaded = await cloudinary.uploader.upload(filePath, {
    folder: targetFolder,
    resource_type: 'image',
  });
  return {
    fileUrl: uploaded.secure_url,
    storageKey: uploaded.public_id,
    metadata: {
      bytes: uploaded.bytes,
      width: uploaded.width,
      height: uploaded.height,
      format: uploaded.format,
    },
  };
};

const uploadToLocal = async (filePath, targetFolder) => {
  const folderPath = path.join(uploadRoot, targetFolder);
  await fs.promises.mkdir(folderPath, { recursive: true });
  const fileName = path.basename(filePath);
  const destination = path.join(folderPath, fileName);
  await fs.promises.copyFile(filePath, destination);
  const stat = await fs.promises.stat(destination);
  const relativePath = path.relative(uploadRoot, destination).replace(/\\/g, '/');
  return {
    fileUrl: `/static/${relativePath}`,
    storageKey: relativePath,
    metadata: {
      provider: 'local',
      bytes: stat.size,
    },
  };
};

const uploadToS3 = async (filePath, targetFolder) => {
  const normalizedFolder = String(targetFolder || 'sanitation')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  const extension = path.extname(filePath || '').toLowerCase() || '.jpg';
  const fileName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`;
  const objectKey = `${normalizedFolder}/${fileName}`;

  const uploaded = await uploadFileToS3({
    filePath,
    objectKey,
  });

  return {
    fileUrl: uploaded.fileUrl,
    storageKey: uploaded.objectKey,
    metadata: {
      provider: 's3',
      bucket: uploaded.bucket,
      region: uploaded.region,
      bytes: uploaded.bytes,
      contentType: uploaded.contentType || resolveMimeType(filePath),
      eTag: uploaded.eTag,
    },
  };
};

const uploadImage = async (filePath, targetFolder) => {
  const allowLocalFallback = allowS3FallbackToLocal();
  const nowTs = Date.now();
  const s3BackoffActive = nowTs < s3BackoffUntilTs;
  if (isS3Enabled()) {
    const shouldSkipS3Attempt = s3BackoffActive && allowLocalFallback;
    if (!shouldSkipS3Attempt) {
      try {
        return await uploadToS3(filePath, targetFolder);
      } catch (error) {
        const message = String(error?.message || '');
        const lower = message.toLowerCase();
        const isAccessDenied =
          lower.includes('not authorized to perform') ||
          lower.includes('accessdenied') ||
          lower.includes('permission');
        if (isAccessDenied) {
          s3BackoffUntilTs = Date.now() + 10 * 60 * 1000;
          if (!s3BackoffLogged) {
            s3BackoffLogged = true;
            logger.error(
              'S3 access denied. Temporarily falling back to local media storage for 10 minutes.'
            );
          }
        }
        if (!allowLocalFallback) {
          throw new Error(`S3 upload failed and local fallback is disabled: ${error.message}`);
        }
        logger.warn('S3 upload failed, falling back to local storage', {
          error: error.message,
        });
      }
    } else if (!allowLocalFallback) {
      throw new Error(
        'S3 upload was skipped due active backoff while local fallback is disabled'
      );
    }
  }
  if (useCloudinary()) {
    return uploadToCloudinary(filePath, targetFolder);
  }
  return uploadToLocal(filePath, targetFolder);
};

const removeTempFile = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('Failed to remove temp file', { error: error.message });
    }
  }
};

module.exports = {
  uploadImage,
  removeTempFile,
};
