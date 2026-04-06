const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const QR_ROOT_DIR = path.join(process.cwd(), 'uploads', 'qr', 'toilets');
const FEEDBACK_QR_SUBDIR = 'public-feedback';
const QR_VARIANTS = {
  APP: 'app',
  FEEDBACK: 'feedback',
};

const normalizeId = (value) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');

const toQrFileName = (toiletUnitId) => `${normalizeId(toiletUnitId) || 'toilet'}.png`;

const normalizeVariant = (variant) => {
  const normalized = String(variant || '').trim().toLowerCase();
  if (normalized === QR_VARIANTS.FEEDBACK) return QR_VARIANTS.FEEDBACK;
  return QR_VARIANTS.APP;
};

const getQrDirectoryByVariant = (variant = QR_VARIANTS.APP) => {
  const resolved = normalizeVariant(variant);
  if (resolved === QR_VARIANTS.FEEDBACK) {
    return path.join(QR_ROOT_DIR, FEEDBACK_QR_SUBDIR);
  }
  return QR_ROOT_DIR;
};

const getQrRelativePrefixByVariant = (variant = QR_VARIANTS.APP) => {
  const resolved = normalizeVariant(variant);
  if (resolved === QR_VARIANTS.FEEDBACK) {
    return `qr/toilets/${FEEDBACK_QR_SUBDIR}`;
  }
  return 'qr/toilets';
};

const getQrAbsolutePath = (toiletUnitId, variant = QR_VARIANTS.APP) =>
  path.join(getQrDirectoryByVariant(variant), toQrFileName(toiletUnitId));

const getQrRelativePath = (toiletUnitId, variant = QR_VARIANTS.APP) =>
  `${getQrRelativePrefixByVariant(variant)}/${toQrFileName(toiletUnitId)}`;

const getQrImageUrl = (toiletUnitId, variant = QR_VARIANTS.APP) =>
  `/static/${getQrRelativePath(toiletUnitId, variant)}`;

const getFeedbackQrImageUrl = (toiletUnitId) =>
  getQrImageUrl(toiletUnitId, QR_VARIANTS.FEEDBACK);

const normalizeBaseUrl = (rawValue) => {
  const value = String(rawValue || '').trim();
  if (!value) return '';
  const withoutTrailingSlash = value.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(withoutTrailingSlash)) {
    return '';
  }
  return withoutTrailingSlash;
};

const resolvePublicFeedbackBaseUrl = () => {
  const explicit = normalizeBaseUrl(process.env.PUBLIC_FEEDBACK_BASE_URL);
  if (explicit) {
    return explicit;
  }

  const protocol =
    String(process.env.PUBLIC_FEEDBACK_PROTOCOL || 'http').trim().toLowerCase() ===
    'https'
      ? 'https'
      : 'http';
  const host = String(process.env.PUBLIC_FEEDBACK_HOST || 'localhost').trim() || 'localhost';
  const rawPort = Number(process.env.PUBLIC_FEEDBACK_PORT || process.env.PORT || 5000);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 5000;
  const includePort = !(
    (protocol === 'http' && port === 80) ||
    (protocol === 'https' && port === 443)
  );

  return `${protocol}://${host}${includePort ? `:${port}` : ''}`;
};

const getPublicFeedbackUrl = ({ toiletUnitId } = {}) => {
  const unitId = normalizeId(toiletUnitId);
  if (!unitId) return null;
  const baseUrl = resolvePublicFeedbackBaseUrl();
  return `${baseUrl}/api/v1/public-feedback/toilets/${encodeURIComponent(unitId)}`;
};

const ensureQrDirectory = async (variant = QR_VARIANTS.APP) => {
  await fs.promises.mkdir(getQrDirectoryByVariant(variant), { recursive: true });
};

const fileExists = async (absolutePath) => {
  try {
    await fs.promises.access(absolutePath, fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
};

const ensureQrImageForToilet = async ({
  toiletUnitId,
  qrCodeValue,
  variant = QR_VARIANTS.APP,
  forceRegenerate = false,
}) => {
  const unitId = normalizeId(toiletUnitId);
  const qrValue = String(qrCodeValue || '').trim();
  if (!unitId || !qrValue) {
    return null;
  }

  const resolvedVariant = normalizeVariant(variant);
  await ensureQrDirectory(resolvedVariant);
  const targetPath = getQrAbsolutePath(unitId, resolvedVariant);
  const alreadyExists = await fileExists(targetPath);
  if (alreadyExists && !forceRegenerate) {
    return {
      qrImageUrl: getQrImageUrl(unitId, resolvedVariant),
      qrImagePath: targetPath,
      variant: resolvedVariant,
      existed: true,
      generated: false,
    };
  }
  await QRCode.toFile(targetPath, qrValue, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 512,
    color: {
      dark: '#111827',
      light: '#FFFFFF',
    },
  });

  return {
    qrImageUrl: getQrImageUrl(unitId, resolvedVariant),
    qrImagePath: targetPath,
    variant: resolvedVariant,
    existed: alreadyExists,
    generated: true,
  };
};

const ensureAllQrImagesForToilet = async ({
  toiletUnitId,
  appQrCodeValue,
  feedbackQrValue,
  forceRegenerate = false,
}) => {
  const unitId = normalizeId(toiletUnitId);
  if (!unitId) {
    return null;
  }

  const resolvedAppQrValue = String(appQrCodeValue || '').trim();
  const resolvedFeedbackQrValue =
    String(feedbackQrValue || '').trim() || getPublicFeedbackUrl({ toiletUnitId: unitId }) || '';

  if (!resolvedAppQrValue || !resolvedFeedbackQrValue) {
    return null;
  }

  const [appResult, feedbackResult] = await Promise.all([
    ensureQrImageForToilet({
      toiletUnitId: unitId,
      qrCodeValue: resolvedAppQrValue,
      variant: QR_VARIANTS.APP,
      forceRegenerate,
    }),
    ensureQrImageForToilet({
      toiletUnitId: unitId,
      qrCodeValue: resolvedFeedbackQrValue,
      variant: QR_VARIANTS.FEEDBACK,
      forceRegenerate,
    }),
  ]);

  if (!appResult || !feedbackResult) {
    return null;
  }

  return {
    appQrCodeValue: resolvedAppQrValue,
    appQrImageUrl: appResult.qrImageUrl,
    feedbackQrValue: resolvedFeedbackQrValue,
    feedbackQrImageUrl: feedbackResult.qrImageUrl,
    publicFeedbackUrl: resolvedFeedbackQrValue,
    app: appResult,
    feedback: feedbackResult,
    generated: Boolean(appResult.generated || feedbackResult.generated),
  };
};

const ensureQrImagesForToilets = async (toiletRows = [], options = {}) => {
  const rows = Array.isArray(toiletRows) ? toiletRows : [];
  if (rows.length === 0) {
    return {
      total: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
    };
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  let appGenerated = 0;
  let feedbackGenerated = 0;

  for (const row of rows) {
    const toiletUnitId = row?.toiletUnitId || row?.id || null;
    const appQrCodeValue =
      row?.appQrCodeValue || row?.qrCodeValue || row?.qr_code || row?.code || null;
    const feedbackQrValue =
      row?.feedbackQrValue || row?.publicFeedbackUrl || row?.public_feedback_url || null;
    try {
      const result = await ensureAllQrImagesForToilet({
        toiletUnitId,
        appQrCodeValue,
        feedbackQrValue,
        forceRegenerate: Boolean(options.forceRegenerate),
      });
      if (!result) {
        failed += 1;
      } else {
        if (result.app?.generated) appGenerated += 1;
        if (result.feedback?.generated) feedbackGenerated += 1;
        if (result.generated) {
          generated += 1;
        } else {
          skipped += 1;
        }
      }
    } catch (_) {
      failed += 1;
    }
  }

  return {
    total: rows.length,
    generated,
    skipped,
    failed,
    appGenerated,
    feedbackGenerated,
  };
};

module.exports = {
  getQrImageUrl,
  getFeedbackQrImageUrl,
  getPublicFeedbackUrl,
  ensureQrImageForToilet,
  ensureAllQrImagesForToilet,
  ensureQrImagesForToilets,
};
