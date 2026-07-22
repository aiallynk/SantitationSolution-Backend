const crypto = require('crypto');
const { Op, QueryTypes, fn, col } = require('sequelize');
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
  PlatformUser,
  UserRole,
  Role,
  Complaint,
} = require('../../models');
const { createAuditLog } = require('../audit/audit.service');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
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
const { runtimeConfig } = require('../../config/runtime');
const { computeToiletRiskWeight } = require('./toiletMapRisk.helper');
const { getDefaultTimezone, isValidIanaTimezone, normalizeTimezone } = require('../../utils/timezone');
const {
  AI_SCORING_POLICY_VERSION,
  AI_SCORING_MODES,
  resolveAiScoringMode,
} = require('../analysis/aiInspectionScoring.service');

const tenantScope = (req, requestedTenantId) => {
  if (req.user.isSuperAdmin) {
    return requestedTenantId || null;
  }
  return req.user.tenantId;
};

const activeToiletWhere = (where = {}) => ({
  ...where,
  deleted_at: { [Op.is]: null },
});

const shouldIncludeDeletedToilets = (req) =>
  req?.user?.isSuperAdmin &&
  String(req?.query?.includeDeleted || '').trim().toLowerCase() === 'true';

const withTenantScope = (req, where = {}, tenantKey = 'tenant_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'tenant', {
    tenantKey,
  });
};

const withGeographyScope = (req, where = {}, geographyKey = 'geography_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'geography', {
    tenantKey: 'tenant_id',
    geographyKey,
  });
};

const withFacilityScope = (req, where = {}, facilityKey = 'facility_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'facility', {
    tenantKey: 'tenant_id',
    facilityKey,
  });
};

const buildFacilityIncludeScopeWhere = (req) => {
  let where = {};
  where = withTenantScope(req, where);
  where = withGeographyScope(req, where);
  where = withFacilityScope(req, where, 'id');
  return where;
};

const GEO_LEVEL_SEQUENCE = ['country', 'state', 'district', 'city', 'zone', 'ward', 'cluster'];
const GEO_LEVEL_RANK = new Map(GEO_LEVEL_SEQUENCE.map((level, index) => [level, index]));
const TENANT_SCOPE_LEVELS = new Set(['country', 'state', 'district', 'city', 'zone']);
const GEOGRAPHY_ASSIGNMENT_LEVELS = new Set([
  'country',
  'state',
  'district',
  'city',
  'zone',
  'ward',
  'geography',
]);

const sanitizeOptionalText = (value, limit = 180) => {
  if (value === undefined || value === null) return null;
  const normalized = sanitizeText(value, limit);
  return normalized || null;
};

const normalizeTimezoneInput = (value, { nullable = false } = {}) => {
  if (value === undefined) return undefined;
  const raw = String(value || '').trim();
  if (!raw) return nullable ? null : getDefaultTimezone();
  if (!isValidIanaTimezone(raw)) {
    throw new AppError('timezone must be a valid IANA timezone', 400, {
      code: 'INVALID_TIMEZONE',
      details: { timezone: raw },
    });
  }
  return raw;
};

const toFiniteNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeTenantScopeLevel = (value, fallback = 'city') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return TENANT_SCOPE_LEVELS.has(normalized) ? normalized : fallback;
};

const TENANT_SCOPE_REQUIRED_FIELDS = {
  country: ['countryName'],
  state: ['countryName', 'stateName'],
  district: ['countryName', 'stateName', 'districtName'],
  city: ['countryName', 'stateName', 'cityName'],
  zone: ['countryName', 'stateName', 'cityName', 'zoneName'],
};

const assertTenantScopeLocationRequirements = ({ scopeLevel, locationNames = {} }) => {
  const requiredFields = TENANT_SCOPE_REQUIRED_FIELDS[scopeLevel] || [];
  for (const field of requiredFields) {
    const value = String(locationNames[field] || '').trim();
    if (!value) {
      throw new AppError(
        `${field} is required for ${scopeLevel}-level tenant scope`,
        400,
        { code: 'TENANT_SCOPE_LOCATION_REQUIRED' }
      );
    }
  }
};

const normalizeGeographyLevel = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return GEO_LEVEL_RANK.has(normalized) ? normalized : null;
};

const toSlugToken = (value, limit = 120) =>
  String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, Math.max(8, limit));

const buildTenantCodeCandidate = (rawCode, tenantName) => {
  const fromCode = toSlugToken(rawCode || '', 120);
  if (fromCode) return fromCode;
  const base = toSlugToken(tenantName || 'TENANT', 100) || 'TENANT';
  return `${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
};

const buildGeographyCodeCandidate = ({ rawCode, name, level }) => {
  const fromCode = toSlugToken(rawCode || '', 120);
  if (fromCode) return fromCode;
  const baseName = toSlugToken(name || level || 'GEO', 80) || 'GEO';
  return `${baseName}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
};

const resolveUniqueGeographyCode = async ({
  tenantId,
  level,
  rawCode,
  name,
  excludeId = null,
}) => {
  let candidate = buildGeographyCodeCandidate({ rawCode, name, level });
  let attempt = 0;
  while (attempt < 20) {
    const duplicate = await Geography.findOne({
      where: {
        tenant_id: tenantId,
        level,
        code: { [Op.iLike]: candidate },
        ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      },
      attributes: ['id'],
    });
    if (!duplicate) return candidate;
    const suffix = Math.random().toString(36).slice(2, 5).toUpperCase();
    candidate = `${candidate.slice(0, 110)}-${suffix}`.slice(0, 120);
    attempt += 1;
  }
  throw new AppError('Unable to generate unique geography code', 409, {
    code: 'GEOGRAPHY_CODE_EXISTS',
  });
};

const resolveUniqueTenantCode = async ({ rawCode, tenantName, excludeTenantId = null }) => {
  let candidate = buildTenantCodeCandidate(rawCode, tenantName);
  let attempt = 0;
  while (attempt < 20) {
    const duplicate = await Tenant.findOne({
      where: {
        code: { [Op.iLike]: candidate },
        ...(excludeTenantId ? { id: { [Op.ne]: excludeTenantId } } : {}),
      },
      attributes: ['id'],
    });
    if (!duplicate) return candidate;
    const base = candidate.replace(/-[A-Z0-9]{4}$/, '');
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    candidate = `${base}-${suffix}`.slice(0, 120);
    attempt += 1;
  }
  throw new AppError('Unable to generate unique tenant code', 409, {
    code: 'TENANT_CODE_EXISTS',
  });
};

const mapTenantRow = (tenant) => ({
  id: tenant.id,
  name: tenant.name,
  code: tenant.code,
  status: tenant.status,
  countryCode: tenant.country_code || null,
  contactName: tenant.contact_name || null,
  contactEmail: tenant.contact_email || null,
  contactMobile: tenant.contact_mobile || null,
  scopeLevel: tenant.scope_level || 'city',
  countryName: tenant.country_name || null,
  stateName: tenant.state_name || null,
  districtName: tenant.district_name || null,
  cityName: tenant.city_name || null,
  zoneName: tenant.zone_name || null,
  addressLine: tenant.address_line || null,
  rootGeographyId: tenant.root_geography_id || null,
  timezone: normalizeTimezone(tenant.timezone || tenant.metadata?.timezone || getDefaultTimezone()),
  aiScoringMode: resolveAiScoringMode(tenant.metadata?.aiScoringMode || tenant.ai_scoring_mode),
  effectiveAiScoringMode: resolveAiScoringMode(tenant.metadata?.aiScoringMode || tenant.ai_scoring_mode),
  aiScoringPolicyVersion: AI_SCORING_POLICY_VERSION,
  aiScoringUpdatedAt: tenant.metadata?.aiScoringModeUpdatedAt || tenant.updated_at || null,
  aiScoringUpdatedBy: tenant.metadata?.aiScoringModeUpdatedBy || null,
  metadata: tenant.metadata || null,
});

const buildUserLocationFromTenant = (tenant) => ({
  countryName: tenant?.country_name || null,
  stateName: tenant?.state_name || null,
  districtName: tenant?.district_name || null,
  cityName: tenant?.city_name || null,
  zoneName: tenant?.zone_name || null,
});

const parseBounds = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const north = toFiniteNumber(value.north);
  const south = toFiniteNumber(value.south);
  const east = toFiniteNumber(value.east);
  const west = toFiniteNumber(value.west);
  if ([north, south, east, west].some((item) => item === null)) return null;
  return { north, south, east, west };
};

const pointsToBounds = (points = []) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const lats = points.map((point) => toFiniteNumber(point?.lat)).filter((value) => value !== null);
  const lngs = points.map((point) => toFiniteNumber(point?.lng)).filter((value) => value !== null);
  if (lats.length === 0 || lngs.length === 0) return null;
  return {
    north: Math.max(...lats),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    west: Math.min(...lngs),
  };
};

const centroidFromPoints = (points = []) => {
  if (!Array.isArray(points) || points.length === 0) return null;
  const valid = points
    .map((point) => ({ lat: toFiniteNumber(point?.lat), lng: toFiniteNumber(point?.lng) }))
    .filter((point) => point.lat !== null && point.lng !== null);
  if (valid.length === 0) return null;
  const lat = valid.reduce((sum, point) => sum + point.lat, 0) / valid.length;
  const lng = valid.reduce((sum, point) => sum + point.lng, 0) / valid.length;
  return { latitude: lat, longitude: lng };
};

const areaSqKmFromPolygon = (points = []) => {
  if (!Array.isArray(points) || points.length < 3) return null;
  const valid = points
    .map((point) => ({ lat: toFiniteNumber(point?.lat), lng: toFiniteNumber(point?.lng) }))
    .filter((point) => point.lat !== null && point.lng !== null);
  if (valid.length < 3) return null;
  const avgLatRad =
    (valid.reduce((sum, point) => sum + point.lat, 0) / valid.length) * (Math.PI / 180);
  const kmPerDegLat = 110.574;
  const kmPerDegLng = 111.32 * Math.cos(avgLatRad);
  let twiceArea = 0;
  for (let idx = 0; idx < valid.length; idx += 1) {
    const current = valid[idx];
    const next = valid[(idx + 1) % valid.length];
    const x1 = current.lng * kmPerDegLng;
    const y1 = current.lat * kmPerDegLat;
    const x2 = next.lng * kmPerDegLng;
    const y2 = next.lat * kmPerDegLat;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea / 2);
};

const polygonPointsFromGeoJson = (geojson) => {
  if (!geojson || typeof geojson !== 'object') return [];
  if (geojson.type !== 'Polygon' || !Array.isArray(geojson.coordinates)) return [];
  const ring = Array.isArray(geojson.coordinates[0]) ? geojson.coordinates[0] : [];
  return ring
    .map((tuple) => {
      if (!Array.isArray(tuple) || tuple.length < 2) return null;
      const lng = toFiniteNumber(tuple[0]);
      const lat = toFiniteNumber(tuple[1]);
      if (lat === null || lng === null) return null;
      return { lat, lng };
    })
    .filter(Boolean);
};

const deriveGeometryPayload = (body = {}) => {
  const geometryType = String(body.geometryType || '').trim().toLowerCase() || null;
  const geojson = body.geojson && typeof body.geojson === 'object' ? body.geojson : null;

  let centroidLatitude = toFiniteNumber(body.centroidLatitude);
  let centroidLongitude = toFiniteNumber(body.centroidLongitude);
  let boundaryCenterLatitude = toFiniteNumber(body.boundaryCenterLatitude);
  let boundaryCenterLongitude = toFiniteNumber(body.boundaryCenterLongitude);
  let boundaryRadiusMeters = toFiniteNumber(body.boundaryRadiusMeters);
  let bounds = parseBounds(body.bounds);
  let areaSqKm = toFiniteNumber(body.areaSqKm);

  if (geometryType === 'polygon' && geojson) {
    const points = polygonPointsFromGeoJson(geojson);
    const boundsFromPolygon = pointsToBounds(points);
    const centroid = centroidFromPoints(points);
    if (!bounds && boundsFromPolygon) {
      bounds = boundsFromPolygon;
    }
    if ((centroidLatitude === null || centroidLongitude === null) && centroid) {
      centroidLatitude = centroid.lat;
      centroidLongitude = centroid.lng;
    }
    if ((boundaryCenterLatitude === null || boundaryCenterLongitude === null) && centroid) {
      boundaryCenterLatitude = centroid.lat;
      boundaryCenterLongitude = centroid.lng;
    }
    if (areaSqKm === null) {
      areaSqKm = areaSqKmFromPolygon(points);
    }
  }

  if (geometryType === 'circle') {
    const centerLat = boundaryCenterLatitude ?? centroidLatitude;
    const centerLng = boundaryCenterLongitude ?? centroidLongitude;
    if (centerLat !== null && centerLng !== null) {
      if (boundaryCenterLatitude === null) boundaryCenterLatitude = centerLat;
      if (boundaryCenterLongitude === null) boundaryCenterLongitude = centerLng;
      if (centroidLatitude === null) centroidLatitude = centerLat;
      if (centroidLongitude === null) centroidLongitude = centerLng;
      if (!bounds && boundaryRadiusMeters !== null) {
        const latDelta = boundaryRadiusMeters / 111320;
        const lngDelta =
          boundaryRadiusMeters /
          (111320 * Math.max(Math.cos((centerLat * Math.PI) / 180), 0.25));
        bounds = {
          north: centerLat + latDelta,
          south: centerLat - latDelta,
          east: centerLng + lngDelta,
          west: centerLng - lngDelta,
        };
      }
      if (areaSqKm === null && boundaryRadiusMeters !== null) {
        areaSqKm = (Math.PI * boundaryRadiusMeters * boundaryRadiusMeters) / 1_000_000;
      }
    }
  }

  return {
    geometryType,
    geojson,
    centroidLatitude,
    centroidLongitude,
    boundaryCenterLatitude,
    boundaryCenterLongitude,
    boundaryRadiusMeters,
    bounds,
    areaSqKm,
    boundaryLabel: sanitizeOptionalText(body.boundaryLabel, 220),
    isOperationalZone:
      body.isOperationalZone !== undefined
        ? Boolean(body.isOperationalZone)
        : undefined,
  };
};

const ensureParentHierarchyIsValid = ({ parentLevel, childLevel }) => {
  if (!parentLevel || !childLevel) return true;
  const parentRank = GEO_LEVEL_RANK.get(parentLevel);
  const childRank = GEO_LEVEL_RANK.get(childLevel);
  if (parentRank === undefined || childRank === undefined) return true;
  return childRank > parentRank;
};

const boundsOverlap = (left, right) => {
  if (!left || !right) return false;
  return !(
    Number(left.west) > Number(right.east) ||
    Number(left.east) < Number(right.west) ||
    Number(left.south) > Number(right.north) ||
    Number(left.north) < Number(right.south)
  );
};

const assertNoBoundaryConflict = async ({
  tenantId,
  level,
  parentId = null,
  bounds = null,
  excludeId = null,
}) => {
  if (!tenantId || !bounds || !['zone', 'ward'].includes(String(level || '').toLowerCase())) {
    return;
  }
  const rows = await Geography.findAll({
    where: {
      tenant_id: tenantId,
      level,
      parent_id: parentId || null,
      ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
    },
    attributes: ['id', 'bounds'],
  });

  const conflict = rows.find((row) => boundsOverlap(row.bounds, bounds));
  if (conflict) {
    throw new AppError('Boundary overlaps with an existing zone/ward in the same scope', 409, {
      code: 'GEOGRAPHY_BOUNDARY_CONFLICT',
    });
  }
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
  String(runtimeConfig.auth.qrV2SigningSecret || runtimeConfig.auth.jwtSecret || '').trim() ||
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

/** Shorter segments for auto toilet codes (toilet name + block + suffix must fit DB limit). */
const normalizeAutoToiletCodePart = (value, fallback, maxLen = 32) => {
  const text = sanitizeText(value, maxLen);
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

const findToiletUnitCodeConflict = async ({ facilityId, code, transaction = null }) => {
  const normalizedCode = normalizePermanentQrCode(code);
  if (!facilityId || !normalizedCode) return null;

  const rows = await sequelize.query(
    `
      SELECT id
      FROM toilet_units
      WHERE facility_id = :facilityId
        AND UPPER(TRIM(code)) = :normalizedCode
      LIMIT 1
      ${transaction ? 'FOR UPDATE' : ''}
    `,
    {
      replacements: { facilityId, normalizedCode },
      transaction,
      type: QueryTypes.SELECT,
    }
  );
  return rows[0] || null;
};

const buildAutoToiletId = async ({
  facility,
  toiletBlock,
  toiletName = null,
  transaction = null,
}) => {
  const toiletPart = normalizeAutoToiletCodePart(toiletName, 'TOILET', 48);
  const blockPart = normalizeAutoToiletCodePart(
    toiletBlock.name || toiletBlock.code,
    'BLK',
    36
  );
  const prefix = `${toiletPart}-${blockPart}`;

  let sequence = 1;
  while (sequence <= 9999) {
    const candidate = `${prefix}-${String(sequence).padStart(3, '0')}`;
    const conflict = await findToiletUnitCodeConflict({
      facilityId: facility.id,
      code: candidate,
      transaction,
    });
    if (!conflict) {
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
  QR_NOT_MAPPED: 'QR_NOT_MAPPED',
  TOILET_NOT_FOUND: 'TOILET_NOT_FOUND',
  TOILET_INACTIVE: 'TOILET_INACTIVE',
  TOILET_DELETED: 'TOILET_DELETED',
  TOILET_UNAVAILABLE: 'TOILET_UNAVAILABLE',
  TOILET_NOT_IN_USER_SCOPE: 'TOILET_NOT_IN_USER_SCOPE',
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
  [QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED]:
    'This QR is not mapped to any toilet.',
  [QR_RESOLVE_REASON_CODES.TOILET_NOT_FOUND]:
    'Toilet not found for this QR.',
  [QR_RESOLVE_REASON_CODES.TOILET_INACTIVE]:
    'This toilet is inactive.',
  [QR_RESOLVE_REASON_CODES.TOILET_DELETED]:
    'This toilet is no longer available for inspection.',
  [QR_RESOLVE_REASON_CODES.TOILET_UNAVAILABLE]:
    'This toilet is no longer available for inspection.',
  [QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE]:
    'QR recognized, but this toilet is not assigned to you.',
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

const isToiletDeleted = (row) => Boolean(row?.deleted_at || row?.deletedAt);

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
  if (isToiletDeleted(row)) {
    return QR_RESOLVE_REASON_CODES.TOILET_DELETED;
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
    return QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE;
  }
  return QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY;
};

const BASELINE_MIN_INSPECTIONS = 3;

const resolveBaselineConfidence = (inspectionCount) => {
  const count = Number(inspectionCount || 0);
  if (!Number.isFinite(count) || count < BASELINE_MIN_INSPECTIONS) return 'insufficient';
  if (count >= 20) return 'high';
  if (count >= 8) return 'medium';
  return 'low';
};

const resolveBaselineScore = ({ totalInspections, avgAfterScore, latestScore }) => {
  const avgAfter = Number.isFinite(Number(avgAfterScore)) ? Number(avgAfterScore) : null;
  const latest = Number.isFinite(Number(latestScore)) ? Number(latestScore) : null;
  const count = Number(totalInspections || 0);
  if (count >= BASELINE_MIN_INSPECTIONS) {
    return avgAfter ?? latest;
  }
  return latest ?? avgAfter;
};

const toNumberOrNull = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

const scoreLabelFromScore = (score) => {
  const value = toNumberOrNull(score);
  if (value === null) return 'Unknown';
  if (value <= 30) return 'Very Dirty';
  if (value <= 50) return 'Dirty';
  if (value <= 70) return 'Moderate';
  if (value <= 85) return 'Clean';
  return 'Very Clean';
};

const mapInspectionSummaryRow = (row = {}) => {
  const avgBeforeScore = toNumberOrNull(row.avgBeforeScore);
  const avgAfterScore = toNumberOrNull(row.avgAfterScore);
  const cleanlinessScore = toNumberOrNull(row.cleanlinessScore);
  const improvementScore =
    toNumberOrNull(row.improvementScore) ??
    (avgBeforeScore !== null && avgAfterScore !== null
      ? Number((avgAfterScore - avgBeforeScore).toFixed(2))
      : null);
  const score = avgAfterScore ?? cleanlinessScore ?? avgBeforeScore;
  return {
    id: row.id || null,
    toiletUnitId: row.toiletUnitId || null,
    capturedAt: row.capturedAt || null,
    submittedAt: row.submittedAt || null,
    score,
    scoreLabel: scoreLabelFromScore(score),
    avgBeforeScore,
    avgAfterScore,
    cleanlinessScore,
    improvementScore,
    inspectionResult: row.inspectionResult || null,
    overallStatus: row.overallStatus || null,
    processingStatus: row.processingStatus || null,
    status: row.overallStatus || row.inspectionResult || row.processingStatus || null,
  };
};

const loadInspectionSummariesForToiletIds = async (toiletIds = []) => {
  const ids = Array.from(
    new Set(
      (Array.isArray(toiletIds) ? toiletIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );
  if (ids.length === 0) return new Map();

  const rows = await sequelize.query(
    `
      SELECT *
      FROM (
        SELECT
          i.id,
          i.toilet_unit_id AS "toiletUnitId",
          i.captured_at AS "capturedAt",
          i.submitted_at AS "submittedAt",
          i.avg_before_score AS "avgBeforeScore",
          i.avg_after_score AS "avgAfterScore",
          i.improvement_score AS "improvementScore",
          i.inspection_result AS "inspectionResult",
          i.overall_status AS "overallStatus",
          i.processing_status AS "processingStatus",
          ai.cleanliness_score AS "cleanlinessScore",
          ROW_NUMBER() OVER (
            PARTITION BY i.toilet_unit_id
            ORDER BY COALESCE(i.submitted_at, i.captured_at, i.created_at) DESC, i.created_at DESC
          ) AS rn
        FROM inspections i
        LEFT JOIN (
          SELECT inspection_id, AVG(cleanliness_score) AS cleanliness_score
          FROM ai_analysis_results
          GROUP BY inspection_id
        ) ai ON ai.inspection_id = i.id
        WHERE i.toilet_unit_id IN (:ids)
      ) ranked
      WHERE rn <= 2
      ORDER BY "toiletUnitId" ASC, rn ASC
    `,
    {
      replacements: { ids },
      type: QueryTypes.SELECT,
    }
  );

  const map = new Map();
  for (const row of rows) {
    const toiletId = String(row.toiletUnitId || '').trim();
    if (!toiletId) continue;
    const current = map.get(toiletId) || { latest: null, previous: null };
    const summary = mapInspectionSummaryRow(row);
    if (Number(row.rn) === 1) current.latest = summary;
    if (Number(row.rn) === 2) current.previous = summary;
    map.set(toiletId, current);
  }
  return map;
};

const mapUnitRow = (row, options = {}) => {
  const resolvedQrCode = String(options.resolvedQrCode || row.qr_code || row.code || '').trim();
  const legacyQrCode = String(options.legacyQrCode || row.qr_code || row.code || '').trim();
  const latestScore =
    row.latest_score !== null && row.latest_score !== undefined
      ? Number(row.latest_score)
      : null;
  const latestBeforeScore =
    row.latest_before_score !== null && row.latest_before_score !== undefined
      ? Number(row.latest_before_score)
      : null;
  const latestAfterScore =
    row.latest_after_score !== null && row.latest_after_score !== undefined
      ? Number(row.latest_after_score)
      : null;
  const avgBeforeScore =
    row.avg_before_score !== null && row.avg_before_score !== undefined
      ? Number(row.avg_before_score)
      : null;
  const avgAfterScore =
    row.avg_after_score !== null && row.avg_after_score !== undefined
      ? Number(row.avg_after_score)
      : null;
  const avgImprovementScore =
    row.avg_improvement_score !== null && row.avg_improvement_score !== undefined
      ? Number(row.avg_improvement_score)
      : null;
  const totalInspections = Number(row.total_inspections || 0);
  const baselineScore = resolveBaselineScore({
    totalInspections,
    avgAfterScore,
    latestScore,
  });
  const latestInspection =
    options.latestInspection ||
    (row.last_inspection_at
      ? {
          id: null,
          toiletUnitId: row.id,
          submittedAt: row.last_inspection_at,
          capturedAt: row.last_inspection_at,
          score: latestScore,
          scoreLabel: scoreLabelFromScore(latestScore),
          avgBeforeScore: latestBeforeScore,
          avgAfterScore: latestAfterScore,
          improvementScore:
            latestBeforeScore !== null && latestAfterScore !== null
              ? Number((latestAfterScore - latestBeforeScore).toFixed(2))
              : null,
          status: row.status || null,
        }
      : null);
  const previousInspection = options.previousInspection || null;

  return {
    id: row.id,
    facilityId: row.facility_id,
    facilityCode: row.Facility?.code || null,
    facilityName: row.Facility?.name || null,
    geographyId: row.Facility?.geography_id || null,
    zoneGeographyId: row.Facility?.zone_geography_id || null,
    wardGeographyId: row.Facility?.ward_geography_id || null,
    zoneName: row.Facility?.zone?.name || null,
    wardName: row.Facility?.ward?.name || null,
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
    isActive: !isToiletDeleted(row) && !isToiletInactive(row),
    deactivatedAt: row.deactivated_at || null,
    deletedAt: row.deleted_at || null,
    lifecycleReason: row.lifecycle_reason || null,
    sectorCode:
      row.sector_code ||
      row.Facility?.metadata?.sector ||
      row.Facility?.metadata?.zone ||
      null,
    wardGeographyId: row.Facility?.ward_geography_id || null,
    wardName: row.Facility?.ward?.name || null,
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
    latestScore,
    latestBeforeScore,
    latestAfterScore,
    latestInspection,
    avgBeforeScore,
    avgAfterScore,
    avgImprovementScore,
    previousInspection,
    previousInspectionAt: previousInspection?.submittedAt || previousInspection?.capturedAt || null,
    previousScore: previousInspection?.score ?? null,
    previousScoreLabel: scoreLabelFromScore(previousInspection?.score),
    previousBeforeScore: previousInspection?.avgBeforeScore ?? null,
    previousAfterScore: previousInspection?.avgAfterScore ?? null,
    previousImprovementScore: previousInspection?.improvementScore ?? null,
    baselineScore,
    baselineScoreLabel: scoreLabelFromScore(baselineScore),
    baselineMinInspections: BASELINE_MIN_INSPECTIONS,
    baselineConfidence: resolveBaselineConfidence(totalInspections),
    totalInspections,
    lastInspectionAt: row.last_inspection_at || null,
    timezone: row.timezone || null,
    timezoneSource: row.timezone ? 'toilet' : row.Facility?.timezone ? 'facility' : 'tenant',
    facilityTimezone: row.Facility?.timezone || row.Facility?.metadata?.timezone || null,
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
  const tenantForAssignmentLookup = rowTenantId || userTenantId || null;
  let assignments = [];
  if (!privilegedRole && req?.user?.id && tenantForAssignmentLookup) {
    assignments = await WorkerAssignment.findAll({
      where: {
        user_id: req.user.id,
        tenant_id: tenantForAssignmentLookup,
        status: 'active',
      },
      attributes: ['id', 'assignment_level', 'geography_id', 'facility_id', 'toilet_unit_id'],
    });
  }

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
    if (GEOGRAPHY_ASSIGNMENT_LEVELS.has(level)) {
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

  const tokenScopeAllowed = isFacilityInScope(req, facilityId || null);
  const mode = matchedAssignment
    ? 'assignment_match'
    : privilegedRole
      ? 'privileged_role'
      : 'tenant_wide_worker_access';

  return {
    allowed: true,
    reasonCode: tokenScopeAllowed
      ? QR_RESOLVE_REASON_CODES.QR_RESOLVED_SUCCESSFULLY
      : QR_RESOLVE_REASON_CODES.SCOPE_REFRESH_RECOMMENDED,
    details: {
      mode,
      assignmentId: matchedAssignment?.id || null,
      assignmentLevel: matchedAssignment?.assignment_level || null,
      assignmentCount: assignments.length,
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
        AND UPPER(TRIM(q.qr_code)) IN (:candidateCodes)
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
        : QR_RESOLVE_REASON_CODES.QR_NOT_MAPPED;
    return buildQrResolveResult({
      status: 'failed',
      reasonCode,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
    });
  }

  if (isToiletDeleted(selectedToilet)) {
    return buildQrResolveResult({
      status: 'failed',
      reasonCode: QR_RESOLVE_REASON_CODES.TOILET_DELETED,
      rawQrValue: rawInput,
      normalizedQrValue: normalizedInput,
      parsed: parsedMeta,
      details: {
        toiletUnitId: selectedToilet.id,
        unitStatus: selectedToilet.status,
      },
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
      reasonCode:
        auth.reasonCode === QR_RESOLVE_REASON_CODES.WORKER_SCOPE_DENIED
          ? QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE
          : auth.reasonCode || QR_RESOLVE_REASON_CODES.TOILET_NOT_IN_USER_SCOPE,
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
  return tenants.map((tenant) => mapTenantRow(tenant));
};

const createTenant = async (req) => {
  if (!req.user.isSuperAdmin) {
    throw new AppError('Only super admins can create tenants', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  const tenantName = sanitizeText(req.body.name, 200);
  const tenantCode = await resolveUniqueTenantCode({
    rawCode: req.body.code,
    tenantName,
  });
  const scopeLevel = normalizeTenantScopeLevel(req.body.scopeLevel, 'city');
  const countryName = sanitizeOptionalText(req.body.countryName, 120);
  const stateName = sanitizeOptionalText(req.body.stateName, 120);
  const districtName = sanitizeOptionalText(req.body.districtName, 120);
  const cityName = sanitizeOptionalText(req.body.cityName, 120);
  const zoneName = sanitizeOptionalText(req.body.zoneName, 120);
  assertTenantScopeLocationRequirements({
    scopeLevel,
    locationNames: {
      countryName,
      stateName,
      districtName,
      cityName,
      zoneName,
    },
  });
  const tenantTimezone = normalizeTimezoneInput(req.body.timezone ?? getDefaultTimezone(), { nullable: false });
  const tenantMetadata =
    req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
      ? { ...req.body.metadata }
      : {};
  tenantMetadata.timezone = tenantTimezone;
  const tenant = await Tenant.create({
    name: tenantName,
    code: tenantCode,
    status: req.body.status || 'active',
    country_code: sanitizeOptionalText(req.body.countryCode, 10),
    contact_name: sanitizeOptionalText(req.body.contactName, 180),
    contact_email: sanitizeOptionalText(req.body.contactEmail, 180),
    contact_mobile: sanitizeOptionalText(req.body.contactMobile, 32),
    scope_level: scopeLevel,
    country_name: countryName,
    state_name: stateName,
    district_name: districtName,
    city_name: cityName,
    zone_name: zoneName,
    address_line: sanitizeOptionalText(req.body.addressLine, 300),
    root_geography_id: req.body.rootGeographyId || null,
    timezone: tenantTimezone,
    metadata: tenantMetadata,
  });
  await createAuditLog({
    req,
    action: 'tenant.create',
    entityType: 'tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
  });
  return mapTenantRow(tenant);
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
  if (req.body.rootGeographyId) {
    const rootGeo = await Geography.findByPk(req.body.rootGeographyId);
    if (!rootGeo || rootGeo.tenant_id !== tenant.id) {
      throw new AppError('rootGeographyId is outside tenant scope', 400, {
        code: 'GEOGRAPHY_SCOPE_INVALID',
      });
    }
  }
  const nextScopeLevel =
    req.body.scopeLevel !== undefined
      ? normalizeTenantScopeLevel(req.body.scopeLevel, tenant.scope_level || 'city')
      : tenant.scope_level;
  const nextCountryName =
    req.body.countryName !== undefined
      ? sanitizeOptionalText(req.body.countryName, 120)
      : tenant.country_name;
  const nextStateName =
    req.body.stateName !== undefined
      ? sanitizeOptionalText(req.body.stateName, 120)
      : tenant.state_name;
  const nextDistrictName =
    req.body.districtName !== undefined
      ? sanitizeOptionalText(req.body.districtName, 120)
      : tenant.district_name;
  const nextCityName =
    req.body.cityName !== undefined
      ? sanitizeOptionalText(req.body.cityName, 120)
      : tenant.city_name;
  const nextZoneName =
    req.body.zoneName !== undefined
      ? sanitizeOptionalText(req.body.zoneName, 120)
      : tenant.zone_name;
  assertTenantScopeLocationRequirements({
    scopeLevel: nextScopeLevel,
    locationNames: {
      countryName: nextCountryName,
      stateName: nextStateName,
      districtName: nextDistrictName,
      cityName: nextCityName,
      zoneName: nextZoneName,
    },
  });

  const nextTimezone =
    req.body.timezone !== undefined
      ? normalizeTimezoneInput(req.body.timezone, { nullable: false })
      : normalizeTimezone(tenant.timezone || tenant.metadata?.timezone || getDefaultTimezone());
  const nextTenantMetadata = {
    ...(tenant.metadata && typeof tenant.metadata === 'object' ? tenant.metadata : {}),
    ...(req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata)
      ? req.body.metadata
      : {}),
    timezone: nextTimezone,
  };

  await tenant.update({
    name: req.body.name ? sanitizeText(req.body.name, 200) : tenant.name,
    code:
      req.body.code && String(req.body.code).trim()
        ? await resolveUniqueTenantCode({
            rawCode: req.body.code,
            tenantName: req.body.name || tenant.name,
            excludeTenantId: tenant.id,
          })
        : tenant.code,
    status: req.body.status || tenant.status,
    country_code:
      req.body.countryCode !== undefined
        ? sanitizeOptionalText(req.body.countryCode, 10)
        : tenant.country_code,
    contact_name:
      req.body.contactName !== undefined
        ? sanitizeOptionalText(req.body.contactName, 180)
        : tenant.contact_name,
    contact_email:
      req.body.contactEmail !== undefined
        ? sanitizeOptionalText(req.body.contactEmail, 180)
        : tenant.contact_email,
    contact_mobile:
      req.body.contactMobile !== undefined
        ? sanitizeOptionalText(req.body.contactMobile, 32)
        : tenant.contact_mobile,
    scope_level: nextScopeLevel,
    country_name: nextCountryName,
    state_name: nextStateName,
    district_name: nextDistrictName,
    city_name: nextCityName,
    zone_name: nextZoneName,
    address_line:
      req.body.addressLine !== undefined
        ? sanitizeOptionalText(req.body.addressLine, 300)
        : tenant.address_line,
    root_geography_id:
      req.body.rootGeographyId !== undefined
        ? req.body.rootGeographyId || null
        : tenant.root_geography_id,
    timezone: nextTimezone,
    metadata: nextTenantMetadata,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'tenant.update',
    entityType: 'tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
  });
  return mapTenantRow(tenant);
};

const mapTenantProfileForClient = (tenant) => {
  const row = mapTenantRow(tenant);
  const metadata = tenant.metadata && typeof tenant.metadata === 'object' ? tenant.metadata : {};
  return {
    ...row,
    addressLine2: metadata.addressLine2 || null,
    pincode: metadata.pincode || null,
    timezone: normalizeTimezone(tenant.timezone || metadata.timezone || getDefaultTimezone()),
  };
};

const getOwnTenantProfile = async (req) => {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    throw new AppError('Tenant context is required', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) {
    throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }
  return mapTenantProfileForClient(tenant);
};

const patchOwnTenantProfile = async (req) => {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    throw new AppError('Tenant context is required', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) {
    throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }

  const nextMetadata = {
    ...(tenant.metadata && typeof tenant.metadata === 'object' ? tenant.metadata : {}),
  };
  const requestedAiScoringMode =
    req.body.aiScoringMode !== undefined ? String(req.body.aiScoringMode || '').trim().toLowerCase() : null;
  const previousAiScoringMode = resolveAiScoringMode(tenant.ai_scoring_mode);
  if (requestedAiScoringMode !== null && !AI_SCORING_MODES.has(requestedAiScoringMode)) {
    throw new AppError('aiScoringMode must be light, medium, or high', 400, { code: 'INVALID_AI_SCORING_MODE' });
  }
  if (requestedAiScoringMode !== null) {
    nextMetadata.aiScoringModeUpdatedAt = new Date().toISOString();
    nextMetadata.aiScoringModeUpdatedBy = { id: req.user?.id || null, name: req.user?.fullName || req.user?.name || null };
  }
  if (req.body.addressLine2 !== undefined) {
    nextMetadata.addressLine2 = sanitizeOptionalText(req.body.addressLine2, 300);
  }
  if (req.body.pincode !== undefined) {
    const pincode = sanitizeOptionalText(req.body.pincode, 20);
    if (pincode && !/^[A-Za-z0-9\- ]{3,20}$/.test(pincode)) {
      throw new AppError('Invalid pincode format', 400, { code: 'VALIDATION_ERROR' });
    }
    nextMetadata.pincode = pincode;
  }
  if (req.body.timezone !== undefined) {
    nextMetadata.timezone = normalizeTimezoneInput(req.body.timezone, { nullable: false });
  }
  const nextTimezone = nextMetadata.timezone || normalizeTimezone(tenant.timezone || getDefaultTimezone());

  await tenant.update({
    name: req.body.name ? sanitizeText(req.body.name, 200) : tenant.name,
    country_code:
      req.body.countryCode !== undefined
        ? sanitizeOptionalText(req.body.countryCode, 10)
        : tenant.country_code,
    contact_name:
      req.body.contactName !== undefined
        ? sanitizeOptionalText(req.body.contactName, 180)
        : tenant.contact_name,
    contact_email:
      req.body.contactEmail !== undefined
        ? sanitizeOptionalText(req.body.contactEmail, 180)
        : tenant.contact_email,
    contact_mobile:
      req.body.contactMobile !== undefined
        ? sanitizeOptionalText(req.body.contactMobile, 32)
        : tenant.contact_mobile,
    country_name:
      req.body.countryName !== undefined
        ? sanitizeOptionalText(req.body.countryName, 120)
        : tenant.country_name,
    state_name:
      req.body.stateName !== undefined
        ? sanitizeOptionalText(req.body.stateName, 120)
        : tenant.state_name,
    district_name:
      req.body.districtName !== undefined
        ? sanitizeOptionalText(req.body.districtName, 120)
        : tenant.district_name,
    city_name:
      req.body.cityName !== undefined
        ? sanitizeOptionalText(req.body.cityName, 120)
        : tenant.city_name,
    zone_name:
      req.body.zoneName !== undefined
        ? sanitizeOptionalText(req.body.zoneName, 120)
        : tenant.zone_name,
    address_line:
      req.body.addressLine !== undefined
        ? sanitizeOptionalText(req.body.addressLine, 300)
        : tenant.address_line,
    timezone: nextTimezone,
    ai_scoring_mode: requestedAiScoringMode || tenant.ai_scoring_mode,
    metadata: nextMetadata,
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    action: 'tenant.profile.update',
    entityType: 'tenant',
    entityId: tenant.id,
    tenantId: tenant.id,
  });
  if (requestedAiScoringMode !== null) {
    await createAuditLog({
      req, actorUserId: req.user?.id, tenantId, action: 'tenant.ai_scoring_mode_update', entityType: 'tenant', entityId: tenant.id,
      details: { previousMode: previousAiScoringMode, newMode: requestedAiScoringMode, changedByRole: req.user?.role || req.user?.roleCodes?.[0] || null, source: 'tenant_settings' },
    });
  }

  return mapTenantProfileForClient(tenant);
};

const getOwnTenantAiScoringMode = async (req) => {
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw new AppError('Tenant context is required', 403, { code: 'SCOPE_FORBIDDEN' });
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  const metadata = tenant.metadata && typeof tenant.metadata === 'object' ? tenant.metadata : {};
  return {
    aiScoringMode: resolveAiScoringMode(metadata.aiScoringMode || tenant.ai_scoring_mode),
    effectiveAiScoringMode: resolveAiScoringMode(metadata.aiScoringMode || tenant.ai_scoring_mode),
    aiScoringPolicyVersion: AI_SCORING_POLICY_VERSION,
    updatedAt: metadata.aiScoringModeUpdatedAt || tenant.updated_at,
    updatedBy: metadata.aiScoringModeUpdatedBy || null,
  };
};

const patchOwnTenantAiScoringMode = async (req) => {
  const tenantId = req.user?.tenantId;
  if (!tenantId) throw new AppError('Tenant context is required', 403, { code: 'SCOPE_FORBIDDEN' });
  const requestedMode = String(req.body?.aiScoringMode || '').trim().toLowerCase();
  if (!AI_SCORING_MODES.has(requestedMode)) {
    throw new AppError('aiScoringMode must be light, medium, or high', 400, { code: 'INVALID_AI_SCORING_MODE' });
  }
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  const previousMode = resolveAiScoringMode(tenant.ai_scoring_mode);
  const metadata = tenant.metadata && typeof tenant.metadata === 'object' ? { ...tenant.metadata } : {};
  metadata.aiScoringModeUpdatedAt = new Date().toISOString();
  metadata.aiScoringModeUpdatedBy = {
    id: req.user?.id || null,
    name: req.user?.fullName || req.user?.name || null,
  };
  await tenant.update({ ai_scoring_mode: requestedMode, metadata, updated_at: new Date() });
  await createAuditLog({
    req, actorUserId: req.user?.id, tenantId, action: 'tenant.ai_scoring_mode_update', entityType: 'tenant', entityId: tenantId,
    details: { previousMode, newMode: requestedMode, changedByRole: req.user?.role || req.user?.roleCodes?.[0] || null, source: 'tenant_settings', requestId: req.id || null },
  });
  return getOwnTenantAiScoringMode(req);
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

const mapGeographyRow = (row) => ({
  id: row.id,
  parentId: row.parent_id,
  tenantId: row.tenant_id,
  level: row.level,
  code: row.code,
  name: row.name,
  centroidLatitude: row.centroid_latitude !== null ? Number(row.centroid_latitude) : null,
  centroidLongitude: row.centroid_longitude !== null ? Number(row.centroid_longitude) : null,
  geometryType: row.geometry_type || null,
  geojson: row.geojson || null,
  boundaryCenterLatitude:
    row.boundary_center_latitude !== null ? Number(row.boundary_center_latitude) : null,
  boundaryCenterLongitude:
    row.boundary_center_longitude !== null ? Number(row.boundary_center_longitude) : null,
  boundaryRadiusMeters:
    row.boundary_radius_meters !== null ? Number(row.boundary_radius_meters) : null,
  bounds: row.bounds || null,
  areaSqKm: row.area_sq_km !== null ? Number(row.area_sq_km) : null,
  boundaryLabel: row.boundary_label || null,
  isOperationalZone: Boolean(row.is_operational_zone),
});

const listGeographyTree = async (req) => {
  const tenantId = tenantScope(req, req.query.tenantId);
  let where = tenantId ? { tenant_id: tenantId } : {};
  where = withGeographyScope(req, where);
  const rows = await Geography.findAll({
    where,
    order: [['level', 'ASC'], ['name', 'ASC']],
  });
  const mapped = rows.map((row) => mapGeographyRow(row));
  return buildGeographyTree(mapped);
};

const listGeographyOptions = async (req) => {
  const tenantId = tenantScope(req, req.query.tenantId);
  let where = tenantId ? { tenant_id: tenantId } : {};
  where = withGeographyScope(req, where);

  const level = normalizeGeographyLevel(req.query.level);
  if (level) {
    where.level = level;
  }
  if (req.query.parentId !== undefined) {
    where.parent_id = req.query.parentId || null;
  }
  if (req.query.search) {
    const q = sanitizeText(req.query.search, 120);
    where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { code: { [Op.iLike]: `%${q}%` } }];
  }

  const rows = await Geography.findAll({
    where,
    order: [
      ['level', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  return rows.map((row) => mapGeographyRow(row));
};

const createGeography = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  if (!tenantId) {
    throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  }
  const level = normalizeGeographyLevel(req.body.level);
  if (!level) {
    throw new AppError('Invalid geography level', 400, { code: 'GEOGRAPHY_LEVEL_INVALID' });
  }

  let parent = null;
  if (req.body.parentId) {
    if (!isGeographyInScope(req, req.body.parentId)) {
      throw new AppError('parentId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    parent = await Geography.findByPk(req.body.parentId);
    if (!parent || parent.tenant_id !== tenantId) {
      throw new AppError('parentId is outside tenant scope', 400, {
        code: 'GEOGRAPHY_SCOPE_INVALID',
      });
    }
    if (!ensureParentHierarchyIsValid({ parentLevel: parent.level, childLevel: level })) {
      throw new AppError('Geography level must be deeper than parent level', 400, {
        code: 'GEOGRAPHY_HIERARCHY_INVALID',
      });
    }
  }

  const geometryPayload = deriveGeometryPayload(req.body);
  await assertNoBoundaryConflict({
    tenantId,
    level,
    parentId: req.body.parentId || null,
    bounds: geometryPayload.bounds,
  });

  const code = await resolveUniqueGeographyCode({
    tenantId,
    level,
    rawCode: req.body.code,
    name: req.body.name,
  });
  const row = await Geography.create({
    tenant_id: tenantId,
    parent_id: req.body.parentId || null,
    level,
    code,
    name: sanitizeText(req.body.name, 200),
    centroid_latitude: geometryPayload.centroidLatitude,
    centroid_longitude: geometryPayload.centroidLongitude,
    geometry_type: geometryPayload.geometryType,
    geojson: geometryPayload.geojson,
    boundary_center_latitude: geometryPayload.boundaryCenterLatitude,
    boundary_center_longitude: geometryPayload.boundaryCenterLongitude,
    boundary_radius_meters: geometryPayload.boundaryRadiusMeters,
    bounds: geometryPayload.bounds,
    area_sq_km: geometryPayload.areaSqKm,
    boundary_label: geometryPayload.boundaryLabel,
    is_operational_zone:
      geometryPayload.isOperationalZone !== undefined
        ? geometryPayload.isOperationalZone
        : level === 'zone' || level === 'ward',
  });
  await createAuditLog({
    req,
    action: 'geography.create',
    entityType: 'geography',
    entityId: row.id,
    tenantId,
  });
  return mapGeographyRow(row);
};

const patchGeography = async (req) => {
  const row = await Geography.findByPk(req.params.id);
  if (!row) {
    throw new AppError('Geography not found', 404, { code: 'GEOGRAPHY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== row.tenant_id) {
    throw new AppError('Geography out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isGeographyInScope(req, row.id)) {
    throw new AppError('Geography out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const nextLevel = req.body.level ? normalizeGeographyLevel(req.body.level) : row.level;
  if (!nextLevel) {
    throw new AppError('Invalid geography level', 400, { code: 'GEOGRAPHY_LEVEL_INVALID' });
  }
  const nextParentId =
    req.body.parentId !== undefined ? req.body.parentId || null : row.parent_id || null;

  let parent = null;
  if (nextParentId) {
    parent = await Geography.findByPk(nextParentId);
    if (!parent || parent.tenant_id !== row.tenant_id) {
      throw new AppError('parentId is outside tenant scope', 400, {
        code: 'GEOGRAPHY_SCOPE_INVALID',
      });
    }
    if (!ensureParentHierarchyIsValid({ parentLevel: parent.level, childLevel: nextLevel })) {
      throw new AppError('Geography level must be deeper than parent level', 400, {
        code: 'GEOGRAPHY_HIERARCHY_INVALID',
      });
    }
  }

  const geometryPayload = deriveGeometryPayload({
    ...mapGeographyRow(row),
    ...req.body,
  });
  await assertNoBoundaryConflict({
    tenantId: row.tenant_id,
    level: nextLevel,
    parentId: nextParentId,
    bounds: geometryPayload.bounds,
    excludeId: row.id,
  });

  const code =
    req.body.code !== undefined || req.body.name !== undefined || req.body.level !== undefined
      ? await resolveUniqueGeographyCode({
          tenantId: row.tenant_id,
          level: nextLevel,
          rawCode: req.body.code || row.code,
          name: req.body.name || row.name,
          excludeId: row.id,
        })
      : row.code;

  await row.update({
    parent_id: nextParentId,
    level: nextLevel,
    code,
    name: req.body.name ? sanitizeText(req.body.name, 200) : row.name,
    centroid_latitude: geometryPayload.centroidLatitude,
    centroid_longitude: geometryPayload.centroidLongitude,
    geometry_type: geometryPayload.geometryType,
    geojson: geometryPayload.geojson,
    boundary_center_latitude: geometryPayload.boundaryCenterLatitude,
    boundary_center_longitude: geometryPayload.boundaryCenterLongitude,
    boundary_radius_meters: geometryPayload.boundaryRadiusMeters,
    bounds: geometryPayload.bounds,
    area_sq_km: geometryPayload.areaSqKm,
    boundary_label: geometryPayload.boundaryLabel,
    is_operational_zone:
      geometryPayload.isOperationalZone !== undefined
        ? geometryPayload.isOperationalZone
        : row.is_operational_zone,
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    action: 'geography.update',
    entityType: 'geography',
    entityId: row.id,
    tenantId: row.tenant_id,
  });
  return mapGeographyRow(row);
};

const removeGeography = async (req) => {
  const row = await Geography.findByPk(req.params.id);
  if (!row) {
    throw new AppError('Geography not found', 404, { code: 'GEOGRAPHY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && req.user.tenantId !== row.tenant_id) {
    throw new AppError('Geography out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isGeographyInScope(req, row.id)) {
    throw new AppError('Geography out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const [childrenCount, facilitiesCount] = await Promise.all([
    Geography.count({ where: { parent_id: row.id } }),
    Facility.count({
      where: {
        [Op.or]: [
          { geography_id: row.id },
          { zone_geography_id: row.id },
          { ward_geography_id: row.id },
        ],
      },
    }),
  ]);

  if (childrenCount > 0) {
    throw new AppError('Cannot delete geography with child geographies', 409, {
      code: 'GEOGRAPHY_HAS_CHILDREN',
    });
  }
  if (facilitiesCount > 0) {
    throw new AppError('Cannot delete geography mapped to facilities', 409, {
      code: 'GEOGRAPHY_HAS_FACILITIES',
    });
  }

  await row.destroy();
  await createAuditLog({
    req,
    action: 'geography.delete',
    entityType: 'geography',
    entityId: row.id,
    tenantId: row.tenant_id,
  });
  return { id: row.id, deleted: true };
};

const ensureScopedGeographyInTenant = async ({
  req,
  geographyId,
  tenantId,
  field = 'geographyId',
}) => {
  if (!geographyId) return null;
  if (!isGeographyInScope(req, geographyId)) {
    throw new AppError(`${field} is outside scope`, 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const geography = await Geography.findByPk(geographyId);
  if (!geography || geography.tenant_id !== tenantId) {
    throw new AppError(`${field} is outside tenant scope`, 400, {
      code: 'GEOGRAPHY_SCOPE_INVALID',
    });
  }
  return geography;
};

const ensureSupervisorForTenant = async ({ supervisorUserId, tenantId }) => {
  if (!supervisorUserId) return null;
  const supervisor = await PlatformUser.findByPk(supervisorUserId, {
    include: [
      {
        model: Role,
        attributes: ['code'],
        through: { attributes: [] },
        required: false,
      },
    ],
  });
  if (!supervisor || supervisor.tenant_id !== tenantId) {
    throw new AppError('supervisorUserId is outside tenant scope', 400, {
      code: 'SUPERVISOR_SCOPE_INVALID',
    });
  }
  const roleCodes = new Set((supervisor.Roles || []).map((role) => String(role.code || '').toLowerCase()));
  if (!roleCodes.has('supervisor')) {
    throw new AppError('Selected supervisorUserId does not belong to supervisor role', 400, {
      code: 'SUPERVISOR_ROLE_REQUIRED',
    });
  }
  return supervisor;
};

const mapFacilityRow = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  geographyId: row.geography_id,
  zoneGeographyId: row.zone_geography_id || null,
  wardGeographyId: row.ward_geography_id || null,
  supervisorUserId: row.supervisor_user_id || null,
  supervisorName: row.supervisor?.full_name || null,
  zoneName: row.zone?.name || null,
  wardName: row.ward?.name || null,
  code: row.code,
  name: row.name,
  facilityType: row.facility_type,
  addressLine: row.address_line,
  latitude: row.latitude !== null ? Number(row.latitude) : null,
  longitude: row.longitude !== null ? Number(row.longitude) : null,
  status: row.status,
  timezone: row.timezone || row.metadata?.timezone || null,
  metadata: row.metadata || null,
});

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
  if (req.query.zoneGeographyId) {
    if (!isGeographyInScope(req, req.query.zoneGeographyId)) {
      throw new AppError('zoneGeographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.zone_geography_id = req.query.zoneGeographyId;
  }
  if (req.query.wardGeographyId) {
    if (!isGeographyInScope(req, req.query.wardGeographyId)) {
      throw new AppError('wardGeographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.ward_geography_id = req.query.wardGeographyId;
  }
  if (req.query.supervisorUserId) {
    where.supervisor_user_id = req.query.supervisorUserId;
  }
  if (req.query.search) {
    const q = sanitizeText(req.query.search, 120);
    where[Op.or] = [{ name: { [Op.iLike]: `%${q}%` } }, { code: { [Op.iLike]: `%${q}%` } }];
  }

  const { rows, count } = await Facility.findAndCountAll({
    where,
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
      { model: PlatformUser, as: 'supervisor', attributes: ['id', 'full_name'], required: false },
    ],
    order: [['name', 'ASC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => mapFacilityRow(row)),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const createFacility = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  if (!tenantId) {
    throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  }

  const geography = await ensureScopedGeographyInTenant({
    req,
    geographyId: req.body.geographyId || null,
    tenantId,
    field: 'geographyId',
  });
  const zone = await ensureScopedGeographyInTenant({
    req,
    geographyId: req.body.zoneGeographyId || null,
    tenantId,
    field: 'zoneGeographyId',
  });
  const ward = await ensureScopedGeographyInTenant({
    req,
    geographyId: req.body.wardGeographyId || null,
    tenantId,
    field: 'wardGeographyId',
  });
  const supervisor = await ensureSupervisorForTenant({
    supervisorUserId: req.body.supervisorUserId || null,
    tenantId,
  });

  const facilityTimezone = normalizeTimezoneInput(req.body.timezone, { nullable: true });
  const facility = await Facility.create({
    tenant_id: tenantId,
    geography_id: geography?.id || ward?.id || zone?.id || null,
    zone_geography_id: zone?.id || null,
    ward_geography_id: ward?.id || null,
    supervisor_user_id: supervisor?.id || null,
    code: sanitizeText(req.body.code, 120),
    name: sanitizeText(req.body.name, 220),
    facility_type: sanitizeText(req.body.facilityType, 80),
    address_line: req.body.addressLine ? sanitizeText(req.body.addressLine, 300) : null,
    latitude: toFiniteNumber(req.body.latitude),
    longitude: toFiniteNumber(req.body.longitude),
    timezone: facilityTimezone,
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
  const payload = await Facility.findByPk(facility.id, {
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
      { model: PlatformUser, as: 'supervisor', attributes: ['id', 'full_name'], required: false },
    ],
  });
  return mapFacilityRow(payload);
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

  const geography =
    req.body.geographyId !== undefined
      ? await ensureScopedGeographyInTenant({
          req,
          geographyId: req.body.geographyId || null,
          tenantId: facility.tenant_id,
          field: 'geographyId',
        })
      : null;
  const zone =
    req.body.zoneGeographyId !== undefined
      ? await ensureScopedGeographyInTenant({
          req,
          geographyId: req.body.zoneGeographyId || null,
          tenantId: facility.tenant_id,
          field: 'zoneGeographyId',
        })
      : null;
  const ward =
    req.body.wardGeographyId !== undefined
      ? await ensureScopedGeographyInTenant({
          req,
          geographyId: req.body.wardGeographyId || null,
          tenantId: facility.tenant_id,
          field: 'wardGeographyId',
        })
      : null;
  const supervisor =
    req.body.supervisorUserId !== undefined
      ? await ensureSupervisorForTenant({
          supervisorUserId: req.body.supervisorUserId || null,
          tenantId: facility.tenant_id,
        })
      : null;

  const nextGeographyId =
    req.body.geographyId !== undefined
      ? geography?.id || ward?.id || zone?.id || null
      : facility.geography_id;

  const facilityTimezone =
    req.body.timezone !== undefined
      ? normalizeTimezoneInput(req.body.timezone, { nullable: true })
      : facility.timezone;
  await facility.update({
    geography_id: nextGeographyId,
    zone_geography_id:
      req.body.zoneGeographyId !== undefined ? zone?.id || null : facility.zone_geography_id,
    ward_geography_id:
      req.body.wardGeographyId !== undefined ? ward?.id || null : facility.ward_geography_id,
    supervisor_user_id:
      req.body.supervisorUserId !== undefined
        ? supervisor?.id || null
        : facility.supervisor_user_id,
    name: req.body.name ? sanitizeText(req.body.name, 220) : facility.name,
    facility_type: req.body.facilityType || facility.facility_type,
    address_line:
      req.body.addressLine !== undefined ? sanitizeOptionalText(req.body.addressLine, 300) : facility.address_line,
    latitude: req.body.latitude !== undefined ? toFiniteNumber(req.body.latitude) : facility.latitude,
    longitude: req.body.longitude !== undefined ? toFiniteNumber(req.body.longitude) : facility.longitude,
    timezone: facilityTimezone,
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
  const payload = await Facility.findByPk(facility.id, {
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
      { model: PlatformUser, as: 'supervisor', attributes: ['id', 'full_name'], required: false },
    ],
  });
  return mapFacilityRow(payload);
};

const removeFacility = async (req) => {
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

  await facility.update({
    status: 'inactive',
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'facility.delete',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: { mode: 'soft_delete' },
  });
  return { id: facility.id, deleted: true, mode: 'soft_delete' };
};

const getFacilityById = async (req) => {
  const facility = await Facility.findByPk(req.params.id, {
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
      { model: PlatformUser, as: 'supervisor', attributes: ['id', 'full_name'], required: false },
    ],
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

  const [blocks, units] = await Promise.all([
    ToiletBlock.findAll({ where: { facility_id: facility.id }, order: [['name', 'ASC']] }),
    ToiletUnit.findAll({ where: activeToiletWhere({ facility_id: facility.id }), order: [['code', 'ASC']] }),
  ]);
  await ensureQrImagesForToilets(units).catch(() => null);

  return {
    id: facility.id,
    tenantId: facility.tenant_id,
    geographyId: facility.geography_id,
    zoneGeographyId: facility.zone_geography_id || null,
    wardGeographyId: facility.ward_geography_id || null,
    supervisorUserId: facility.supervisor_user_id || null,
    supervisorName: facility.supervisor?.full_name || null,
    zoneName: facility.zone?.name || null,
    wardName: facility.ward?.name || null,
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
  if (!shouldIncludeDeletedToilets(req)) {
    where.deleted_at = { [Op.is]: null };
  }
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
      'timezone',

      'geography_id',
      'zone_geography_id',
      'ward_geography_id',
      'metadata',
    ],
    include: [

      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
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
  if (req.query.wardGeographyId) {
    if (!isGeographyInScope(req, req.query.wardGeographyId)) {
      throw new AppError('wardGeographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }

    facilityInclude.where.ward_geography_id = req.query.wardGeographyId;
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
  const inspectionSummaryMap = await loadInspectionSummariesForToiletIds(rows.map((row) => row.id));
  const qrImageSeedRows = rows.map((row) => ({
    id: row.id,
    qr_code: primaryQrMap.get(String(row.id))?.qr_code || row.qr_code || row.code,
    publicFeedbackUrl: getPublicFeedbackUrl({ toiletUnitId: row.id }),
  }));
  await ensureQrImagesForToilets(qrImageSeedRows).catch(() => null);
  return rows.map((row) => {
    const primaryQr = primaryQrMap.get(String(row.id)) || null;
    const inspectionSummary = inspectionSummaryMap.get(String(row.id)) || null;
    return mapUnitRow(row, {
      resolvedQrCode: primaryQr?.qr_code || row.qr_code || row.code,
      legacyQrCode: row.qr_code || row.code,
      qrId: primaryQr?.id || null,
      qrSchemaVersion: primaryQr?.schema_version || null,
      latestInspection: inspectionSummary?.latest || null,
      previousInspection: inspectionSummary?.previous || null,
    });
  });
};

const normalizeMapLimit = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 1000;
  return Math.min(Math.max(Math.trunc(parsed), 1), 2500);
};

const normalizeBounds = (query = {}) => {
  const north = toFiniteNumber(query.north, null);
  const south = toFiniteNumber(query.south, null);
  const east = toFiniteNumber(query.east, null);
  const west = toFiniteNumber(query.west, null);
  if (![north, south, east, west].every((value) => value !== null)) return null;
  return {
    north: Math.max(north, south),
    south: Math.min(north, south),
    east: Math.max(east, west),
    west: Math.min(east, west),
  };
};

const buildDateRangeFilter = ({ after = null, before = null } = {}) => {
  const where = {};
  const afterDate = after ? new Date(after) : null;
  const beforeDate = before ? new Date(before) : null;
  if (afterDate && Number.isFinite(afterDate.getTime())) where[Op.gte] = afterDate;
  if (beforeDate && Number.isFinite(beforeDate.getTime())) where[Op.lte] = beforeDate;
  return Object.keys(where).length > 0 ? where : null;
};

const normalizeUnitStatusFilter = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return null;
  if (normalized === 'operational' || normalized === 'active') {
    return { [Op.in]: ['clean', 'moderate'] };
  }
  if (normalized === 'needs_cleaning' || normalized === 'needs cleaning' || normalized === 'attention') {
    return { [Op.in]: ['poor', 'critical'] };
  }
  if (normalized === 'inactive' || normalized === 'maintenance' || normalized === 'under maintenance') {
    return { [Op.in]: ['out_of_service'] };
  }
  return normalized;
};

const normalizeComplaintStatusFilter = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return 'all';
  if (['active', 'has_active', 'open'].includes(normalized)) return 'active';
  if (['none', 'no_active'].includes(normalized)) return 'none';
  return normalized;
};

const readFacilityPriority = (facility = {}) => {
  const metadata = facility?.metadata && typeof facility.metadata === 'object' ? facility.metadata : {};
  return (
    metadata.priority ||
    metadata.riskPriority ||
    metadata.usagePriority ||
    metadata.category ||
    null
  );
};

const readFacilityFootfall = (facility = {}) => {
  const metadata = facility?.metadata && typeof facility.metadata === 'object' ? facility.metadata : {};
  return (
    metadata.footfall ||
    metadata.dailyFootfall ||
    metadata.averageFootfall ||
    metadata.expectedUsersPerDay ||
    null
  );
};

const listToiletMap = async (req) => {
  const bounds = normalizeBounds(req.query || {});
  const andFilters = [];
  const where = activeToiletWhere();
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
      'timezone',
      'geography_id',
      'zone_geography_id',
      'ward_geography_id',
      'metadata',
    ],
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
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

  const statusFilter = normalizeUnitStatusFilter(req.query.status);
  if (statusFilter) {
    where.status = statusFilter;
  }

  if (req.query.sector) {
    const normalizedSector = normalizeSectorCode(req.query.sector);
    if (normalizedSector) where.sector_code = normalizedSector;
  }

  if (req.query.wardGeographyId) {
    if (!isGeographyInScope(req, req.query.wardGeographyId)) {
      throw new AppError('wardGeographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    facilityInclude.where.ward_geography_id = req.query.wardGeographyId;
  }

  if (req.query.zoneGeographyId) {
    if (!isGeographyInScope(req, req.query.zoneGeographyId)) {
      throw new AppError('zoneGeographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    facilityInclude.where.zone_geography_id = req.query.zoneGeographyId;
  }

  const scoreFilter = {};
  const scoreMin = toFiniteNumber(req.query.scoreMin, null);
  const scoreMax = toFiniteNumber(req.query.scoreMax, null);
  if (scoreMin !== null) scoreFilter[Op.gte] = Math.max(0, Math.min(100, scoreMin));
  if (scoreMax !== null) scoreFilter[Op.lte] = Math.max(0, Math.min(100, scoreMax));
  if (Object.keys(scoreFilter).length > 0) where.latest_score = scoreFilter;

  const inspectedAtFilter = buildDateRangeFilter({
    after: req.query.lastInspectedAfter || req.query.inspectedAfter,
    before: req.query.lastInspectedBefore || req.query.inspectedBefore,
  });
  if (inspectedAtFilter) where.last_inspection_at = inspectedAtFilter;

  const query = sanitizeOptionalText(req.query.q || req.query.search, 120);
  if (query) {
    const like = `%${query}%`;
    andFilters.push({
      [Op.or]: [
        { code: { [Op.iLike]: like } },
        { qr_code: { [Op.iLike]: like } },
        { location_label: { [Op.iLike]: like } },
        { '$Facility.name$': { [Op.iLike]: like } },
        { '$Facility.address_line$': { [Op.iLike]: like } },
      ],
    });
  }

  if (bounds) {
    const latRange = { [Op.between]: [bounds.south, bounds.north] };
    const lngRange = { [Op.between]: [bounds.west, bounds.east] };
    andFilters.push({
      [Op.or]: [
        { latitude: latRange, longitude: lngRange },
        {
          latitude: { [Op.is]: null },
          longitude: { [Op.is]: null },
          '$Facility.latitude$': latRange,
          '$Facility.longitude$': lngRange,
        },
      ],
    });
  }

  if (andFilters.length > 0) {
    where[Op.and] = andFilters;
  }

  const rows = await ToiletUnit.findAll({
    where,
    include: [facilityInclude],
    order: [
      ['last_inspection_at', 'DESC'],
      ['code', 'ASC'],
    ],
    limit: normalizeMapLimit(req.query.limit),
    subQuery: false,
  });

  const toiletIds = rows.map((row) => row.id);
  const activeComplaintRows =
    toiletIds.length > 0
      ? await Complaint.findAll({
          where: {
            toilet_unit_id: { [Op.in]: toiletIds },
            status: { [Op.in]: ['open', 'assigned'] },
          },
          attributes: ['toilet_unit_id', [fn('COUNT', col('id')), 'count']],
          group: ['toilet_unit_id'],
          raw: true,
        })
      : [];
  const activeComplaintCountByToilet = new Map(
    activeComplaintRows.map((row) => [String(row.toilet_unit_id), Number(row.count || 0)])
  );

  const complaintStatusFilter = normalizeComplaintStatusFilter(req.query.complaintStatus);
  const severityFilter = String(req.query.severity || 'all').trim().toLowerCase();
  const expectedInspectionDays = toFiniteNumber(req.query.expectedInspectionDays, 7) || 7;
  const now = Date.now();

  return rows
    .map((row) => {
      const lat =
        row.latitude !== null && row.latitude !== undefined
          ? Number(row.latitude)
          : row.Facility?.latitude !== null && row.Facility?.latitude !== undefined
            ? Number(row.Facility.latitude)
            : null;
      const lng =
        row.longitude !== null && row.longitude !== undefined
          ? Number(row.longitude)
          : row.Facility?.longitude !== null && row.Facility?.longitude !== undefined
            ? Number(row.Facility.longitude)
            : null;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

      const latestScore = toFiniteNumber(row.latest_score, null);
      const activeComplaintsCount = activeComplaintCountByToilet.get(String(row.id)) || 0;
      if (complaintStatusFilter === 'active' && activeComplaintsCount === 0) return null;
      if (complaintStatusFilter === 'none' && activeComplaintsCount > 0) return null;

      const risk = computeToiletRiskWeight({
        latestScore,
        activeComplaintsCount,
        lastInspectionAt: row.last_inspection_at || null,
        expectedInspectionDays,
        dirtyFrequency: row.dirty_frequency,
        lowPerformanceFrequency: row.low_performance_frequency,
        priority: readFacilityPriority(row.Facility),
        footfall: readFacilityFootfall(row.Facility),
        now,
      });
      if (severityFilter === 'critical' && risk.riskWeight < 70 && !(latestScore !== null && latestScore < 55)) {
        return null;
      }
      if (
        (severityFilter === 'warning' || severityFilter === 'moderate') &&
        (risk.riskWeight < 40 || risk.riskWeight >= 70)
      ) {
        return null;
      }
      if (['good', 'clean', 'low'].includes(severityFilter) && risk.riskWeight >= 40) {
        return null;
      }

      return {
        id: row.id,
        toiletCode: row.code || row.qr_code || null,
        name: row.location_label || row.code || row.Facility?.name || 'Toilet',
        lat,
        lng,
        latitude: lat,
        longitude: lng,
        latestScore,
        starRating: latestScore === null ? null : Number((latestScore / 20).toFixed(1)),
        riskWeight: risk.riskWeight,
        riskWeightNormalized: risk.riskWeightNormalized,
        riskBreakdown: risk.breakdown,
        scoreConfidence: risk.scoreConfidence,
        status: row.status || null,
        ward: row.Facility?.ward?.name || null,
        wardGeographyId: row.Facility?.ward_geography_id || null,
        zone: row.Facility?.zone?.name || null,
        zoneGeographyId: row.Facility?.zone_geography_id || null,
        facilityId: row.facility_id,
        facilityName: row.Facility?.name || null,
        timezone: row.timezone || row.Facility?.timezone || row.Facility?.metadata?.timezone || null,
        timezoneSource: row.timezone ? 'toilet' : row.Facility?.timezone ? 'facility' : 'tenant',
        locationLabel: row.location_label || row.Facility?.address_line || row.Facility?.name || null,
        lastInspectionAt: row.last_inspection_at || null,
        activeComplaintsCount,
        totalInspections: Number(row.total_inspections || 0),
      };
    })
    .filter(Boolean);
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
      attributes: ['id', 'facility_id', 'code', 'name'],
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

    const toiletNameForCode =
      sanitizeText(
        req.body.toiletName ||
          req.body.name ||
          req.body.unitName ||
          req.body.locationLabel ||
          req.body.location_label,
        220
      ) ||
      sanitizeText(unitType, 80) ||
      'TOILET';

    const isAutoGeneratedCode = !requestedCode;
    let unitCode = requestedCode
      ? requestedCode.toUpperCase()
      : await buildAutoToiletId({ facility, toiletBlock, toiletName: toiletNameForCode, transaction });

    const legacyQrCode = normalizePermanentQrCode(
      req.body.permanentQrCode || req.body.qrCode || unitCode
    );

    let duplicateCode = await findToiletUnitCodeConflict({
      facilityId: facility.id,
      code: unitCode,
      transaction,
    });
    if (duplicateCode && isAutoGeneratedCode) {
      for (let attempt = 0; attempt < 32 && duplicateCode; attempt += 1) {
        unitCode = await buildAutoToiletId({
          facility,
          toiletBlock,
          toiletName: toiletNameForCode,
          transaction,
        });
        duplicateCode = await findToiletUnitCodeConflict({
          facilityId: facility.id,
          code: unitCode,
          transaction,
        });
      }
    }
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
        timezone: normalizeTimezoneInput(req.body.timezone, { nullable: true }),
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

const loadScopedToiletUnitForLifecycle = async (req) => {
  const toilet = await ToiletUnit.findByPk(req.params.id, {
    include: [
      {
        model: Facility,
        attributes: ['id', 'tenant_id', 'status'],
        required: false,
      },
    ],
  });
  if (!toilet) {
    throw new AppError('Toilet unit not found', 404, { code: 'TOILET_NOT_FOUND' });
  }
  const tenantId = toilet.Facility?.tenant_id || null;
  if (!req.user.isSuperAdmin && tenantId !== req.user.tenantId) {
    throw new AppError('Toilet out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, toilet.facility_id)) {
    throw new AppError('Toilet out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return { toilet, tenantId };
};

const lifecycleReason = (req) => sanitizeOptionalText(req.body?.reason || req.body?.lifecycleReason, 500);

const deactivateToiletUnit = async (req) => {
  const { toilet, tenantId } = await loadScopedToiletUnitForLifecycle(req);
  if (isToiletDeleted(toilet)) {
    throw new AppError('This toilet is no longer available for inspection.', 410, {
      code: 'TOILET_DELETED',
    });
  }
  const now = new Date();
  await toilet.update({
    status: 'out_of_service',
    deactivated_at: toilet.deactivated_at || now,
    lifecycle_reason: lifecycleReason(req),
    lifecycle_updated_by: req.user?.id || null,
    updated_at: now,
  });
  await createAuditLog({
    req,
    action: 'toilet_unit.deactivate',
    entityType: 'toilet_unit',
    entityId: toilet.id,
    tenantId,
  });
  return mapUnitRow(toilet);
};

const reactivateToiletUnit = async (req) => {
  const { toilet, tenantId } = await loadScopedToiletUnitForLifecycle(req);
  if (isToiletDeleted(toilet)) {
    throw new AppError('Deleted toilets cannot be reactivated from normal tenant screens', 410, {
      code: 'TOILET_DELETED',
    });
  }
  const now = new Date();
  await toilet.update({
    status: req.body?.status || 'moderate',
    deactivated_at: null,
    lifecycle_reason: lifecycleReason(req),
    lifecycle_updated_by: req.user?.id || null,
    updated_at: now,
  });
  await createAuditLog({
    req,
    action: 'toilet_unit.reactivate',
    entityType: 'toilet_unit',
    entityId: toilet.id,
    tenantId,
  });
  return mapUnitRow(toilet);
};

const softDeleteToiletUnit = async (req) => {
  const { toilet, tenantId } = await loadScopedToiletUnitForLifecycle(req);
  const now = new Date();
  await toilet.update({
    status: 'out_of_service',
    deactivated_at: toilet.deactivated_at || now,
    deleted_at: toilet.deleted_at || now,
    lifecycle_reason: lifecycleReason(req),
    lifecycle_updated_by: req.user?.id || null,
    updated_at: now,
  });
  await createAuditLog({
    req,
    action: 'toilet_unit.delete',
    entityType: 'toilet_unit',
    entityId: toilet.id,
    tenantId,
    details: { mode: 'soft_delete' },
  });
  return { id: toilet.id, deleted: true, mode: 'soft_delete' };
};

const createUnitsBulk = async (req) => {
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 2 || quantity > 200) {
    throw new AppError('quantity must be an integer between 2 and 200 for bulk create', 400, {
      code: 'INVALID_BULK_QUANTITY',
    });
  }

  if (sanitizeText(req.body.code, 120)) {
    throw new AppError('Manual code is not allowed in bulk create. Leave code empty.', 400, {
      code: 'BULK_CODE_NOT_ALLOWED',
    });
  }
  if (sanitizeText(req.body.permanentQrCode || req.body.qrCode, 180)) {
    throw new AppError('Manual QR value is not allowed in bulk create. Leave QR empty.', 400, {
      code: 'BULK_QR_NOT_ALLOWED',
    });
  }

  const createdUnits = [];
  const originalBody = req.body;
  try {
    for (let index = 0; index < quantity; index += 1) {
      req.body = {
        ...originalBody,
        code: undefined,
        qrCode: undefined,
        permanentQrCode: undefined,
      };
      const unit = await createUnit(req);
      createdUnits.push(unit);
    }
  } finally {
    req.body = originalBody;
  }

  return {
    quantityRequested: quantity,
    quantityCreated: createdUnits.length,
    units: createdUnits,
  };
};

module.exports = {
  listTenants,
  createTenant,
  patchTenant,
  getOwnTenantProfile,
  patchOwnTenantProfile,
  getOwnTenantAiScoringMode,
  patchOwnTenantAiScoringMode,
  listGeographyTree,
  listGeographyOptions,
  createGeography,
  patchGeography,
  removeGeography,
  listFacilities,
  createFacility,
  patchFacility,
  removeFacility,
  getFacilityById,
  listBlocks,
  createBlock,
  listUnits,
  listToiletMap,
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
  buildAutoToiletId,
  createUnit,
  deactivateToiletUnit,
  reactivateToiletUnit,
  softDeleteToiletUnit,
  createUnitsBulk,
};
