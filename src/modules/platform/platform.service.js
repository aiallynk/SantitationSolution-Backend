const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const AppError = require('../../core/errors/AppError');
const {
  sequelize,
  Tenant,
  Geography,
  Facility,
  ToiletBlock,
  ToiletUnit,
  ToiletQrCode,
  WorkerAssignment,
} = require('../../models');
const { createAuditLog } = require('../audit/audit.service');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const {
  applyTenantScope,
  applyGeographyScope,
  applyFacilityScope,
  isFacilityInScope,
  isGeographyInScope,
} = require('../../core/rbac/scopeWhere');
const {
  getQrImageUrl,
  getFeedbackQrImageUrl,
  getPublicFeedbackUrl,
  ensureQrImageForToilet,
  ensureAllQrImagesForToilet,
  ensureQrImagesForToilets,
} = require('./toiletQr.service');

const tenantScope = (req, requestedTenantId) => {
  if (req.user.isSuperAdmin) {
    return requestedTenantId || null;
  }
  return req.user.tenantId;
};

const withTenantScope = (req, where = {}, tenantKey = 'tenant_id') => {
  return applyTenantScope(where, req, tenantKey);
};

const withGeographyScope = (req, where = {}, geographyKey = 'geography_id') => {
  return applyGeographyScope(where, req, geographyKey);
};

const withFacilityScope = (req, where = {}, facilityKey = 'facility_id') => {
  return applyFacilityScope(where, req, facilityKey);
};

const buildFacilityIncludeScopeWhere = (req) => {
  let where = {};
  where = withTenantScope(req, where);
  where = withGeographyScope(req, where);
  where = withFacilityScope(req, where, 'id');
  return where;
};

const normalizePermanentQrCode = (value) => {
  const text = sanitizeText(value, 180);
  if (!text) return '';
  return text.toUpperCase();
};

const QR_SCHEMA_V2 = 'v2';
const QR_V2_PREFIX = 'SANQR2';
const QR_V2_TOKEN_PATTERN =
  /^SANQR2:([0-9A-F-]{36}):([0-9A-F-]{36}):([0-9A-F-]{36}):([A-F0-9]{64})$/i;

const normalizeUuid = (value) => {
  const text = String(value || '').trim();
  if (!text || !isUuidLike(text)) return null;
  return text.toLowerCase();
};

const normalizeQrVersion = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;
  if (text === '2' || text === 'v2' || text === 'qr_v2') return QR_SCHEMA_V2;
  if (text === '1' || text === 'v1' || text === 'legacy' || text === 'legacy_v1') {
    return 'legacy_v1';
  }
  return text;
};

const resolveQrSigningSecret = () =>
  String(process.env.QR_V2_SIGNING_SECRET || process.env.JWT_SECRET || '').trim() ||
  'sanitation-qr-signing-secret';

const buildCanonicalQrSignatureInput = ({ version, toiletUnitId, tenantId, qrId }) =>
  [String(version || '').trim(), String(tenantId || '').trim(), String(toiletUnitId || '').trim(), String(qrId || '').trim()].join(
    '|'
  );

const signCanonicalQrPayload = ({ version, toiletUnitId, tenantId, qrId }) => {
  const input = buildCanonicalQrSignatureInput({
    version,
    toiletUnitId: normalizeUuid(toiletUnitId),
    tenantId: normalizeUuid(tenantId),
    qrId: normalizeUuid(qrId),
  });
  return crypto.createHmac('sha256', resolveQrSigningSecret()).update(input).digest('hex');
};

const buildCanonicalQrV2Payload = ({ toiletUnitId, tenantId, qrId = null }) => {
  const normalizedToiletUnitId = normalizeUuid(toiletUnitId);
  const normalizedTenantId = normalizeUuid(tenantId);
  const normalizedQrId = normalizeUuid(qrId || uuidv4());
  if (!normalizedToiletUnitId || !normalizedTenantId || !normalizedQrId) {
    throw new AppError('Unable to build canonical QR payload', 500, {
      code: 'QR_PAYLOAD_BUILD_FAILED',
    });
  }

  const signature = signCanonicalQrPayload({
    version: QR_SCHEMA_V2,
    toiletUnitId: normalizedToiletUnitId,
    tenantId: normalizedTenantId,
    qrId: normalizedQrId,
  });

  return {
    version: QR_SCHEMA_V2,
    toiletUnitId: normalizedToiletUnitId,
    tenantId: normalizedTenantId,
    qrId: normalizedQrId,
    signature,
  };
};

const encodeCanonicalQrV2Token = (payload = {}) => {
  const toiletUnitId = normalizeUuid(payload.toiletUnitId);
  const tenantId = normalizeUuid(payload.tenantId);
  const qrId = normalizeUuid(payload.qrId);
  const signature = String(payload.signature || '').trim().toUpperCase();
  if (!toiletUnitId || !tenantId || !qrId || !signature) {
    throw new AppError('Canonical QR payload is incomplete', 500, {
      code: 'QR_PAYLOAD_INVALID',
    });
  }

  return `${QR_V2_PREFIX}:${toiletUnitId.toUpperCase()}:${tenantId.toUpperCase()}:${qrId.toUpperCase()}:${signature}`;
};

const parseCanonicalQrV2Token = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(QR_V2_TOKEN_PATTERN);
  if (!match) return null;

  const parsed = {
    version: QR_SCHEMA_V2,
    toiletUnitId: normalizeUuid(match[1]),
    tenantId: normalizeUuid(match[2]),
    qrId: normalizeUuid(match[3]),
    signature: String(match[4] || '').trim().toLowerCase(),
  };
  if (!parsed.toiletUnitId || !parsed.tenantId || !parsed.qrId || !parsed.signature) {
    return null;
  }
  return parsed;
};

const tryParseCanonicalQrPayload = (rawValue) => {
  const raw = sanitizeText(rawValue, 800);
  if (!raw) {
    return {
      payload: null,
      explicitVersion: null,
    };
  }

  const tokenPayload = parseCanonicalQrV2Token(raw);
  if (tokenPayload) {
    return {
      payload: tokenPayload,
      explicitVersion: QR_SCHEMA_V2,
    };
  }

  try {
    const parsedJson = JSON.parse(raw);
    if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
      const explicitVersion = normalizeQrVersion(
        parsedJson.version || parsedJson.v || parsedJson.schemaVersion
      );
      const payload = {
        version: explicitVersion,
        toiletUnitId: normalizeUuid(parsedJson.toiletUnitId || parsedJson.toilet_unit_id),
        tenantId: normalizeUuid(parsedJson.tenantId || parsedJson.tenant_id),
        qrId: normalizeUuid(parsedJson.qrId || parsedJson.qr_id || parsedJson.id),
        signature: String(parsedJson.signature || parsedJson.sig || '').trim().toLowerCase() || null,
      };
      if (
        payload.version &&
        payload.toiletUnitId &&
        payload.tenantId &&
        payload.qrId &&
        payload.signature
      ) {
        return {
          payload,
          explicitVersion: payload.version,
        };
      }
      return {
        payload: null,
        explicitVersion,
      };
    }
  } catch (_) {
    // ignore non-JSON payload
  }

  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsedUrl = new URL(raw);
      const explicitVersion = normalizeQrVersion(
        parsedUrl.searchParams.get('version') ||
          parsedUrl.searchParams.get('v') ||
          parsedUrl.searchParams.get('schemaVersion')
      );
      const payload = {
        version: explicitVersion,
        toiletUnitId: normalizeUuid(
          parsedUrl.searchParams.get('toiletUnitId') ||
            parsedUrl.searchParams.get('toilet_unit_id') ||
            parsedUrl.searchParams.get('unitId')
        ),
        tenantId: normalizeUuid(
          parsedUrl.searchParams.get('tenantId') ||
            parsedUrl.searchParams.get('tenant_id')
        ),
        qrId: normalizeUuid(
          parsedUrl.searchParams.get('qrId') ||
            parsedUrl.searchParams.get('qr_id') ||
            parsedUrl.searchParams.get('id')
        ),
        signature:
          String(
            parsedUrl.searchParams.get('signature') || parsedUrl.searchParams.get('sig') || ''
          )
            .trim()
            .toLowerCase() || null,
      };

      if (
        payload.version &&
        payload.toiletUnitId &&
        payload.tenantId &&
        payload.qrId &&
        payload.signature
      ) {
        return {
          payload,
          explicitVersion: payload.version,
        };
      }
      return {
        payload: null,
        explicitVersion,
      };
    }
  } catch (_) {
    // ignore malformed URL QR payloads
  }

  const explicitVersion =
    raw.toUpperCase().startsWith('SANQR') && !raw.toUpperCase().startsWith(QR_V2_PREFIX)
      ? 'unsupported'
      : null;

  return {
    payload: null,
    explicitVersion,
  };
};

const validateCanonicalQrPayload = (payload) => {
  if (!payload) {
    return {
      valid: false,
      reasonCode: 'INVALID_QR_FORMAT',
      reason: 'Canonical payload not present',
    };
  }

  const version = normalizeQrVersion(payload.version);
  if (!version || version !== QR_SCHEMA_V2) {
    return {
      valid: false,
      reasonCode: 'QR_UNSUPPORTED_VERSION',
      reason: 'QR schema version is not supported',
    };
  }

  const toiletUnitId = normalizeUuid(payload.toiletUnitId);
  const tenantId = normalizeUuid(payload.tenantId);
  const qrId = normalizeUuid(payload.qrId);
  const signature = String(payload.signature || '').trim().toLowerCase();
  if (!toiletUnitId || !tenantId || !qrId || !signature) {
    return {
      valid: false,
      reasonCode: 'INVALID_QR_FORMAT',
      reason: 'Canonical payload fields missing',
    };
  }

  const expectedSignature = signCanonicalQrPayload({
    version,
    toiletUnitId,
    tenantId,
    qrId,
  });
  if (expectedSignature !== signature) {
    return {
      valid: false,
      reasonCode: 'INVALID_QR_FORMAT',
      reason: 'Canonical QR signature mismatch',
    };
  }

  return {
    valid: true,
    payload: {
      version,
      toiletUnitId,
      tenantId,
      qrId,
      signature,
    },
  };
};

const normalizeIdentifierPart = (value, fallback) => {
  const text = sanitizeText(value, 120);
  const normalized = text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const normalizeSectorCode = (value) => {
  const text = sanitizeText(value, 40)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return text || null;
};

const toOptionalCoordinate = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return numeric;
};

const buildAutoToiletId = async ({ facility, toiletBlock }) => {
  const facilityPart = normalizeIdentifierPart(
    facility.code || facility.name,
    'FAC'
  );
  const blockPart = normalizeIdentifierPart(toiletBlock.code || toiletBlock.name, 'BLK');
  const prefix = `${facilityPart}-${blockPart}-T`;

  const rows = await ToiletUnit.findAll({
    where: { toilet_block_id: toiletBlock.id },
    attributes: ['code'],
  });

  const usedCodes = new Set(
    rows
      .map((row) => String(row.code || '').toUpperCase())
      .filter(Boolean)
  );

  let sequence = 1;
  while (sequence <= 9999) {
    const candidate = `${prefix}${String(sequence).padStart(3, '0')}`;
    if (!usedCodes.has(candidate)) {
      return candidate;
    }
    sequence += 1;
  }

  throw new AppError('Unable to auto-generate toilet id. Capacity reached for block.', 409, {
    code: 'TOILET_ID_CAPACITY_REACHED',
  });
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuidLike = (value) => UUID_PATTERN.test(String(value || '').trim());

const extractQrCandidates = (rawValue) => {
  const raw = sanitizeText(rawValue, 600);
  if (!raw) return [];

  const candidateSet = new Set();
  const pushCandidate = (value) => {
    const text = sanitizeText(value, 240);
    if (!text) return;
    candidateSet.add(text);
  };
  const pushFromPathSegments = (segments = []) => {
    if (!Array.isArray(segments) || segments.length === 0) return;
    const last = String(segments[segments.length - 1] || '').trim();
    const previous = String(segments[segments.length - 2] || '').trim();
    if (last.toLowerCase() === 'report' && previous) {
      pushCandidate(previous);
    }
    if (last) {
      pushCandidate(last);
      if (last.toLowerCase().endsWith('.png') && last.length > 4) {
        pushCandidate(last.slice(0, -4));
      }
    }
  };

  pushCandidate(raw);
  if (raw.toLowerCase().endsWith('.png') && raw.length > 4) {
    pushCandidate(raw.slice(0, -4));
  }

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded && decoded !== raw) {
      pushCandidate(decoded);
    }
  } catch (_) {
    // ignore malformed URI components
  }

  try {
    const asJson = JSON.parse(raw);
    if (asJson && typeof asJson === 'object' && !Array.isArray(asJson)) {
      const keys = [
        'qr',
        'qrCode',
        'qr_code',
        'code',
        'toilet',
        'toiletCode',
        'toilet_code',
        'toiletUnitId',
        'toilet_unit_id',
        'id',
      ];
      for (const key of keys) {
        pushCandidate(asJson[key]);
      }
    }
  } catch (_) {
    // ignore non-JSON QR payloads
  }

  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      const segments = parsed.pathname
        .split('/')
        .map((segment) => sanitizeText(segment, 180))
        .filter(Boolean);
      pushFromPathSegments(segments);
      const paramKeys = [
        'qr',
        'qrCode',
        'qr_code',
        'code',
        'toilet',
        'toiletCode',
        'toilet_code',
        'toiletId',
        'toilet_id',
        'unitId',
        'unit_id',
        'toiletUnitId',
        'toilet_unit_id',
        'id',
      ];
      for (const key of paramKeys) {
        pushCandidate(parsed.searchParams.get(key));
      }
    }
  } catch (_) {
    // ignore malformed URLs
  }

  if (raw.includes('=')) {
    try {
      const params = new URLSearchParams(raw.replace(/;/g, '&'));
      const keys = [
        'qr',
        'qrCode',
        'qr_code',
        'code',
        'toilet',
        'toiletCode',
        'toilet_code',
        'toiletId',
        'toilet_id',
        'unitId',
        'unit_id',
        'toiletUnitId',
        'toilet_unit_id',
        'id',
      ];
      for (const key of keys) {
        pushCandidate(params.get(key));
      }
    } catch (_) {
      // ignore malformed key/value QR payloads
    }
  }

  if (raw.includes('/')) {
    const segments = raw
      .split('/')
      .map((item) => sanitizeText(item, 180))
      .filter(Boolean);
    pushFromPathSegments(segments);
  }

  if (raw.includes(':')) {
    const suffix = sanitizeText(raw.split(':').slice(1).join(':'), 180);
    pushCandidate(suffix);
  }

  const normalized = new Set();
  for (const item of candidateSet.values()) {
    const upper = normalizePermanentQrCode(item);
    if (!upper) continue;
    normalized.add(upper);
    if (upper.toLowerCase().endsWith('.png') && upper.length > 4) {
      normalized.add(upper.slice(0, -4));
    }
  }
  return Array.from(normalized.values());
};

const buildQrResolveWhere = (candidates = []) => {
  const exactOr = [];
  const fuzzyOr = [];
  for (const candidate of candidates.slice(0, 12)) {
    exactOr.push({ qr_code: { [Op.iLike]: candidate } });
    exactOr.push({ code: { [Op.iLike]: candidate } });
    if (isUuidLike(candidate)) {
      exactOr.push({ id: candidate.toLowerCase() });
    } else if (candidate.length >= 4) {
      fuzzyOr.push({ qr_code: { [Op.iLike]: `%${candidate}%` } });
      fuzzyOr.push({ code: { [Op.iLike]: `%${candidate}%` } });
    }
  }
  return {
    [Op.or]: [...exactOr, ...fuzzyOr.slice(0, 12)],
  };
};

const QR_RESOLVE_REASON_CODES = Object.freeze({
  INVALID_QR_FORMAT: 'INVALID_QR_FORMAT',
  QR_UNSUPPORTED_VERSION: 'QR_UNSUPPORTED_VERSION',
  QR_NOT_FOUND: 'QR_NOT_FOUND',
  TOILET_NOT_FOUND: 'TOILET_NOT_FOUND',
  TOILET_INACTIVE: 'TOILET_INACTIVE',
  TENANT_MISMATCH: 'TENANT_MISMATCH',
  ORG_MISMATCH: 'ORG_MISMATCH',
  ASSIGNMENT_MISSING: 'ASSIGNMENT_MISSING',
  WORKER_SCOPE_DENIED: 'WORKER_SCOPE_DENIED',
  SCOPE_REFRESH_RECOMMENDED: 'SCOPE_REFRESH_RECOMMENDED',
  QR_RESOLVED_SUCCESSFULLY: 'QR_RESOLVED_SUCCESSFULLY',
});

const QR_RESOLVE_MESSAGES = {
  [QR_RESOLVE_REASON_CODES.INVALID_QR_FORMAT]:
    'Invalid QR format. Please scan a valid toilet QR.',
  [QR_RESOLVE_REASON_CODES.QR_UNSUPPORTED_VERSION]:
    'This QR version is not supported by the app yet.',
  [QR_RESOLVE_REASON_CODES.QR_NOT_FOUND]:
    'This QR is not mapped to any toilet.',
  [QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND]:
    'Toilet not found for this QR.',
  [QR_RESOLVE_REASON_CODES.TOILET_INACTIVE]:
    'This toilet is inactive. Contact your supervisor.',
  [QR_RESOLVE_REASON_CODES.TENANT_MISMATCH]:
    'This QR belongs to another organization.',
  [QR_RESOLVE_REASON_CODES.ORG_MISMATCH]:
    'QR metadata does not match the mapped toilet.',
  [QR_RESOLVE_REASON_CODES.ASSIGNMENT_MISSING]:
    'You do not have an active assignment for this QR.',
  [QR_RESOLVE_REASON_CODES.WORKER_SCOPE_DENIED]:
    'QR recognized, but this toilet is not assigned to you.',
  [QR_RESOLVE_REASON_CODES.SCOPE_REFRESH_RECOMMENDED]:
    'Toilet resolved, but your assignment scope is stale. Refreshing assignments.',
  [QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY]:
    'Toilet QR resolved successfully.',
};

const logQrResolve = (req, level, payload = {}) => {
  const safePayload = {
    event: 'qr.resolve',
    requestId: req?.requestId || null,
    userId: req?.user?.id || null,
    tenantId: req?.user?.tenantId || null,
    ...payload,
  };
  const text = JSON.stringify(safePayload);
  if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(text);
    return;
  }
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(text);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(text);
};

const buildQrResolveResult = ({
  status = 'failed',
  reasonCode = QR_RESOLVE_REASON_CODES.QR_NOT_FOUND,
  rawQrValue = '',
  normalizedQrValue = '',
  parsed = {},
  toilet = null,
  details = null,
  scopeRefreshRecommended = false,
}) => ({
  status,
  resolved: status === 'resolved',
  reasonCode,
  message: QR_RESOLVE_MESSAGES[reasonCode] || 'Unable to resolve QR',
  rawQrValue: String(rawQrValue || ''),
  normalizedQrValue: String(normalizedQrValue || ''),
  parsed,
  toilet,
  details,
  scopeRefreshRecommended: Boolean(scopeRefreshRecommended),
});

const isToiletInactive = (row) => {
  const unitStatus = String(row?.status || '').trim().toLowerCase();
  const facilityStatus = String(row?.Facility?.status || '')
    .trim()
    .toLowerCase();
  if (facilityStatus && facilityStatus !== 'active') {
    return true;
  }
  return unitStatus === 'out_of_service' || unitStatus === 'inactive';
};

const extractLikelyIdentifier = (candidates = []) => {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const uuidCandidate = candidates.find((item) => isUuidLike(item));
  if (uuidCandidate) return uuidCandidate;
  return candidates[0] || null;
};

const findDuplicateExactMatchIds = (rows = [], candidates = []) => {
  const exactMatchedRows = rows.filter((row) => {
    const rowQr = normalizePermanentQrCode(row.qr_code || '');
    const rowCode = normalizePermanentQrCode(row.code || '');
    const rowId = String(row.id || '').trim().toLowerCase();
    return candidates.some((candidate) => {
      const normalizedCandidate = normalizePermanentQrCode(candidate);
      if (!normalizedCandidate) return false;
      if (rowQr === normalizedCandidate) return true;
      if (rowCode === normalizedCandidate) return true;
      if (isUuidLike(normalizedCandidate) && rowId === normalizedCandidate.toLowerCase()) {
        return true;
      }
      return false;
    });
  });
  return Array.from(
    new Set(exactMatchedRows.map((row) => String(row.id || '').trim()).filter(Boolean))
  );
};

const isPrivilegedRoleForQrResolve = (req) => {
  if (req?.user?.isSuperAdmin) return true;
  if (String(req?.user?.scopeLevel || '').toLowerCase() === 'organization') return true;

  const roleCodes = new Set(
    (Array.isArray(req?.user?.roleCodes) ? req.user.roleCodes : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (
    roleCodes.has('tenant_admin') ||
    roleCodes.has('platform_ops') ||
    roleCodes.has('supervisor') ||
    roleCodes.has('facility_manager')
  ) {
    return true;
  }

  const permissionCodes = new Set(
    (Array.isArray(req?.user?.permissionCodes) ? req.user.permissionCodes : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
  );
  return permissionCodes.has('inspection.review') || permissionCodes.has('task.manage');
};

const classifyResolvedToilet = ({ row, req }) => {
  if (!row) {
    return QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND;
  }
  if (isToiletInactive(row)) {
    return QR_RESOLVE_REASON_CODES.TOILET_INACTIVE;
  }
  if (!req?.user?.isSuperAdmin && req?.user?.tenantId && row?.Facility?.tenant_id) {
    if (String(req.user.tenantId) !== String(row.Facility.tenant_id)) {
      return QR_RESOLVE_REASON_CODES.TENANT_MISMATCH;
    }
  }
  if (!isFacilityInScope(req, row.facility_id || row.Facility?.id || null)) {
    return QR_RESOLVE_REASON_CODES.WORKER_SCOPE_DENIED;
  }
  return QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY;
};

const mapUnitRow = (row, options = {}) => {
  const resolvedQrCode = String(options.resolvedQrCode || row.qr_code || row.code || '').trim();
  const legacyQrCode = String(options.legacyQrCode || row.qr_code || row.code || '').trim();
  return {
    id: row.id,
    facilityId: row.facility_id,
    facilityCode: row.Facility?.code || null,
    facilityName: row.Facility?.name || null,
    toiletBlockId: row.toilet_block_id,
    code: row.code,
    qrId: options.qrId || null,
    qrSchemaVersion: options.qrSchemaVersion || null,
    qrCode: resolvedQrCode || legacyQrCode || null,
    appQrCode: resolvedQrCode || legacyQrCode || null,
    legacyQrCode: legacyQrCode || null,
    qrImageUrl: getQrImageUrl(row.id),
    appQrImageUrl: getQrImageUrl(row.id),
    feedbackQrImageUrl: getFeedbackQrImageUrl(row.id),
    publicFeedbackUrl: getPublicFeedbackUrl({ toiletUnitId: row.id }),
    unitType: row.unit_type,
    status: row.status,
    sectorCode:
      row.sector_code ||
      row.Facility?.metadata?.sector ||
      row.Facility?.metadata?.zone ||
      null,
    locationLabel:
      row.location_label ||
      row.Facility?.address_line ||
      row.Facility?.name ||
      null,
    latitude:
      row.latitude !== null && row.latitude !== undefined
        ? Number(row.latitude)
        : row.Facility?.latitude !== null && row.Facility?.latitude !== undefined
          ? Number(row.Facility.latitude)
          : null,
    longitude:
      row.longitude !== null && row.longitude !== undefined
        ? Number(row.longitude)
        : row.Facility?.longitude !== null && row.Facility?.longitude !== undefined
          ? Number(row.Facility.longitude)
          : null,
    latestScore:
      row.latest_score !== null && row.latest_score !== undefined
        ? Number(row.latest_score)
        : null,
    latestBeforeScore:
      row.latest_before_score !== null && row.latest_before_score !== undefined
        ? Number(row.latest_before_score)
        : null,
    latestAfterScore:
      row.latest_after_score !== null && row.latest_after_score !== undefined
        ? Number(row.latest_after_score)
        : null,
    avgBeforeScore:
      row.avg_before_score !== null && row.avg_before_score !== undefined
        ? Number(row.avg_before_score)
        : null,
    avgAfterScore:
      row.avg_after_score !== null && row.avg_after_score !== undefined
        ? Number(row.avg_after_score)
        : null,
    avgImprovementScore:
      row.avg_improvement_score !== null && row.avg_improvement_score !== undefined
        ? Number(row.avg_improvement_score)
        : null,
    totalInspections: Number(row.total_inspections || 0),
    lastInspectionAt: row.last_inspection_at || null,
    dirtyFrequency:
      row.dirty_frequency !== null && row.dirty_frequency !== undefined
        ? Number(row.dirty_frequency)
        : 0,
    lowPerformanceFrequency:
      row.low_performance_frequency !== null && row.low_performance_frequency !== undefined
        ? Number(row.low_performance_frequency)
        : 0,
  };
};

const loadPrimaryQrMapForToiletIds = async (toiletIds = [], { transaction = null } = {}) => {
  const ids = Array.from(
    new Set(
      (Array.isArray(toiletIds) ? toiletIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
  if (ids.length === 0) return new Map();

  const rows = await ToiletQrCode.findAll({
    where: {
      toilet_unit_id: { [Op.in]: ids },
      status: 'active',
      is_primary: true,
    },
    attributes: ['id', 'toilet_unit_id', 'qr_code', 'schema_version'],
    transaction,
  });
  const map = new Map();
  for (const row of rows) {
    map.set(String(row.toilet_unit_id), row);
  }
  return map;
};

const scoreCandidateMatch = (row, candidates = []) => {
  const qr = normalizePermanentQrCode(row.qr_code || '');
  const code = normalizePermanentQrCode(row.code || '');
  const id = String(row.id || '').trim().toLowerCase();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = normalizePermanentQrCode(candidates[index]);
    if (!candidate) continue;
    if (qr && qr === candidate) return 1000 - index;
    if (code && code === candidate) return 900 - index;
    if (isUuidLike(candidate) && id === candidate.toLowerCase()) return 1100 - index;
    if (qr && qr.includes(candidate)) return 500 - index;
    if (code && code.includes(candidate)) return 450 - index;
  }
  return 0;
};

const scoreQrRecordMatch = (row, candidates = []) => {
  const qr = normalizePermanentQrCode(row.qr_code || '');
  const qrId = String(row.id || '').trim().toLowerCase();
  const toiletUnitId = String(row.toilet_unit_id || '').trim().toLowerCase();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = normalizePermanentQrCode(candidates[index]);
    if (!candidate) continue;
    if (qr && qr === candidate) return 1400 - index;
    if (isUuidLike(candidate) && qrId === candidate.toLowerCase()) return 1350 - index;
    if (isUuidLike(candidate) && toiletUnitId === candidate.toLowerCase()) return 1300 - index;
    if (qr && qr.includes(candidate)) return 900 - index;
  }
  return 0;
};

const resolveAssignmentAuthorization = async ({ req, row }) => {
  if (!row) {
    return {
      allowed: false,
      reasonCode: QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND,
      details: null,
      scopeRefreshRecommended: false,
    };
  }

  if (req?.user?.isSuperAdmin) {
    return {
      allowed: true,
      reasonCode: QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY,
      details: {
        mode: 'super_admin',
      },
      scopeRefreshRecommended: false,
    };
  }

  const rowTenantId = String(row.Facility?.tenant_id || '').trim();
  const userTenantId = String(req?.user?.tenantId || '').trim();
  if (rowTenantId && userTenantId && rowTenantId !== userTenantId) {
    return {
      allowed: false,
      reasonCode: QR_RESOLVE_REASON_CODES.TENANT_MISMATCH,
      details: {
        toiletTenantId: rowTenantId,
        userTenantId,
      },
      scopeRefreshRecommended: false,
    };
  }

  const privilegedRole = isPrivilegedRoleForQrResolve(req);
  const assignments = await WorkerAssignment.findAll({
    where: {
      user_id: req?.user?.id || null,
      tenant_id: rowTenantId || userTenantId || null,
      status: 'active',
    },
    attributes: ['id', 'assignment_level', 'geography_id', 'facility_id', 'toilet_unit_id'],
  });

  const facilityId = String(row.facility_id || row.Facility?.id || '').trim();
  const toiletId = String(row.id || '').trim();
  const geographyId = String(row.Facility?.geography_id || '').trim();

  const matchedAssignment = assignments.find((assignment) => {
    const level = String(assignment.assignment_level || '').trim().toLowerCase();
    if (level === 'tenant') return true;
    if (level === 'toilet_unit') {
      return (
        String(assignment.toilet_unit_id || '').trim() === toiletId
      );
    }
    if (level === 'facility') {
      return (
        String(assignment.facility_id || '').trim() === facilityId
      );
    }
    if (level === 'geography') {
      return (
        geographyId &&
        String(assignment.geography_id || '').trim() === geographyId
      );
    }
    // legacy rows without assignment_level fallback
    if (String(assignment.toilet_unit_id || '').trim() === toiletId) return true;
    if (String(assignment.facility_id || '').trim() === facilityId) return true;
    if (geographyId && String(assignment.geography_id || '').trim() === geographyId) return true;
    return false;
  });

  if (!matchedAssignment && assignments.length === 0 && !privilegedRole) {
    return {
      allowed: false,
      reasonCode: QR_RESOLVE_REASON_CODES.ASSIGNMENT_MISSING,
      details: {
        workerId: req?.user?.id || null,
      },
      scopeRefreshRecommended: false,
    };
  }

  if (!matchedAssignment && !privilegedRole) {
    return {
      allowed: false,
      reasonCode: QR_RESOLVE_REASON_CODES.WORKER_SCOPE_DENIED,
      details: {
        workerId: req?.user?.id || null,
        assignmentCount: assignments.length,
      },
      scopeRefreshRecommended: false,
    };
  }

  const tokenScopeAllowed = isFacilityInScope(req, facilityId || null);
  return {
    allowed: true,
    reasonCode: tokenScopeAllowed
      ? QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY
      : QR_RESOLVE_REASON_CODES.SCOPE_REFRESH_RECOMMENDED,
    details: {
      mode: matchedAssignment ? 'assignment_match' : 'privileged_role',
      assignmentId: matchedAssignment?.id || null,
      assignmentLevel: matchedAssignment?.assignment_level || null,
      tokenScopeAllowed,
    },
    scopeRefreshRecommended: !tokenScopeAllowed,
  };
};

const loadQrMappedRowsByCandidates = async ({ candidates = [] }) => {
  const normalizedCandidates = Array.from(
    new Set(
      (Array.isArray(candidates) ? candidates : [])
        .map((candidate) => normalizePermanentQrCode(candidate))
        .filter(Boolean)
    )
  ).slice(0, 24);
  if (normalizedCandidates.length === 0) return [];

  const idRows = await sequelize.query(
    `
      SELECT q.id
      FROM toilet_qr_codes q
      WHERE q.status = 'active'
        AND UPPER(TRIM(q.qr_code)) = ANY(:candidateCodes)
      ORDER BY q.is_primary DESC, q.created_at DESC
      LIMIT 60
    `,
    {
      replacements: { candidateCodes: normalizedCandidates },
      type: QueryTypes.SELECT,
    }
  );
  const qrIds = idRows.map((row) => String(row.id || '').trim()).filter(Boolean);
  if (qrIds.length === 0) return [];

  return ToiletQrCode.findAll({
    where: { id: { [Op.in]: qrIds }, status: 'active' },
    include: [
      {
        model: ToiletUnit,
        as: 'toiletUnit',
        required: false,
        include: [
          {
            model: Facility,
            attributes: [
              'id',
              'tenant_id',
              'geography_id',
              'code',
              'name',
              'address_line',
              'latitude',
              'longitude',
              'metadata',
              'status',
            ],
            required: false,
          },
        ],
      },
    ],
    order: [['is_primary', 'DESC'], ['created_at', 'DESC']],
  });
};

const loadLegacyToiletRowsByCandidates = async ({ candidates = [] }) => {
  const normalizedCandidates = Array.from(
    new Set(
      (Array.isArray(candidates) ? candidates : [])
        .map((candidate) => normalizePermanentQrCode(candidate))
        .filter(Boolean)
    )
  ).slice(0, 12);
  if (normalizedCandidates.length === 0) return [];

  const where = buildQrResolveWhere(normalizedCandidates);
  return ToiletUnit.findAll({
    where,
    include: [
      {
        model: Facility,
        attributes: [
          'id',
          'tenant_id',
          'geography_id',
          'code',
          'name',
          'address_line',
          'latitude',
          'longitude',
          'metadata',
          'status',
        ],
        required: true,
      },
    ],
    limit: 40,
    order: [['code', 'ASC']],
  });
};

const resolveToiletFromQr = async ({
  req,
  rawQrValue,
  normalizedQrValue = '',
  workerContext = {},
}) => {
  const rawInput = sanitizeText(rawQrValue, 800);
  const normalizedInput = normalizePermanentQrCode(normalizedQrValue || rawInput);
  const candidateSource = normalizedQrValue || rawInput;
  const candidates = extractQrCandidates(candidateSource);
  const canonical = tryParseCanonicalQrPayload(rawInput);
  const canonicalValidation = canonical.payload ? validateCanonicalQrPayload(canonical.payload) : null;
  const canonicalPayload = canonicalValidation?.valid ? canonicalValidation.payload : null;
  if (canonicalPayload) {
    candidates.unshift(encodeCanonicalQrV2Token(canonicalPayload));
  }
  const uniqueCandidates = Array.from(new Set(candidates)).slice(0, 24);

  const parsedMeta = {
    extractedIdentifier: extractLikelyIdentifier(uniqueCandidates),
    candidates: uniqueCandidates,
    canonicalPayload: canonicalPayload
      ? {
          version: canonicalPayload.version,
          toiletUnitId: canonicalPayload.toiletUnitId,
          tenantId: canonicalPayload.tenantId,
          qrId: canonicalPayload.qrId,
        }
      : null,
  };

  logQrResolve(req, 'info', {
    stage: 'received',
    rawQrValue: rawInput,
    normalizedQrValue: normalizedInput,
    parsed: parsedMeta,
    workerContext,
  });

  if (!rawInput || uniqueCandidates.length === 0) {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.INVALID_QR_FORMAT,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
    });
  }

  if (canonical.payload && canonicalValidation && !canonicalValidation.valid) {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: canonicalValidation.reasonCode || QR_RESOLVE_REASON_CODES.INVALID_QR_FORMAT,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: { reason: canonicalValidation.reason || null },
    });
  }

  if (!canonical.payload && canonical.explicitVersion && canonical.explicitVersion !== 'legacy_v1') {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.QR_UNSUPPORTED_VERSION,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: {
        detectedVersion: canonical.explicitVersion,
      },
    });
  }

  let selectedQr = null;
  let selectedToilet = null;
  let lookupPath = null;

  if (canonicalPayload?.qrId) {
    const qrRow = await ToiletQrCode.findOne({
      where: { id: canonicalPayload.qrId, status: 'active' },
      include: [
        {
          model: ToiletUnit,
          as: 'toiletUnit',
          required: false,
          include: [
            {
              model: Facility,
              attributes: [
                'id',
                'tenant_id',
                'geography_id',
                'code',
                'name',
                'address_line',
                'latitude',
                'longitude',
                'metadata',
                'status',
              ],
              required: false,
            },
          ],
        },
      ],
    });
    if (qrRow) {
      selectedQr = qrRow;
      selectedToilet = qrRow.toiletUnit || null;
      lookupPath = 'toilet_qr_codes.id';
    }
  }

  if (!selectedQr) {
    const qrRows = await loadQrMappedRowsByCandidates({ candidates: uniqueCandidates });
    if (qrRows.length > 0) {
      selectedQr = [...qrRows].sort(
        (left, right) => scoreQrRecordMatch(right, uniqueCandidates) - scoreQrRecordMatch(left, uniqueCandidates)
      )[0];
      selectedToilet = selectedQr?.toiletUnit || null;
      lookupPath = 'toilet_qr_codes.qr_code';
    }
  }

  if (!selectedToilet) {
    const legacyRows = await loadLegacyToiletRowsByCandidates({ candidates: uniqueCandidates });
    if (legacyRows.length > 0) {
      selectedToilet = [...legacyRows].sort(
        (left, right) => scoreCandidateMatch(right, uniqueCandidates) - scoreCandidateMatch(left, uniqueCandidates)
      )[0];
      lookupPath = 'toilet_units.legacy_lookup';
    }
  }

  logQrResolve(req, 'info', {
    stage: 'db_lookup',
    lookupPath: lookupPath || 'none',
    candidateCount: uniqueCandidates.length,
    qrId: selectedQr?.id || null,
    matchedToiletId: selectedToilet?.id || null,
  });

  if (canonicalPayload && selectedQr) {
    if (canonicalPayload.toiletUnitId !== String(selectedQr.toilet_unit_id || '').trim().toLowerCase()) {
      return buildQrResolveResult({
        status: 'failed',
        reasonCode: QR_RESOLVE_REASON_CODES.ORG_MISMATCH,
        rawQrValue: rawInput,
        normalizedQrValue: normalizedInput,
        parsed: parsedMeta,
        details: {
          expectedToiletUnitId: canonicalPayload.toiletUnitId,
          mappedToiletUnitId: selectedQr.toilet_unit_id || null,
        },
      });
    }
    if (canonicalPayload.tenantId && selectedQr.tenant_id) {
      if (canonicalPayload.tenantId !== String(selectedQr.tenant_id).trim().toLowerCase()) {
        return buildQrResolveResult({
          status: 'failed',
          reasonCode: QR_RESOLVE_REASON_CODES.ORG_MISMATCH,
          rawQrValue: rawInput,
          normalizedQrValue: normalizedInput,
          parsed: parsedMeta,
          details: {
            expectedTenantId: canonicalPayload.tenantId,
            mappedTenantId: selectedQr.tenant_id || null,
          },
        });
      }
    }
  }

  if (!selectedToilet) {
    const reasonCode =
      parsedMeta.extractedIdentifier && isUuidLike(parsedMeta.extractedIdentifier)
        ? QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND
        : QR_RESOLVE_REASON_CODES.QR_NOT_FOUND;
    return buildQrResolveResult({
      status: 'failed',
      reasonCode,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
    });
  }

  if (isToiletInactive(selectedToilet)) {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.TOILET_INACTIVE,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: {
        toiletUnitId: selectedToilet.id,
        unitStatus: selectedToilet.status,
        facilityStatus: selectedToilet.Facility?.status || null,
      },
    });
  }

  const auth = await resolveAssignmentAuthorization({
    req,
    row: selectedToilet,
  });
  if (!auth.allowed) {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: auth.reasonCode || QR_RESOLVE_REASON_CODES.WORKER_SCOPE_DENIED,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: auth.details || null,
    });
  }

  const resolvedQrCode = selectedQr?.qr_code || selectedToilet.qr_code || selectedToilet.code;
  await ensureQrImageForToilet({
    toiletUnitId: selectedToilet.id,
    qrCodeValue: resolvedQrCode,
  }).catch(() => null);
  await ensureQrImageForToilet({
    toiletUnitId: selectedToilet.id,
    qrCodeValue: getPublicFeedbackUrl({ toiletUnitId: selectedToilet.id }),
    variant: 'feedback',
  }).catch(() => null);

  const toilet = mapUnitRow(selectedToilet, {
    resolvedQrCode,
    legacyQrCode: selectedToilet.qr_code || selectedToilet.code,
    qrId: selectedQr?.id || canonicalPayload?.qrId || null,
    qrSchemaVersion: selectedQr?.schema_version || canonicalPayload?.version || null,
  });

  const successReasonCode = auth.scopeRefreshRecommended
    ? QR_RESOLVE_REASON_CODES.SCOPE_REFRESH_RECOMMENDED
    : QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY;
  logQrResolve(req, 'info', {
    stage: 'resolved',
    reasonCode: successReasonCode,
    matchedToiletId: toilet.id,
    matchedFacilityId: toilet.facilityId,
    scopeRefreshRecommended: Boolean(auth.scopeRefreshRecommended),
  });

  return buildQrResolveResult({
    status: 'resolved',
    reasonCode: successReasonCode,
    rawQrValue: rawInput,
    normalizedQrValue: normalizedInput,
    parsed: parsedMeta,
    toilet,
    details: {
      lookupPath,
      qrId: selectedQr?.id || canonicalPayload?.qrId || null,
      qrSchemaVersion: selectedQr?.schema_version || canonicalPayload?.version || null,
      scopeRefreshRecommended: Boolean(auth.scopeRefreshRecommended),
      authorization: auth.details || null,
    },
    scopeRefreshRecommended: Boolean(auth.scopeRefreshRecommended),
  });
};

const resolveUnitByQrDetailed = async (req) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rawInput =
    body.rawQrValue ||
    req.query.rawQrValue ||
    req.query.qr ||
    req.query.qrCode ||
    req.query.code ||
    '';
  const normalizedInput =
    body.normalizedQrValue || req.query.normalizedQrValue || '';
  const workerContext = {
    workerId: body.workerId || req.user?.id || null,
    tenantId: body.tenantId || req.user?.tenantId || null,
    siteId: body.siteId || null,
    scannedAt: body.scannedAt || new Date().toISOString(),
  };
  return resolveToiletFromQr({
    req,
    rawQrValue: rawInput,
    normalizedQrValue: normalizedInput,
    workerContext,
  });
};

const resolveUnitByQr = async (req) => {
  const detailed = await resolveUnitByQrDetailed(req);
  if (req.method === 'POST') {
    return detailed;
  }
  const includeMeta =
    String(req.query.includeMeta || '').trim().toLowerCase() === 'true';
  if (includeMeta) {
    return detailed;
  }
  return detailed.resolved ? detailed.toilet : null;
};

const listTenants = async (req) => {
  const where = {};
  if (!req.user.isSuperAdmin) {
    where.id = req.user.tenantId;
  }
  const tenants = await Tenant.findAll({
    where,
    order: [['name', 'ASC']],
  });
  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    code: tenant.code,
    status: tenant.status,
    countryCode: tenant.country_code,
  }));
};

const createTenant = async (req) => {
  if (!req.user.isSuperAdmin) {
    throw new AppError('Only super admins can create tenants', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  const tenant = await Tenant.create({
    name: sanitizeText(req.body.name, 200),
    code: sanitizeText(req.body.code, 120),
    status: req.body.status || 'active',
    country_code: req.body.countryCode || null,
    metadata: req.body.metadata || null,
  });
  await createAuditLog({
    req,
    action: 'tenant.create',
    entityType: 'tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
  });
  return tenant;
};

const patchTenant = async (req) => {
  if (!req.user.isSuperAdmin) {
    throw new AppError('Only super admins can update tenants', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  const tenant = await Tenant.findByPk(req.params.id);
  if (!tenant) {
    throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }
  await tenant.update({
    name: req.body.name ? sanitizeText(req.body.name, 200) : tenant.name,
    status: req.body.status || tenant.status,
    country_code: req.body.countryCode || tenant.country_code,
    metadata: req.body.metadata ?? tenant.metadata,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'tenant.update',
    entityType: 'tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
  });
  return tenant;
};

const buildGeographyTree = (rows) => {
  const map = new Map(rows.map((row) => [row.id, { ...row, children: [] }]));
  const roots = [];
  for (const row of map.values()) {
    if (row.parentId && map.has(row.parentId)) {
      map.get(row.parentId).children.push(row);
    } else {
      roots.push(row);
    }
  }
  return roots;
};

const listGeographyTree = async (req) => {
  const tenantId = tenantScope(req, req.query.tenantId);
  let where = tenantId ? { tenant_id: tenantId } : {};
  where = withGeographyScope(req, where);
  const rows = await Geography.findAll({
    where,
    order: [['level', 'ASC'], ['name', 'ASC']],
  });
  const mapped = rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    tenantId: row.tenant_id,
    level: row.level,
    code: row.code,
    name: row.name,
  }));
  return buildGeographyTree(mapped);
};

const createGeography = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  if (!tenantId) {
    throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  }
  if (req.body.parentId && !isGeographyInScope(req, req.body.parentId)) {
    throw new AppError('parentId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const row = await Geography.create({
    tenant_id: tenantId,
    parent_id: req.body.parentId || null,
    level: req.body.level,
    code: sanitizeText(req.body.code, 120),
    name: sanitizeText(req.body.name, 200),
    centroid_latitude: req.body.centroidLatitude ?? null,
    centroid_longitude: req.body.centroidLongitude ?? null,
  });
  await createAuditLog({
    req,
    action: 'geography.create',
    entityType: 'geography',
    entityId: row.id,
    tenantId,
  });
  return row;
};

const listFacilities = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  let where = {};
  const tenantId = tenantScope(req, req.query.tenantId);
  if (tenantId) {
    where.tenant_id = tenantId;
  }
  where = withGeographyScope(req, where);
  where = withFacilityScope(req, where, 'id');
  if (req.query.geographyId) {
    if (!isGeographyInScope(req, req.query.geographyId)) {
      throw new AppError('geographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.geography_id = req.query.geographyId;
  }
  if (req.query.search) {
    const q = sanitizeText(req.query.search, 120);
    where[Op.or] = [
      { name: { [Op.iLike]: `%${q}%` } },
      { code: { [Op.iLike]: `%${q}%` } },
    ];
  }

  const { rows, count } = await Facility.findAndCountAll({
    where,
    order: [['name', 'ASC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      geographyId: row.geography_id,
      code: row.code,
      name: row.name,
      facilityType: row.facility_type,
      addressLine: row.address_line,
      latitude: row.latitude,
      longitude: row.longitude,
      status: row.status,
      metadata: row.metadata,
    })),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const createFacility = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  if (!tenantId) {
    throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  }
  if (req.body.geographyId && !isGeographyInScope(req, req.body.geographyId)) {
    throw new AppError('geographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const facility = await Facility.create({
    tenant_id: tenantId,
    geography_id: req.body.geographyId || null,
    code: sanitizeText(req.body.code, 120),
    name: sanitizeText(req.body.name, 220),
    facility_type: sanitizeText(req.body.facilityType, 80),
    address_line: req.body.addressLine ? sanitizeText(req.body.addressLine, 300) : null,
    latitude: req.body.latitude ?? null,
    longitude: req.body.longitude ?? null,
    status: req.body.status || 'active',
    metadata: req.body.metadata || null,
  });
  await createAuditLog({
    req,
    action: 'facility.create',
    entityType: 'facility',
    entityId: facility.id,
    tenantId,
  });
  return facility;
};

const patchFacility = async (req) => {
  const facility = await Facility.findByPk(req.params.id);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (req.body.geographyId && !isGeographyInScope(req, req.body.geographyId)) {
    throw new AppError('geographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  await facility.update({
    geography_id: req.body.geographyId ?? facility.geography_id,
    name: req.body.name ? sanitizeText(req.body.name, 220) : facility.name,
    facility_type: req.body.facilityType || facility.facility_type,
    address_line: req.body.addressLine ?? facility.address_line,
    latitude: req.body.latitude ?? facility.latitude,
    longitude: req.body.longitude ?? facility.longitude,
    status: req.body.status || facility.status,
    metadata: req.body.metadata ?? facility.metadata,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'facility.update',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
  });
  return facility;
};

const getFacilityById = async (req) => {
  const facility = await Facility.findByPk(req.params.id);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const [blocks, units] = await Promise.all([
    ToiletBlock.findAll({ where: { facility_id: facility.id }, order: [['name', 'ASC']] }),
    ToiletUnit.findAll({ where: { facility_id: facility.id }, order: [['code', 'ASC']] }),
  ]);
  await ensureQrImagesForToilets(units).catch(() => null);

  return {
    id: facility.id,
    tenantId: facility.tenant_id,
    geographyId: facility.geography_id,
    code: facility.code,
    name: facility.name,
    facilityType: facility.facility_type,
    addressLine: facility.address_line,
    latitude: facility.latitude,
    longitude: facility.longitude,
    status: facility.status,
    metadata: facility.metadata,
    blocks: blocks.map((block) => ({
      id: block.id,
      code: block.code,
      name: block.name,
      genderType: block.gender_type,
      status: block.status,
    })),
    units: units.map((unit) => ({
      id: unit.id,
      code: unit.code,
      qrCode: unit.qr_code || unit.code,
      appQrCode: unit.qr_code || unit.code,
      qrImageUrl: getQrImageUrl(unit.id),
      appQrImageUrl: getQrImageUrl(unit.id),
      feedbackQrImageUrl: getFeedbackQrImageUrl(unit.id),
      publicFeedbackUrl: getPublicFeedbackUrl({ toiletUnitId: unit.id }),
      unitType: unit.unit_type,
      status: unit.status,
      toiletBlockId: unit.toilet_block_id,
      sectorCode: unit.sector_code || null,
      locationLabel: unit.location_label || null,
      latitude:
        unit.latitude !== null && unit.latitude !== undefined
          ? Number(unit.latitude)
          : null,
      longitude:
        unit.longitude !== null && unit.longitude !== undefined
          ? Number(unit.longitude)
          : null,
    })),
  };
};

const listBlocks = async (req) => {
  const where = {};
  const facilityInclude = {
    model: Facility,
    attributes: ['id', 'tenant_id'],
    required: true,
  };
  facilityInclude.where = buildFacilityIncludeScopeWhere(req);
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('facilityId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }
  const rows = await ToiletBlock.findAll({
    where,
    include: [facilityInclude],
    order: [['name', 'ASC']],
  });
  return rows.map((row) => ({
    id: row.id,
    facilityId: row.facility_id,
    code: row.code,
    name: row.name,
    genderType: row.gender_type,
    status: row.status,
  }));
};

const createBlock = async (req) => {
  const facility = await Facility.findByPk(req.body.facilityId);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const row = await ToiletBlock.create({
    facility_id: facility.id,
    code: sanitizeText(req.body.code, 120),
    name: sanitizeText(req.body.name, 200),
    gender_type: req.body.genderType || null,
    status: req.body.status || 'active',
  });
  await createAuditLog({
    req,
    action: 'toilet_block.create',
    entityType: 'toilet_block',
    entityId: row.id,
    tenantId: facility.tenant_id,
  });
  return row;
};

const listUnits = async (req) => {
  const where = {};
  const facilityInclude = {
    model: Facility,
    attributes: [
      'id',
      'tenant_id',
      'code',
      'name',
      'address_line',
      'latitude',
      'longitude',
      'metadata',
    ],
    required: true,
  };
  facilityInclude.where = buildFacilityIncludeScopeWhere(req);
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('facilityId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }
  if (req.query.toiletBlockId) {
    where.toilet_block_id = req.query.toiletBlockId;
  }
  if (req.query.sector) {
    const normalizedSector = normalizeSectorCode(req.query.sector);
    if (normalizedSector) {
      where.sector_code = normalizedSector;
    }
  }
  if (req.query.qrCode) {
    const qrCode = normalizePermanentQrCode(req.query.qrCode);
    where[Op.or] = [
      { qr_code: { [Op.iLike]: qrCode } },
      { code: { [Op.iLike]: qrCode } },
    ];
  }
  const rows = await ToiletUnit.findAll({
    where,
    include: [facilityInclude],
    order: [['code', 'ASC']],
  });
  const primaryQrMap = await loadPrimaryQrMapForToiletIds(rows.map((row) => row.id));
  const qrImageSeedRows = rows.map((row) => ({
    id: row.id,
    qr_code: primaryQrMap.get(String(row.id))?.qr_code || row.qr_code || row.code,
    publicFeedbackUrl: getPublicFeedbackUrl({ toiletUnitId: row.id }),
  }));
  await ensureQrImagesForToilets(qrImageSeedRows).catch(() => null);
  return rows.map((row) => {
    const primaryQr = primaryQrMap.get(String(row.id)) || null;
    return mapUnitRow(row, {
      resolvedQrCode: primaryQr?.qr_code || row.qr_code || row.code,
      legacyQrCode: row.qr_code || row.code,
      qrId: primaryQr?.id || null,
      qrSchemaVersion: primaryQr?.schema_version || null,
    });
  });
};

const createUnit = async (req) => {
  const requestedCode = sanitizeText(req.body.code, 120);
  const unitType = sanitizeText(req.body.unitType, 40);

  const findQrCodeConflict = async ({ normalizedCode, transaction }) => {
    const rows = await sequelize.query(
      `
        SELECT q.id, q.toilet_unit_id
        FROM toilet_qr_codes q
        WHERE UPPER(TRIM(q.qr_code)) = :normalizedCode
        LIMIT 1
      `,
      {
        replacements: { normalizedCode },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    return rows[0] || null;
  };

  const createResult = await sequelize.transaction(async (transaction) => {
    const facility = await Facility.findByPk(req.body.facilityId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!facility) {
      throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
    }
    if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
      throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    if (!isFacilityInScope(req, facility.id)) {
      throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }

    const toiletBlock = await ToiletBlock.findByPk(req.body.toiletBlockId, {
      attributes: ['id', 'facility_id'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!toiletBlock) {
      throw new AppError('Toilet block not found', 404, { code: 'TOILET_BLOCK_NOT_FOUND' });
    }
    if (toiletBlock.facility_id !== facility.id) {
      throw new AppError('toiletBlockId does not belong to facilityId', 400, {
        code: 'BLOCK_FACILITY_MISMATCH',
      });
    }

    const unitCode = requestedCode
      ? requestedCode.toUpperCase()
      : await buildAutoToiletId({ facility, toiletBlock });

    const legacyQrCode = normalizePermanentQrCode(
      req.body.permanentQrCode || req.body.qrCode || unitCode
    );

    const duplicateCode = await ToiletUnit.findOne({
      where: {
        facility_id: facility.id,
        code: unitCode,
      },
      attributes: ['id'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (duplicateCode) {
      throw new AppError('Toilet unit code already exists in this facility', 409, {
        code: 'TOILET_UNIT_CODE_EXISTS',
      });
    }

    const duplicateQr = await ToiletUnit.findOne({
      where: { qr_code: legacyQrCode },
      attributes: ['id'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (duplicateQr) {
      throw new AppError('permanentQrCode already exists', 409, { code: 'QR_CODE_EXISTS' });
    }

    const row = await ToiletUnit.create(
      {
        facility_id: facility.id,
        toilet_block_id: toiletBlock.id,
        code: unitCode,
        qr_code: legacyQrCode,
        unit_type: unitType,
        status: req.body.status || 'moderate',
        sector_code: normalizeSectorCode(
          req.body.sectorCode || req.body.sector || facility.metadata?.sector || null
        ),
        location_label: req.body.locationLabel
          ? sanitizeText(req.body.locationLabel, 300)
          : facility.address_line || facility.name,
        latitude: toOptionalCoordinate(req.body.latitude ?? facility.latitude),
        longitude: toOptionalCoordinate(req.body.longitude ?? facility.longitude),
      },
      { transaction }
    );

    const canonicalPayload = buildCanonicalQrV2Payload({
      toiletUnitId: row.id,
      tenantId: facility.tenant_id,
    });
    const canonicalQrCode = encodeCanonicalQrV2Token(canonicalPayload);
    const canonicalNormalized = normalizePermanentQrCode(canonicalQrCode);
    const canonicalConflict = await findQrCodeConflict({
      normalizedCode: canonicalNormalized,
      transaction,
    });
    if (canonicalConflict && String(canonicalConflict.toilet_unit_id) !== String(row.id)) {
      throw new AppError('Canonical QR value collision detected', 409, {
        code: 'QR_CODE_EXISTS',
      });
    }

    await ToiletQrCode.create(
      {
        id: canonicalPayload.qrId,
        tenant_id: facility.tenant_id,
        toilet_unit_id: row.id,
        qr_code: canonicalQrCode,
        schema_version: QR_SCHEMA_V2,
        qr_payload: canonicalPayload,
        status: 'active',
        is_primary: true,
        created_by_user_id: req.user?.id || null,
        updated_by_user_id: req.user?.id || null,
      },
      { transaction }
    );

    const createAliasIfAvailable = async ({ qrCode, schemaVersion, payload }) => {
      const normalized = normalizePermanentQrCode(qrCode);
      if (!normalized) return;
      const existing = await findQrCodeConflict({
        normalizedCode: normalized,
        transaction,
      });
      if (existing && String(existing.toilet_unit_id) !== String(row.id)) {
        return;
      }
      if (existing) {
        return;
      }
      await ToiletQrCode.create(
        {
          tenant_id: facility.tenant_id,
          toilet_unit_id: row.id,
          qr_code: normalized,
          schema_version: schemaVersion,
          qr_payload: payload || null,
          status: 'active',
          is_primary: false,
          created_by_user_id: req.user?.id || null,
          updated_by_user_id: req.user?.id || null,
        },
        { transaction }
      );
    };

    await createAliasIfAvailable({
      qrCode: legacyQrCode,
      schemaVersion: 'legacy_v1',
      payload: {
        source: 'toilet_units.qr_code',
        legacy: true,
        toiletUnitId: row.id,
      },
    });
    await createAliasIfAvailable({
      qrCode: unitCode,
      schemaVersion: 'legacy_code_alias',
      payload: {
        source: 'toilet_units.code',
        legacy: true,
        toiletUnitId: row.id,
      },
    });

    return {
      row,
      facility,
      canonicalPayload,
      canonicalQrCode,
      legacyQrCode,
    };
  });

  await createAuditLog({
    req,
    action: 'toilet_unit.create',
    entityType: 'toilet_unit',
    entityId: createResult.row.id,
    tenantId: createResult.facility.tenant_id,
    details: {
      qrId: createResult.canonicalPayload.qrId,
      qrSchemaVersion: QR_SCHEMA_V2,
    },
  });

  const qrResult = await ensureAllQrImagesForToilet({
    toiletUnitId: createResult.row.id,
    appQrCodeValue: createResult.canonicalQrCode,
    feedbackQrValue: getPublicFeedbackUrl({ toiletUnitId: createResult.row.id }),
  });

  return {
    id: createResult.row.id,
    facilityId: createResult.row.facility_id,
    toiletBlockId: createResult.row.toilet_block_id,
    code: createResult.row.code,
    qrId: createResult.canonicalPayload.qrId,
    qrSchemaVersion: QR_SCHEMA_V2,
    qrCode: createResult.canonicalQrCode,
    appQrCode: createResult.canonicalQrCode,
    legacyQrCode: createResult.legacyQrCode || createResult.row.code,
    qrImageUrl: qrResult?.appQrImageUrl || getQrImageUrl(createResult.row.id),
    appQrImageUrl: qrResult?.appQrImageUrl || getQrImageUrl(createResult.row.id),
    feedbackQrImageUrl: qrResult?.feedbackQrImageUrl || getFeedbackQrImageUrl(createResult.row.id),
    publicFeedbackUrl:
      qrResult?.publicFeedbackUrl || getPublicFeedbackUrl({ toiletUnitId: createResult.row.id }),
    unitType: createResult.row.unit_type,
    status: createResult.row.status,
    sectorCode: createResult.row.sector_code || null,
    locationLabel: createResult.row.location_label || null,
    latitude:
      createResult.row.latitude !== null && createResult.row.latitude !== undefined
        ? Number(createResult.row.latitude)
        : null,
    longitude:
      createResult.row.longitude !== null && createResult.row.longitude !== undefined
        ? Number(createResult.row.longitude)
        : null,
  };
};

module.exports = {
  listTenants,
  createTenant,
  patchTenant,
  listGeographyTree,
  createGeography,
  listFacilities,
  createFacility,
  patchFacility,
  getFacilityById,
  listBlocks,
  createBlock,
  listUnits,
  resolveUnitByQr,
  resolveUnitByQrDetailed,
  resolveToiletFromQr,
  extractQrCandidates,
  findDuplicateExactMatchIds,
  classifyResolvedToilet,
  buildCanonicalQrV2Payload,
  encodeCanonicalQrV2Token,
  tryParseCanonicalQrPayload,
  validateCanonicalQrPayload,
  QR_RESOLVE_REASON_CODES,
  createUnit,
};
