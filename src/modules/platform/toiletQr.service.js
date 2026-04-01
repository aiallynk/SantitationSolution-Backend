const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const QR_ROOT_DIR = path.join(process.cwd(), 'uploads', 'qr', 'toilets');

const normalizeId = (value) =>
  String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');

const toQrFileName = (toiletUnitId) => `${normalizeId(toiletUnitId) || 'toilet'}.png`;

const getQrAbsolutePath = (toiletUnitId) =>
  path.join(QR_ROOT_DIR, toQrFileName(toiletUnitId));

const getQrRelativePath = (toiletUnitId) =>
  `qr/toilets/${toQrFileName(toiletUnitId)}`;

const getQrImageUrl = (toiletUnitId) =>
  `/static/${getQrRelativePath(toiletUnitId)}`;

const ensureQrDirectory = async () => {
  await fs.promises.mkdir(QR_ROOT_DIR, { recursive: true });
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
  forceRegenerate = false,
}) => {
  const unitId = normalizeId(toiletUnitId);
  const qrValue = String(qrCodeValue || '').trim();
  if (!unitId || !qrValue) {
    return null;
  }

  await ensureQrDirectory();
  const targetPath = getQrAbsolutePath(unitId);
  const alreadyExists = await fileExists(targetPath);
  if (alreadyExists && !forceRegenerate) {
    return {
      qrImageUrl: getQrImageUrl(unitId),
      qrImagePath: targetPath,
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
    qrImageUrl: getQrImageUrl(unitId),
    qrImagePath: targetPath,
    existed: alreadyExists,
    generated: true,
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

  for (const row of rows) {
    const toiletUnitId = row?.toiletUnitId || row?.id || null;
    const qrCodeValue = row?.qrCodeValue || row?.qr_code || row?.code || null;
    try {
      const result = await ensureQrImageForToilet({
        toiletUnitId,
        qrCodeValue,
        forceRegenerate: Boolean(options.forceRegenerate),
      });
      if (!result) {
        failed += 1;
      } else if (result.generated) {
        generated += 1;
      } else {
        skipped += 1;
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
  };
};

module.exports = {
  getQrImageUrl,
  ensureQrImageForToilet,
  ensureQrImagesForToilets,
};
