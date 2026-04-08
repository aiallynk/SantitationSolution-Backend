const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  Tenant,
  Geography,
  Facility,
  ToiletBlock,
  ToiletUnit,
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
  QR_NOT_MAPPED: 'QR_NOT_MAPPED',
  TOILET_NOT_FOUND: 'TOILET_NOT_FOUND',
  TOILET_INACTIVE: 'TOILET_INACTIVE',
  TOILET_NOT_IN_USER_SCOPE: 'TOILET_NOT_IN_USER_SCOPE',
  DUPLICATE_QR_MAPPING: 'DUPLICATE_QR_MAPPING',
  QR_RESOLVED_SUCCESSFULLY: 'QR_RESOLVED_SUCCESSFULLY',
});

const QR_RESOLVE_MESSAGES = {
  [QR_RESOLVE_REASON_CODES.INVALID_QR_FORMAT]:
    'Invalid QR format. Please scan a valid toilet QR.',
  [QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED]:
    'This QR is not mapped to any toilet.',
  [QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND]:
    'Toilet not found for this QR.',
  [QR_RESOLVE_REASON_CODES.TOILET_INACTIVE]:
    'This toilet is inactive. Contact your supervisor.',
  [QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE]:
    'QR recognized, but this toilet is not assigned to your area.',
  [QR_RESOLVE_REASON_CODES.DUPLICATE_QR_MAPPING]:
    'This QR is mapped to multiple toilets. Contact administrator.',
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
  reasonCode = QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED,
  rawQrValue = '',
  normalizedQrValue = '',
  parsed = {},
  toilet = null,
  details = null,
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

const classifyResolvedToilet = ({ row, req }) => {
  if (!row) {
    return QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND;
  }
  if (isToiletInactive(row)) {
    return QR_RESOLVE_REASON_CODES.TOILET_INACTIVE;
  }
  if (!isFacilityInScope(req, row.facility_id || row.Facility?.id || null)) {
    return QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE;
  }
  return QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY;
};

const mapUnitRow = (row) => ({
  id: row.id,
  facilityId: row.facility_id,
  facilityCode: row.Facility?.code || null,
  facilityName: row.Facility?.name || null,
  toiletBlockId: row.toilet_block_id,
  code: row.code,
  qrCode: row.qr_code || row.code,
  appQrCode: row.qr_code || row.code,
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
});

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

const resolveToiletFromQr = async ({
  req,
  rawQrValue,
  normalizedQrValue = '',
  workerContext = {},
}) => {
  const rawInput = sanitizeText(rawQrValue, 800);
  const normalizedInput = normalizePermanentQrCode(normalizedQrValue || rawInput);
  const candidates = extractQrCandidates(normalizedQrValue || rawInput);
  const parsedMeta = {
    extractedIdentifier: extractLikelyIdentifier(candidates),
    candidates,
  };

  logQrResolve(req, 'info', {
    stage: 'received',
    rawQrValue: rawInput,
    normalizedQrValue: normalizedInput,
    parsed: parsedMeta,
    workerContext,
  });

  if (candidates.length === 0) {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.INVALID_QR_FORMAT,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
    });
  }

  const baseFacilityInclude = {
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
      'status',
    ],
    required: true,
  };
  const where = buildQrResolveWhere(candidates);

  const tenantWideFacilityInclude = {
    ...baseFacilityInclude,
    where: withTenantScope(req, {}),
  };

  const rows = await ToiletUnit.findAll({
    where,
    include: [tenantWideFacilityInclude],
    limit: 40,
    order: [['code', 'ASC']],
  });
  logQrResolve(req, 'info', {
    stage: 'db_lookup',
    lookupPath: 'toilet_units.qr_code|code|id',
    candidateCount: candidates.length,
    matchCount: rows.length,
  });

  if (!rows.length) {
    const reasonCode = parsedMeta.extractedIdentifier && isUuidLike(parsedMeta.extractedIdentifier)
      ? QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND
      : QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED;
    return buildQrResolveResult({
      status: 'failed',
      reasonCode,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
    });
  }

  const exactMatchedIds = findDuplicateExactMatchIds(rows, candidates);
  if (exactMatchedIds.length > 1) {
    logQrResolve(req, 'warn', {
      stage: 'duplicate_mapping',
      matchedToiletIds: exactMatchedIds,
      parsed: parsedMeta,
    });
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.DUPLICATE_QR_MAPPING,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: {
        matchedToiletIds: exactMatchedIds,
      },
    });
  }

  const best = [...rows]
    .sort(
      (left, right) =>
        scoreCandidateMatch(right, candidates) - scoreCandidateMatch(left, candidates)
    )[0];
  if (!best) {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
    });
  }

  const classification = classifyResolvedToilet({ row: best, req });
  if (classification === QR_RESOLVE_REASON_CODES.TOILET_INACTIVE) {
    logQrResolve(req, 'warn', {
      stage: 'inactive_toilet',
      matchedToiletId: best.id,
      unitStatus: best.status,
      facilityStatus: best.Facility?.status || null,
    });
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.TOILET_INACTIVE,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: {
        matchedToiletId: best.id,
        unitStatus: best.status,
        facilityStatus: best.Facility?.status || null,
      },
    });
  }

  if (classification === QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE) {
    logQrResolve(req, 'warn', {
      stage: 'out_of_scope',
      matchedToiletId: best.id,
      matchedFacilityId: best.facility_id || best.Facility?.id || null,
    });
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: {
        matchedToiletId: best.id,
        matchedFacilityId: best.facility_id || best.Facility?.id || null,
      },
    });
  }

  await ensureQrImageForToilet({
    toiletUnitId: best.id,
    qrCodeValue: best.qr_code || best.code,
  }).catch(() => null);
  await ensureQrImageForToilet({
    toiletUnitId: best.id,
    qrCodeValue: getPublicFeedbackUrl({ toiletUnitId: best.id }),
    variant: 'feedback',
  }).catch(() => null);

  const toilet = mapUnitRow(best);
  logQrResolve(req, 'info', {
    stage: 'resolved',
    reasonCode: QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY,
    matchedToiletId: toilet.id,
    matchedFacilityId: toilet.facilityId,
  });

  return buildQrResolveResult({
    status: 'resolved',
    reasonCode: QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY,
    rawQrValue: rawInput,
    normalizedQrValue: normalizedInput,
    parsed: parsedMeta,
    toilet,
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
  await ensureQrImagesForToilets(rows).catch(() => null);
  return rows.map(mapUnitRow);
};

const createUnit = async (req) => {
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

  const requestedCode = sanitizeText(req.body.code, 120);
  const unitType = sanitizeText(req.body.unitType, 40);

  const toiletBlock = await ToiletBlock.findByPk(req.body.toiletBlockId, {
    attributes: ['id', 'facility_id'],
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

  const qrCode = normalizePermanentQrCode(
    req.body.permanentQrCode || req.body.qrCode || unitCode
  );

  const duplicateCode = await ToiletUnit.findOne({
    where: {
      facility_id: facility.id,
      code: unitCode,
    },
    attributes: ['id'],
  });
  if (duplicateCode) {
    throw new AppError('Toilet unit code already exists in this facility', 409, {
      code: 'TOILET_UNIT_CODE_EXISTS',
    });
  }

  const duplicateQr = await ToiletUnit.findOne({
    where: { qr_code: qrCode },
    attributes: ['id'],
  });
  if (duplicateQr) {
    throw new AppError('permanentQrCode already exists', 409, { code: 'QR_CODE_EXISTS' });
  }

  const row = await ToiletUnit.create({
    facility_id: facility.id,
    toilet_block_id: toiletBlock.id,
    code: unitCode,
    qr_code: qrCode,
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
  });
  await createAuditLog({
    req,
    action: 'toilet_unit.create',
    entityType: 'toilet_unit',
    entityId: row.id,
    tenantId: facility.tenant_id,
  });

  const qrResult = await ensureAllQrImagesForToilet({
    toiletUnitId: row.id,
    appQrCodeValue: row.qr_code || row.code,
    feedbackQrValue: getPublicFeedbackUrl({ toiletUnitId: row.id }),
  });

  return {
    id: row.id,
    facilityId: row.facility_id,
    toiletBlockId: row.toilet_block_id,
    code: row.code,
    qrCode: row.qr_code || row.code,
    appQrCode: row.qr_code || row.code,
    qrImageUrl: qrResult?.appQrImageUrl || getQrImageUrl(row.id),
    appQrImageUrl: qrResult?.appQrImageUrl || getQrImageUrl(row.id),
    feedbackQrImageUrl: qrResult?.feedbackQrImageUrl || getFeedbackQrImageUrl(row.id),
    publicFeedbackUrl: qrResult?.publicFeedbackUrl || getPublicFeedbackUrl({ toiletUnitId: row.id }),
    unitType: row.unit_type,
    status: row.status,
    sectorCode: row.sector_code || null,
    locationLabel: row.location_label || null,
    latitude:
      row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
    longitude:
      row.longitude !== null && row.longitude !== undefined
        ? Number(row.longitude)
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
  QR_RESOLVE_REASON_CODES,
  createUnit,
};
