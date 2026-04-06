const {
  isS3Enabled,
  getPresignedGetObjectUrl,
  normalizeS3ObjectKey,
} = require('./s3.service');

const S3_BUCKET_NAME = String(process.env.AWS_S3_BUCKET || '')
  .trim()
  .toLowerCase();
const S3_PUBLIC_BASE_URL = String(process.env.AWS_S3_PUBLIC_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');
const S3_ENDPOINT_HOST = (() => {
  const endpoint = String(process.env.AWS_S3_ENDPOINT || '').trim();
  if (!endpoint) return '';
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch (_) {
    return '';
  }
})();

const normalizeMediaUrl = (rawUrl) => {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  if (value.startsWith('/static/uploads/')) {
    return value.replace('/static/uploads/', '/static/');
  }
  return value;
};

const looksLikeSignedS3Url = (value) => {
  try {
    const parsed = new URL(value);
    const hasV4 =
      parsed.searchParams.has('X-Amz-Signature') ||
      parsed.searchParams.has('X-Amz-Credential') ||
      parsed.searchParams.has('X-Amz-Algorithm');
    const hasLegacy = parsed.searchParams.has('Signature') && parsed.searchParams.has('AWSAccessKeyId');
    return hasV4 || hasLegacy;
  } catch (_) {
    return false;
  }
};

const stripLeadingSlashes = (value) => String(value || '').replace(/^\/+/, '');

const decodePath = (value) => {
  try {
    return decodeURIComponent(String(value || ''));
  } catch (_) {
    return String(value || '');
  }
};

const normalizePathBucketPrefix = (pathValue) => {
  if (!S3_BUCKET_NAME) return pathValue;
  const lower = String(pathValue || '').toLowerCase();
  if (lower.startsWith(`${S3_BUCKET_NAME}/`)) {
    return String(pathValue).slice(S3_BUCKET_NAME.length + 1);
  }
  return pathValue;
};

const deriveObjectKeyFromUrl = (rawUrl) => {
  const normalizedUrl = String(rawUrl || '').trim();
  if (!normalizedUrl || normalizedUrl.startsWith('/static/') || normalizedUrl.startsWith('data:')) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch (_) {
    return null;
  }

  if (looksLikeSignedS3Url(normalizedUrl)) {
    return null;
  }

  const host = String(parsed.hostname || '').toLowerCase();
  let pathValue = stripLeadingSlashes(decodePath(parsed.pathname || ''));
  if (!pathValue) return null;

  if (
    S3_PUBLIC_BASE_URL &&
    normalizedUrl.toLowerCase().startsWith(`${S3_PUBLIC_BASE_URL.toLowerCase()}/`)
  ) {
    const suffix = normalizedUrl
      .slice(S3_PUBLIC_BASE_URL.length + 1)
      .split('?')[0]
      .split('#')[0];
    pathValue = stripLeadingSlashes(decodePath(suffix));
  }

  if (host.startsWith(`${S3_BUCKET_NAME}.`) || host.includes('.s3.') || host === 's3.amazonaws.com') {
    return normalizePathBucketPrefix(pathValue) || null;
  }

  if (S3_ENDPOINT_HOST && host === S3_ENDPOINT_HOST) {
    return normalizePathBucketPrefix(pathValue) || null;
  }

  return null;
};

const resolveStorageKey = ({ storageKey, fileUrl }) => {
  const normalizedStorageKey = normalizeS3ObjectKey(String(storageKey || '').trim());
  if (normalizedStorageKey) {
    return normalizedStorageKey;
  }
  return deriveObjectKeyFromUrl(fileUrl);
};

const resolveMediaUrl = async (
  { fileUrl, storageKey = null } = {},
  { cache = null } = {}
) => {
  const normalizedUrl = normalizeMediaUrl(fileUrl);
  if (!normalizedUrl) return null;
  if (normalizedUrl.startsWith('/static/') || normalizedUrl.startsWith('data:')) {
    return normalizedUrl;
  }
  if (!isS3Enabled()) {
    return normalizedUrl;
  }
  if (looksLikeSignedS3Url(normalizedUrl)) {
    return normalizedUrl;
  }

  const objectKey = resolveStorageKey({ storageKey, fileUrl: normalizedUrl });
  if (!objectKey) {
    return normalizedUrl;
  }

  if (cache && cache.has(objectKey)) {
    return cache.get(objectKey);
  }

  let resolvedUrl = normalizedUrl;
  try {
    const signedUrl = await getPresignedGetObjectUrl({ storageKey: objectKey });
    if (signedUrl) {
      resolvedUrl = signedUrl;
    }
  } catch (_) {
    resolvedUrl = normalizedUrl;
  }

  if (cache) {
    cache.set(objectKey, resolvedUrl);
  }
  return resolvedUrl;
};

const resolveMediaPairUrls = async (
  { fileUrl, thumbnailUrl = null, storageKey = null } = {},
  { cache = null } = {}
) => {
  const resolvedFileUrl = await resolveMediaUrl(
    {
      fileUrl,
      storageKey,
    },
    { cache }
  );

  const rawThumb = thumbnailUrl || fileUrl || null;
  const thumbUsesSameObject = !thumbnailUrl || String(thumbnailUrl || '') === String(fileUrl || '');
  const resolvedThumbnailUrl = await resolveMediaUrl(
    {
      fileUrl: rawThumb,
      storageKey: thumbUsesSameObject ? storageKey : null,
    },
    { cache }
  );

  return {
    fileUrl: resolvedFileUrl,
    thumbnailUrl: resolvedThumbnailUrl || resolvedFileUrl || null,
  };
};

module.exports = {
  normalizeMediaUrl,
  resolveMediaUrl,
  resolveMediaPairUrls,
};
