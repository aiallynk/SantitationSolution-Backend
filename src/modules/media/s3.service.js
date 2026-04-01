const fs = require('fs');
const path = require('path');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const normalizeBool = (value) => String(value || '').toLowerCase() === 'true';

const s3Config = {
  region: String(process.env.AWS_REGION || '').trim(),
  bucket: String(process.env.AWS_S3_BUCKET || '').trim(),
  accessKeyId: String(process.env.AWS_ACCESS_KEY_ID || '').trim(),
  secretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY || '').trim(),
  sessionToken: String(process.env.AWS_SESSION_TOKEN || '').trim(),
  endpoint: String(process.env.AWS_S3_ENDPOINT || '').trim(),
  forcePathStyle: normalizeBool(process.env.AWS_S3_FORCE_PATH_STYLE),
  publicBaseUrl: String(process.env.AWS_S3_PUBLIC_BASE_URL || '').trim(),
  objectAcl: String(process.env.AWS_S3_OBJECT_ACL || '').trim(),
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

const encodeObjectKey = (key) =>
  String(key || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const resolveMimeType = (filePath) => {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
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

const uploadFileToS3 = async ({ filePath, objectKey }) => {
  const client = getS3Client();
  if (!client) {
    throw new Error('S3 is not configured');
  }

  const body = await fs.promises.readFile(filePath);
  const contentType = resolveMimeType(filePath);

  const command = new PutObjectCommand({
    Bucket: s3Config.bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentType,
    ...(s3Config.objectAcl ? { ACL: s3Config.objectAcl } : {}),
  });

  const response = await client.send(command);

  return {
    bucket: s3Config.bucket,
    region: s3Config.region,
    objectKey,
    fileUrl: buildObjectUrl(objectKey),
    bytes: body.length,
    contentType,
    eTag: response.ETag || null,
  };
};

const getPresignedPutObjectUrl = async ({
  objectKey,
  contentType = 'image/jpeg',
  contentLength = null,
  metadata = null,
  expiresInSeconds = Number(process.env.S3_PRESIGNED_URL_TTL_SEC || 900),
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
    ...(s3Config.objectAcl ? { ACL: s3Config.objectAcl } : {}),
  });

  const safeExpires = Math.min(Math.max(Number(expiresInSeconds || 900), 60), 3600);
  const uploadUrl = await getSignedUrl(client, command, {
    expiresIn: safeExpires,
  });

  return {
    uploadUrl,
    expiresAt: new Date(Date.now() + safeExpires * 1000).toISOString(),
    headers: {
      'Content-Type': contentType,
      ...(metadata && typeof metadata === 'object'
        ? Object.fromEntries(
            Object.entries(metadata).map(([key, value]) => [
              `x-amz-meta-${String(key).toLowerCase()}`,
              String(value),
            ])
          )
        : {}),
    },
  };
};

const getPresignedGetObjectUrl = async ({
  storageKey,
  expiresInSeconds = Number(process.env.S3_PRESIGNED_GET_TTL_SEC || 900),
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

const streamToBuffer = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
  headObjectFromS3,
  normalizeS3ObjectKey,
  buildObjectUrl,
};
