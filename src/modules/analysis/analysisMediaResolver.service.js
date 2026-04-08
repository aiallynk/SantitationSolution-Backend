const fs = require('fs');
const path = require('path');
const { getPresignedGetObjectUrl } = require('../media/s3.service');

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
  if (!candidate || !fs.existsSync(candidate)) return null;
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
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to fetch image (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!buffer || buffer.length === 0) {
    throw new Error('Fetched image is empty');
  }
  return {
    buffer,
    mimeType: response.headers.get('content-type') || 'image/jpeg',
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
    const presigned = await getPresignedGetObjectUrl({ storageKey });
    if (presigned) {
      return fetchRemoteImage(presigned);
    }
  }

  if (!preferLocal && !storageKey && /^s3:\/\//i.test(fileUrl)) {
    const presigned = await getPresignedGetObjectUrl({ storageKey: fileUrl });
    if (presigned) {
      return fetchRemoteImage(presigned);
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
