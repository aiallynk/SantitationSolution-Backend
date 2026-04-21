const fs = require('fs');
const path = require('path');
const { getObjectBufferFromS3 } = require('../media/s3.service');
const { logger } = require('../../core/logging/logger');
const { runtimeConfig } = require('../../config/runtime');

const MAX_MEDIA_RESOLVE_BYTES = Math.max(runtimeConfig.analysis.mediaMaxBytes, 1024 * 1024);
const REMOTE_FETCH_TIMEOUT_MS = Math.max(runtimeConfig.analysis.mediaFetchTimeoutMs, 1000);

const getMimeType = (filePath) => {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.heif') return 'image/heif';
  return 'image/jpeg';
};

const resolveLocalCandidates = ({ fileUrl, storageKey }) => {
  const candidates = new Set();
  const add = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    candidates.add(path.normalize(normalized));
  };

  const normalizedFileUrl = String(fileUrl || '').trim().replace(/\\/g, '/');
  if (normalizedFileUrl.startsWith('/static/')) {
    const relativePath = normalizedFileUrl.replace(/^\/static\/+/, '');
    add(path.join(process.cwd(), 'uploads', relativePath));
  }

  const normalizedStorageKey = String(storageKey || '').trim().replace(/\\/g, '/');
  if (normalizedStorageKey) {
    if (path.isAbsolute(normalizedStorageKey)) {
      add(normalizedStorageKey);
    }
    add(path.resolve(process.cwd(), normalizedStorageKey));
    add(path.resolve(process.cwd(), 'uploads', normalizedStorageKey));
  }

  return [...candidates];
};

const readLocalImage = async (candidate) => {
  if (!candidate) return null;
  let stat;
  try {
    stat = await fs.promises.stat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) return null;
  if (Number(stat.size || 0) > MAX_MEDIA_RESOLVE_BYTES) {
    logger.warn('Skipping local analysis image because file is too large', {
      localPath: candidate,
      bytes: Number(stat.size || 0),
      maxBytes: MAX_MEDIA_RESOLVE_BYTES,
    });
    return null;
  }
  const buffer = await fs.promises.readFile(candidate);
  if (!buffer || buffer.length === 0) return null;
  return {
    buffer,
    mimeType: getMimeType(candidate),
    localPath: candidate,
  };
};

const decodeDataUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw.startsWith('data:')) return null;
  const commaIndex = raw.indexOf(',');
  if (commaIndex === -1) return null;

  const metadata = raw.slice(5, commaIndex);
  const dataPart = raw.slice(commaIndex + 1);
  const mimeType = metadata.split(';')[0] || 'image/jpeg';
  const isBase64 = metadata.includes(';base64');

  try {
    const buffer = isBase64
      ? Buffer.from(dataPart, 'base64')
      : Buffer.from(decodeURIComponent(dataPart), 'utf8');
    if (buffer.length > MAX_MEDIA_RESOLVE_BYTES) {
      return null;
    }
    return {
      buffer,
      mimeType,
      localPath: null,
    };
  } catch (_) {
    return null;
  }
};

const fetchRemoteImage = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`Unable to fetch image (${response.status})`);
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_RESOLVE_BYTES) {
    throw new Error(
      `Remote image too large (${contentLength} bytes > ${MAX_MEDIA_RESOLVE_BYTES})`
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer || buffer.length === 0) {
    throw new Error('Fetched image is empty');
  }
  if (buffer.length > MAX_MEDIA_RESOLVE_BYTES) {
    throw new Error(
      `Remote image too large (${buffer.length} bytes > ${MAX_MEDIA_RESOLVE_BYTES})`
    );
  }
  return {
    buffer,
    mimeType: response.headers.get('content-type') || 'image/jpeg',
    localPath: null,
  };
};

const resolveS3Image = async (storageKey) => {
  const payload = await getObjectBufferFromS3(storageKey);
  if (!payload || !payload.buffer || payload.buffer.length === 0) {
    return null;
  }
  return {
    buffer: payload.buffer,
    mimeType: payload.contentType || 'image/jpeg',
    localPath: null,
  };
};

const resolveMediaBuffer = async (media) => {
  const metadata =
    media?.metadata && typeof media.metadata === 'object' ? media.metadata : null;
  const provider = String(metadata?.provider || '').toLowerCase();
  const storageKey = String(media?.storage_key || '').trim();
  const fileUrl = String(media?.file_url || '').trim();
  const looksLocalFileUrl = fileUrl.startsWith('/static/');
  const preferLocal =
    provider === 'local' ||
    looksLocalFileUrl ||
    String(media?.upload_status || '').toLowerCase() === 'local';

  if (preferLocal) {
    const candidates = resolveLocalCandidates({ fileUrl, storageKey });
    for (const candidate of candidates) {
      const localResult = await readLocalImage(candidate);
      if (localResult) return localResult;
    }
  }

  if (storageKey && !preferLocal) {
    const fromS3 = await resolveS3Image(storageKey);
    if (fromS3) {
      return fromS3;
    }
  }

  if (!preferLocal && !storageKey && /^s3:\/\//i.test(fileUrl)) {
    const fromS3 = await resolveS3Image(fileUrl);
    if (fromS3) {
      return fromS3;
    }
  }

  if (fileUrl) {
    if (/^https?:\/\//i.test(fileUrl)) {
      return fetchRemoteImage(fileUrl);
    }
    const decoded = decodeDataUrl(fileUrl);
    if (decoded) return decoded;

    const candidates = resolveLocalCandidates({ fileUrl, storageKey });
    for (const candidate of candidates) {
      const localResult = await readLocalImage(candidate);
      if (localResult) return localResult;
    }
  }

  return null;
};

const resolveMediaUrlForVision = async (media) => {
  const resolved = await resolveMediaBuffer(media);
  if (!resolved || !resolved.buffer) return null;
  const mimeType = resolved.mimeType || 'image/jpeg';
  return `data:${mimeType};base64,${resolved.buffer.toString('base64')}`;
};

module.exports = {
  resolveMediaBuffer,
  resolveMediaUrlForVision,
};
