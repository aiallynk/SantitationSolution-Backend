const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const QRCode = require('qrcode');
const { runtimeConfig } = require('../../config/runtime');

const QR_ROOT_DIR = path.join(process.cwd(), 'uploads', 'qr', 'facilities');
const QR_SCHEMA_VERSION = 'facility_qr_v1';

const getFacilityQrAbsolutePath = (facilityId) =>
  path.join(QR_ROOT_DIR, `${String(facilityId)}.png`);

const getFacilityQrRelativePath = (facilityId) => `qr/facilities/${String(facilityId)}.png`;

const getFacilityQrImageUrl = (facilityId) => `/uploads/${getFacilityQrRelativePath(facilityId)}`;

const ensureFacilityQrDirectory = async () => {
  await fs.mkdir(QR_ROOT_DIR, { recursive: true });
};

const hashFacilityQrToken = (token) =>
  crypto.createHash('sha256').update(String(token || '').trim()).digest('hex');

const buildFacilityQrToken = ({
  facilityId,
  tenantId,
  qrId,
  version = 1,
}) => {
  const nonce = crypto.randomBytes(18).toString('base64url');
  return ['fqr', version, tenantId || 'tenant', facilityId || 'facility', qrId || 'qr', nonce].join('.');
};

const buildFacilityQrResolveUrl = (token) => {
  const base =
    runtimeConfig.urls.apiPublicBaseUrl ||
    runtimeConfig.urls.publicFeedbackBaseUrl ||
    '';
  const suffix = `/api/v1/facilities/resolve?t=${encodeURIComponent(String(token || '').trim())}`;
  return base ? `${base}${suffix}` : suffix;
};

const ensureFacilityQrImage = async ({ facilityId, qrCodeValue }) => {
  const resolvedFacilityId = String(facilityId || '').trim();
  const qrValue = String(qrCodeValue || '').trim();
  if (!resolvedFacilityId || !qrValue) {
    throw new Error('facilityId and qrCodeValue are required');
  }

  await ensureFacilityQrDirectory();
  const targetPath = getFacilityQrAbsolutePath(resolvedFacilityId);
  await QRCode.toFile(targetPath, qrValue, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });

  return {
    qrImageUrl: getFacilityQrImageUrl(resolvedFacilityId),
    qrImagePath: targetPath,
  };
};

const buildFacilityPrintableLabel = ({
  facilityName,
  facilityCode,
  areaLabel,
  qrImageUrl,
}) => ({
  title: facilityName || 'Facility',
  code: facilityCode || null,
  area: areaLabel || null,
  qrImageUrl: qrImageUrl || null,
});

module.exports = {
  QR_SCHEMA_VERSION,
  buildFacilityPrintableLabel,
  buildFacilityQrResolveUrl,
  buildFacilityQrToken,
  ensureFacilityQrImage,
  getFacilityQrAbsolutePath,
  getFacilityQrImageUrl,
  getFacilityQrRelativePath,
  hashFacilityQrToken,
};
