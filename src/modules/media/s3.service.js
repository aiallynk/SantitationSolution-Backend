const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { runtimeConfig } = require('../../config/runtime');

const normalizeBool = (value) => String(value || '').toLowerCase() === 'true';
const normalizeText = (value) => String(value || '').trim();

const PUBLIC_ACLS = new Set([
  'public-read',
  'public-read-write',
  'authenticated-read',
  'aws-exec-read',
]);
const ALLOWED_SERVER_SIDE_ENCRYPTION = new Set(['AES256', 'aws:kms']);
const MAX_S3_BUFFER_BYTES = Math.max(
  Number(runtimeConfig.media.s3ObjectMaxBufferBytes || 12 * 1024 * 1024),
  1024 * 1024
);

const s3Config = {
  region: normalizeText(runtimeConfig.media.s3.region),
  bucket: normalizeText(runtimeConfig.media.s3.bucket),
  accessKeyId: normalizeText(runtimeConfig.media.s3.accessKeyId),
  secretAccessKey: normalizeText(runtimeConfig.media.s3.secretAccessKey),
  sessionToken: normalizeText(runtimeConfig.media.s3.sessionToken),
  endpoint: normalizeText(runtimeConfig.media.s3.endpoint),
  forcePathStyle: normalizeBool(runtimeConfig.media.s3.forcePathStyle),
  publicBaseUrl: normalizeText(runtimeConfig.media.s3.publicBaseUrl),
  objectAcl: normalizeText(runtimeConfig.media.s3.objectAcl),
  mediaUrlMode: normalizeText(runtimeConfig.media.s3.mediaUrlMode || 'locator').toLowerCase(),
  enforcePrivateAcl: normalizeBool(runtimeConfig.media.s3.enforcePrivateAcl || 'true'),
  serverSideEncryption: normalizeText(runtimeConfig.media.s3.serverSideEncryption || 'AES256'),
  kmsKeyId: normalizeText(runtimeConfig.media.s3.kmsKeyId),
  bucketKeyEnabled: normalizeBool(runtimeConfig.media.s3.bucketKeyEnabled || 'true'),
};

const isTemplateSecret = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes('your_aws_') ||
    normalized.includes('replace_with') ||
    normalized.endsWith('_here')
  );
};

const isS3Enabled = () =>
  Boolean(
    s3Config.region &&
      s3Config.bucket &&
      !isTemplateSecret(s3Config.accessKeyId) &&
      !isTemplateSecret(s3Config.secretAccessKey)
  );

let cachedS3Client = null;

const normalizeObjectKey = (value) =>
  String(value || '')
    .trim()
    .replace(/^\/+/, '');

const encodeObjectKey = (key) =>
  normalizeObjectKey(key)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const resolveObjectAcl = () => {
  const acl = normalizeText(s3Config.objectAcl).toLowerCase();
  if (!acl) return null;
  if (s3Config.enforcePrivateAcl && PUBLIC_ACLS.has(acl)) {
    throw new Error(
      `Refusing insecure AWS_S3_OBJECT_ACL=${acl}. Use private ACL or leave it empty.`
    );
  }
  return acl;
};

const resolveS3EncryptionOptions = () => {
  const configured = normalizeText(s3Config.serverSideEncryption);
  if (!configured) return {};

  const normalized =
    configured.toUpperCase() === 'AES256' ? 'AES256' : configured.toLowerCase() === 'aws:kms' ? 'aws:kms' : null;
  if (!normalized || !ALLOWED_SERVER_SIDE_ENCRYPTION.has(normalized)) {
    throw new Error(
      `Unsupported AWS_S3_SERVER_SIDE_ENCRYPTION value: ${configured}`
    );
  }

  if (normalized === 'aws:kms') {
    return {
      ServerSideEncryption: 'aws:kms',
      ...(s3Config.kmsKeyId ? { SSEKMSKeyId: s3Config.kmsKeyId } : {}),
      BucketKeyEnabled: s3Config.bucketKeyEnabled,
    };
  }

  return {
    ServerSideEncryption: 'AES256',
  };
};

const S3_OBJECT_ACL = resolveObjectAcl();
const S3_ENCRYPTION_OPTIONS = resolveS3EncryptionOptions();

const getS3EncryptionPolicy = () => ({
  enabled: Boolean(S3_ENCRYPTION_OPTIONS.ServerSideEncryption),
  algorithm: S3_ENCRYPTION_OPTIONS.ServerSideEncryption || null,
  kmsKeyId: S3_ENCRYPTION_OPTIONS.SSEKMSKeyId || null,
  bucketKeyEnabled:
    S3_ENCRYPTION_OPTIONS.BucketKeyEnabled !== undefined
      ? Boolean(S3_ENCRYPTION_OPTIONS.BucketKeyEnabled)
      : null,
});

const getPresignedEncryptionHeaders = () => {
  if (!S3_ENCRYPTION_OPTIONS.ServerSideEncryption) {
    return {};
  }
  return {
    'x-amz-server-side-encryption': S3_ENCRYPTION_OPTIONS.ServerSideEncryption,
    ...(S3_ENCRYPTION_OPTIONS.SSEKMSKeyId
      ? { 'x-amz-server-side-encryption-aws-kms-key-id': S3_ENCRYPTION_OPTIONS.SSEKMSKeyId }
      : {}),
    ...(S3_ENCRYPTION_OPTIONS.BucketKeyEnabled !== undefined
      ? {
          'x-amz-server-side-encryption-bucket-key-enabled': String(
            Boolean(S3_ENCRYPTION_OPTIONS.BucketKeyEnabled)
          ),
        }
      : {}),
  };
};

const extractSignedHeadersFromPresignedUrl = (presignedUrl) => {
  try {
    const url = new URL(String(presignedUrl || ''));
    const raw =
      url.searchParams.get('X-Amz-SignedHeaders') ||
      url.searchParams.get('x-amz-signedheaders') ||
      '';
    return new Set(
      String(raw)
        .split(';')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
    );
  } catch (_) {
    return new Set();
  }
};

const filterUnsignedAmzHeaders = (headers, signedHeaders) =>
  Object.fromEntries(
    Object.entries(headers || {}).filter(([key, value]) => {
      if (value === undefined || value === null || String(value).length === 0) {
        return false;
      }

      const normalizedKey = String(key).trim().toLowerCase();
      if (!normalizedKey.startsWith('x-amz-')) {
        return true;
      }
      return signedHeaders.has(normalizedKey);
    })
  );

const resolveMimeType = (filePath) => {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.ogv') return 'video/ogg';
  if (ext === '.csv') return 'text/csv';
  return 'image/jpeg';
};

const getS3Client = () => {
  if (!isS3Enabled()) {
    return null;
  }
  if (cachedS3Client) {
    return cachedS3Client;
  }

  const clientOptions = {
    region: s3Config.region,
    forcePathStyle: s3Config.forcePathStyle,
    credentials: {
      accessKeyId: s3Config.accessKeyId,
      secretAccessKey: s3Config.secretAccessKey,
      ...(s3Config.sessionToken ? { sessionToken: s3Config.sessionToken } : {}),
    },
  };

  if (s3Config.endpoint) {
    clientOptions.endpoint = s3Config.endpoint;
  }

  cachedS3Client = new S3Client(clientOptions);
  return cachedS3Client;
};

const buildObjectUrl = (objectKey) => {
  const normalizedObjectKey = normalizeObjectKey(objectKey);
  if (!normalizedObjectKey) {
    return null;
  }

  if (s3Config.mediaUrlMode !== 'public') {
    return `s3://${s3Config.bucket}/${normalizedObjectKey}`;
  }

  const encodedKey = encodeObjectKey(objectKey);
  if (s3Config.publicBaseUrl) {
    return `${s3Config.publicBaseUrl.replace(/\/+$/, '')}/${encodedKey}`;
  }

  if (s3Config.endpoint) {
    const endpoint = s3Config.endpoint.replace(/\/+$/, '');
    if (s3Config.forcePathStyle) {
      return `${endpoint}/${encodeURIComponent(s3Config.bucket)}/${encodedKey}`;
    }
    return `${endpoint}/${encodedKey}`;
  }

  return `https://${s3Config.bucket}.s3.${s3Config.region}.amazonaws.com/${encodedKey}`;
};

const uploadFileToS3 = async ({ filePath, objectKey, contentType = null }) => {
  const client = getS3Client();
  if (!client) {
    throw new Error('S3 is not configured');
  }

  const stat = await fs.promises.stat(filePath);
  const body = fs.createReadStream(filePath);
  const resolvedContentType =
    String(contentType || '').trim() || resolveMimeType(filePath);

  const command = new PutObjectCommand({
    Bucket: s3Config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: resolvedContentType,
    ...(S3_OBJECT_ACL ? { ACL: S3_OBJECT_ACL } : {}),
    ...S3_ENCRYPTION_OPTIONS,
  });

  const response = await client.send(command);

  return {
    bucket: s3Config.bucket,
    region: s3Config.region,
    objectKey,
    fileUrl: buildObjectUrl(objectKey),
    bytes: Number(stat.size || 0),
    contentType: resolvedContentType,
    eTag: response.ETag || null,
  };
};

const getPresignedPutObjectUrl = async ({
  objectKey,
  contentType = 'image/jpeg',
  contentLength = null,
  metadata = null,
  expiresInSeconds = Number(runtimeConfig.media.s3PresignedPutTtlSec || 900),
}) => {
  const client = getS3Client();
  if (!client) {
    throw new Error('S3 is not configured');
  }

  const command = new PutObjectCommand({
    Bucket: s3Config.bucket,
    Key: objectKey,
    ContentType: contentType,
    ...(Number.isFinite(Number(contentLength)) && Number(contentLength) > 0
      ? { ContentLength: Number(contentLength) }
      : {}),
    ...(metadata && typeof metadata === 'object' ? { Metadata: metadata } : {}),
    ...(S3_OBJECT_ACL ? { ACL: S3_OBJECT_ACL } : {}),
    ...S3_ENCRYPTION_OPTIONS,
  });

  const safeExpires = Math.min(Math.max(Number(expiresInSeconds || 900), 60), 3600);
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: safeExpires,
  });
  const signedHeaders = extractSignedHeadersFromPresignedUrl(uploadUrl);
  const requestedHeaders = {
    'Content-Type': contentType,
    ...(S3_OBJECT_ACL ? { 'x-amz-acl': S3_OBJECT_ACL } : {}),
    ...getPresignedEncryptionHeaders(),
    ...(metadata && typeof metadata === 'object'
      ? Object.fromEntries(
          Object.entries(metadata).map(([key, value]) => [
            `x-amz-meta-${String(key).toLowerCase()}`,
            String(value),
          ])
        )
      : {}),
  };

  return {
    uploadUrl,
    expiresAt: new Date(Date.now() + safeExpires * 1000).toISOString(),
    headers: filterUnsignedAmzHeaders(requestedHeaders, signedHeaders),
  };
};

const getPresignedGetObjectUrl = async ({
  storageKey,
  expiresInSeconds = Number(runtimeConfig.media.s3PresignedGetTtlSec || 900),
}) => {
  const client = getS3Client();
  if (!client) return null;

  const objectKey = normalizeS3ObjectKey(storageKey);
  if (!objectKey) return null;

  const command = new GetObjectCommand({
    Bucket: s3Config.bucket,
    Key: objectKey,
  });
  const safeExpires = Math.min(Math.max(Number(expiresInSeconds || 900), 60), 3600);
  return getSignedUrl(client, command, { expiresIn: safeExpires });
};

const streamToBuffer = async (stream, maxBytes = MAX_S3_BUFFER_BYTES) => {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += normalized.length;
    if (totalBytes > maxBytes) {
      throw new Error(
        `S3 object exceeds in-memory buffer limit (${maxBytes} bytes)`
      );
    }
    chunks.push(normalized);
  }
  return Buffer.concat(chunks);
};

const normalizeS3ObjectKey = (storageKey) => {
  const normalized = String(storageKey || '').trim();
  if (!normalized) return '';
  if (!normalized.startsWith('s3://')) return normalized;

  const withoutScheme = normalized.slice('s3://'.length);
  const parts = withoutScheme.split('/').filter(Boolean);
  if (parts.length === 0) return '';

  const bucketName = parts[0];
  if (bucketName === s3Config.bucket) {
    return parts.slice(1).join('/');
  }
  return parts.slice(1).join('/') || withoutScheme;
};

const getObjectDataUrlFromS3 = async (storageKey) => {
  const client = getS3Client();
  if (!client) return null;

  const objectKey = normalizeS3ObjectKey(storageKey);
  if (!objectKey) return null;

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: objectKey,
      })
    );

    const bodyBuffer = await streamToBuffer(response.Body);
    if (bodyBuffer.length === 0) return null;

    const contentType = String(response.ContentType || resolveMimeType(objectKey));
    return `data:${contentType};base64,${bodyBuffer.toString('base64')}`;
  } catch (error) {
    return null;
  }
};

const getObjectBufferFromS3 = async (storageKey) => {
  const client = getS3Client();
  if (!client) return null;

  const objectKey = normalizeS3ObjectKey(storageKey);
  if (!objectKey) return null;

  try {
    const response = await client.send(
      new GetObjectCommand({
        Bucket: s3Config.bucket,
        Key: objectKey,
      })
    );
    const bodyBuffer = await streamToBuffer(response.Body);
    if (!bodyBuffer || bodyBuffer.length === 0) return null;
    return {
      buffer: bodyBuffer,
      objectKey,
      bucket: s3Config.bucket,
      contentType: String(response.ContentType || resolveMimeType(objectKey)),
      contentLength: Number(response.ContentLength || bodyBuffer.length || 0),
      metadata: response.Metadata || null,
    };
  } catch (_) {
    return null;
  }
};

const headObjectFromS3 = async (storageKey) => {
  const client = getS3Client();
  if (!client) return null;

  const objectKey = normalizeS3ObjectKey(storageKey);
  if (!objectKey) return null;

  try {
    const response = await client.send(
      new HeadObjectCommand({
        Bucket: s3Config.bucket,
        Key: objectKey,
      })
    );

    return {
      bucket: s3Config.bucket,
      objectKey,
      eTag: response.ETag || null,
      contentLength: Number(response.ContentLength || 0),
      contentType: response.ContentType || null,
      lastModified: response.LastModified || null,
      metadata: response.Metadata || null,
      serverSideEncryption: response.ServerSideEncryption || null,
      sseKmsKeyId: response.SSEKMSKeyId || null,
      bucketKeyEnabled:
        response.BucketKeyEnabled !== undefined
          ? Boolean(response.BucketKeyEnabled)
          : null,
      fileUrl: buildObjectUrl(objectKey),
    };
  } catch (error) {
    return null;
  }
};

module.exports = {
  isS3Enabled,
  uploadFileToS3,
  getPresignedPutObjectUrl,
  getPresignedGetObjectUrl,
  getObjectDataUrlFromS3,
  getObjectBufferFromS3,
  headObjectFromS3,
  normalizeS3ObjectKey,
  buildObjectUrl,
  getS3EncryptionPolicy,
};
