const crypto = require('crypto');
const { Op, QueryTypes, fn, col } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const AppError = require('../../core/errors/AppError');
const {
  sequelize,
  Tenant,
  Geography,
  GeographyImportJob,
  TenantGeographyAssignment,
  GeographyExternalIdentifier,
  GeographyMigrationReview,
  GlobalGeographySource,
  Facility,
  FacilityQrCode,
  ToiletBlock,
  ToiletUnit,
  ToiletQrCode,
  WorkerAssignment,
  PlatformUser,
  UserRole,
  Role,
  Complaint,
  SuperAdminApproval,
} = require('../../models');
const { createAuditLog } = require('../audit/audit.service');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const {
  EMPTY_SCOPE_UUID,
  uniqueIds,
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
  isGeographyInScope,
} = require('../../core/rbac/scopeWhere');
const {
  getQrImageUrl,
  getFeedbackQrImageUrl,
  getPublicFeedbackUrl,
  ensureAllQrImagesForToilet,
  ensureQrImagesForToilets,
} = require('./toiletQr.service');
const {
  QR_SCHEMA_VERSION: FACILITY_QR_SCHEMA_VERSION,
  buildFacilityPrintableLabel,
  buildFacilityQrResolveUrl,
  buildFacilityQrToken,
  ensureFacilityQrImage,
  getFacilityQrImageUrl,
  hashFacilityQrToken,
} = require('./facilityQr.service');
const { haversineMeters } = require('../publicApi/toiletPublicFilters');
const { runtimeConfig } = require('../../config/runtime');
const { computeToiletRiskWeight } = require('./toiletMapRisk.helper');
const { getDefaultTimezone, isValidIanaTimezone, normalizeTimezone } = require('../../utils/timezone');
<<<<<<< HEAD
const { resolveOrCreateTenantGeographyFromGlobal } = require('../geography-master/activation.service');
=======
const {
  AI_SCORING_POLICY_VERSION,
  AI_SCORING_MODES,
  resolveAiScoringMode,
} = require('../analysis/aiInspectionScoring.service');
>>>>>>> beddd57f62b9c570ea8cfe3d2b492da90c1e890d

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

const normalizeLocationLabel = (value) => String(value || '').trim().toLowerCase();

const findPlatformGeographyByNameAndParent = async ({ level, name, parentId = undefined }) => {
  const normalizedName = normalizeLocationLabel(name);
  if (!level || !normalizedName) return null;

  const where = {
    tenant_id: null,
    is_active: true,
    level,
    normalized_name: normalizedName,
  };
  if (parentId !== undefined) {
    where.parent_id = parentId || null;
  }

  return Geography.findOne({
    where,
    attributes: ['id', 'parent_id', 'level', 'name', 'global_geography_id', 'master_geography_id'],
    order: [['is_platform_managed', 'DESC'], ['name', 'ASC']],
  });
};

const resolvePlatformSeedIdFromLocationNames = async (locationNames = {}) => {
  const countryName = String(locationNames.countryName || '').trim();
  const stateName = String(locationNames.stateName || '').trim();
  const districtName = String(locationNames.districtName || '').trim();
  const cityName = String(locationNames.cityName || '').trim();

  const country = await findPlatformGeographyByNameAndParent({
    level: 'country',
    name: countryName,
    parentId: null,
  });
  if (!country) return null;

  const state = stateName
    ? await findPlatformGeographyByNameAndParent({
        level: 'state',
        name: stateName,
        parentId: country.id,
      })
    : null;
  if (stateName && !state) return country.id;

  const district = districtName && state
    ? await findPlatformGeographyByNameAndParent({
        level: 'district',
        name: districtName,
        parentId: state.id,
      })
    : null;
  if (districtName && state && !district) return state.id;

  if (cityName && state) {
    if (district) {
      const directCity = await findPlatformGeographyByNameAndParent({
        level: 'city',
        name: cityName,
        parentId: district.id,
      });
      if (directCity) return directCity.id;
    }

    const cityCandidates = await Geography.findAll({
      where: {
        tenant_id: null,
        is_active: true,
        level: 'city',
        normalized_name: normalizeLocationLabel(cityName),
      },
      attributes: ['id', 'parent_id'],
      order: [['name', 'ASC']],
    });

    for (const candidate of cityCandidates) {
      const parent = candidate.parent_id
        ? await Geography.findByPk(candidate.parent_id, {
            attributes: ['id', 'parent_id', 'level', 'normalized_name'],
          })
        : null;
      if (!parent) continue;
      if (district && String(parent.id) === String(district.id)) return candidate.id;
      if (parent.level !== 'district') continue;
      if (String(parent.parent_id || '') === String(state.id)) return candidate.id;
    }

    return district?.id || state.id;
  }

  return district?.id || state?.id || country.id;
};

const resolveLiveScopeSeedIds = async ({ req, tenantId = null }) => {
  if (req.user?.isSuperAdmin) return null;
  const requestedSeedIds = uniqueIds([
    ...(Array.isArray(req.user?.scopeGeographyIds) ? req.user.scopeGeographyIds : []),
    req.user?.geographyId,
    req.user?.scopeId,
  ]);
  if (requestedSeedIds.length > 0) {
    const rows = await Geography.findAll({
      where: { id: { [Op.in]: requestedSeedIds }, is_active: true },
      attributes: ['id', 'global_geography_id', 'master_geography_id'],
    });
    const expandedSeedIds = uniqueIds([
      ...requestedSeedIds,
      ...rows.flatMap((row) => [row.id, row.global_geography_id, row.master_geography_id]),
    ])
      .filter(Boolean)
      .map(String);
    return expandedSeedIds;
  }
  const effectiveTenantId = tenantId || req.user?.tenantId || null;
  if (!effectiveTenantId) return [];
  const tenant = await Tenant.findByPk(effectiveTenantId, {
    attributes: ['root_geography_id', 'country_name', 'state_name', 'district_name', 'city_name'],
  });
  if (tenant?.root_geography_id) return [String(tenant.root_geography_id)];

  const derivedSeedId = await resolvePlatformSeedIdFromLocationNames({
    countryName: req.user?.countryName || tenant?.country_name || null,
    stateName: req.user?.stateName || tenant?.state_name || null,
    districtName: req.user?.districtName || tenant?.district_name || null,
    cityName: req.user?.cityName || tenant?.city_name || null,
  });
  return derivedSeedId ? [String(derivedSeedId)] : [];
};

const resolveLiveScopedGeographyIds = async ({ req, tenantId = null }) => {
  if (req.user?.isSuperAdmin) return null;
  const seedIds = await resolveLiveScopeSeedIds({ req, tenantId });
  if (seedIds.length === 0) {
    return [];
  }
  const tenantFilter = tenantId
    ? '(child.tenant_id IS NULL OR child.tenant_id = :tenantId)'
    : 'child.tenant_id IS NULL';
  const rows = await sequelize.query(
    `WITH RECURSIVE scoped_geographies AS (
       SELECT id
       FROM geographies
       WHERE id IN (:seedIds) AND is_active = TRUE
       UNION
       SELECT child.id
       FROM geographies child
       INNER JOIN scoped_geographies parent ON child.parent_id = parent.id
       WHERE child.is_active = TRUE AND ${tenantFilter}
     )
     SELECT id FROM scoped_geographies`,
    {
      replacements: { seedIds, tenantId },
      type: QueryTypes.SELECT,
    }
  );
  return rows.map((row) => String(row.id));
};

const withLiveGeographyScope = async (req, where = {}, { tenantId = null, geographyKey = 'id' } = {}) => {
  if (req.user?.isSuperAdmin) return where;
  const scopedIds = await resolveLiveScopedGeographyIds({ req, tenantId });
  if (!scopedIds) return where;
  return {
    ...where,
    [geographyKey]: scopedIds.length > 0 ? { [Op.in]: scopedIds } : EMPTY_SCOPE_UUID,
  };
};

const isGeographyInLiveScope = async (req, geographyId, { tenantId = null } = {}) => {
  if (!geographyId) return true;
  if (req.user?.isSuperAdmin) return true;
  if (isGeographyInScope(req, geographyId)) return true;
  const scopeSeedIds = await resolveLiveScopeSeedIds({ req, tenantId });
  const scopeSeeds = new Set(scopeSeedIds);
  const target = await Geography.findByPk(geographyId, {
    attributes: ['id', 'parent_id', 'tenant_id', 'is_active', 'global_geography_id', 'master_geography_id'],
  });
  if (!target || target.is_active === false) return false;
  const targetComparableIds = new Set(
    [target.id, target.global_geography_id, target.master_geography_id]
      .filter(Boolean)
      .map((id) => String(id))
  );
  let cursorId = geographyId;
  const seen = new Set();
  while (cursorId && !seen.has(String(cursorId))) {
    if (scopeSeeds.has(String(cursorId))) return true;
    seen.add(String(cursorId));
    const row = await Geography.findByPk(cursorId, {
      attributes: ['id', 'parent_id', 'tenant_id', 'is_active', 'global_geography_id', 'master_geography_id'],
    });
    if (!row || row.is_active === false) return false;
    if ([row.id, row.global_geography_id, row.master_geography_id].filter(Boolean).some((id) => scopeSeeds.has(String(id)))) {
      return true;
    }
    if (tenantId && row.tenant_id !== null && String(row.tenant_id) !== String(tenantId)) return false;
    cursorId = row.parent_id || null;
  }

  for (const seedId of scopeSeedIds) {
    let seedCursorId = seedId;
    const seedSeen = new Set();
    while (seedCursorId && !seedSeen.has(String(seedCursorId))) {
      if (String(seedCursorId) === String(geographyId)) return true;
      seedSeen.add(String(seedCursorId));
      const row = await Geography.findByPk(seedCursorId, {
        attributes: ['id', 'parent_id', 'tenant_id', 'is_active', 'global_geography_id', 'master_geography_id'],
      });
      if (!row || row.is_active === false) break;
      if ([row.id, row.global_geography_id, row.master_geography_id].filter(Boolean).some((id) => targetComparableIds.has(String(id)))) {
        return true;
      }
      if (tenantId && row.tenant_id !== null && String(row.tenant_id) !== String(tenantId)) break;
      seedCursorId = row.parent_id || null;
    }
  }

  return false;
};

const resolveCanonicalPlatformParentId = async (geographyId, { seen = new Set() } = {}) => {
  const normalizedId = String(geographyId || '').trim();
  if (!normalizedId) return null;
  if (seen.has(normalizedId)) return normalizedId;
  seen.add(normalizedId);

  const row = await Geography.findByPk(normalizedId, {
    attributes: [
      'id',
      'parent_id',
      'tenant_id',
      'level',
      'normalized_name',
      'global_geography_id',
      'master_geography_id',
    ],
  });
  if (!row) return normalizedId;
  if (row.tenant_id === null) {
    return row.master_geography_id || row.global_geography_id || row.id;
  }
  if (row.master_geography_id || row.global_geography_id) {
    return row.master_geography_id || row.global_geography_id;
  }

  const canonicalParentId = row.parent_id
    ? await resolveCanonicalPlatformParentId(row.parent_id, { seen })
    : null;

  const platformMatch = await Geography.findOne({
    where: {
      tenant_id: null,
      level: row.level,
      normalized_name: row.normalized_name,
      parent_id: canonicalParentId || null,
    },
    attributes: ['id'],
  });
  return platformMatch?.id || normalizedId;
};

const withFacilityScope = (req, where = {}, facilityKey = 'facility_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'facility', {
    tenantKey: 'tenant_id',
    facilityKey,
  });
};

const buildFacilityIncludeScopeWhere = async (req) => {
  let where = {};
  where = withTenantScope(req, where);
  where = await withLiveGeographyScope(req, where, {
    tenantId: tenantScope(req, req.query?.tenantId),
    geographyKey: 'geography_id',
  });
  where = withFacilityScope(req, where, 'id');
  return where;
};

const GEO_LEVEL_SEQUENCE = ['country', 'state', 'district', 'city', 'zone', 'ward', 'cluster'];
const GEO_LEVEL_RANK = new Map(GEO_LEVEL_SEQUENCE.map((level, index) => [level, index]));
const TENANT_SCOPE_LEVELS = new Set(['country', 'state', 'district', 'city', 'zone']);
const OFFICIAL_PLATFORM_MANAGED_LEVELS = new Set(['country', 'state', 'district', 'city']);
const TENANT_MANAGED_LEVELS = new Set(['zone', 'ward', 'cluster']);
const geographyOptionsCache = new Map();
const GEOGRAPHY_OPTIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const clearGeographyOptionsCache = () => geographyOptionsCache.clear();
const STRICT_GOOGLE_MAP_LEVELS = new Set(['country', 'state', 'district', 'city']);
const FLEXIBLE_OPERATIONAL_LEVELS = new Set(['zone', 'ward']);
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

const normalizeGeographyName = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

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

const isValidLatitude = (value) => Number.isFinite(value) && value >= -90 && value <= 90;
const isValidLongitude = (value) => Number.isFinite(value) && value >= -180 && value <= 180;

const normalizeCoordinatePair = ({ latitude, longitude, field = 'location' }) => {
  const lat = toFiniteNumber(latitude);
  const lng = toFiniteNumber(longitude);
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    throw new AppError(`${field} requires valid latitude and longitude`, 400, {
      code: 'LOCATION_REQUIRED',
    });
  }
  return { latitude: lat, longitude: lng };
};

const normalizeMapSelectionPayload = (body = {}) => ({
  mapDisplayAddress: sanitizeOptionalText(
    body.mapDisplayAddress || body.displayAddress || body.placeAddress,
    500
  ),
  mapPlaceId: sanitizeOptionalText(body.mapPlaceId || body.placeId, 220),
  mapSource: sanitizeOptionalText(body.mapSource || body.placeSource || body.source, 80),
});

const normalizeMapSelectionWithBounds = (body = {}, { required = false, field = 'map selection' } = {}) => {
  const mapSelection = normalizeMapSelectionPayload(body);
  const latitude = toFiniteNumber(body.latitude ?? body.lat ?? body.centroidLatitude);
  const longitude = toFiniteNumber(body.longitude ?? body.lng ?? body.centroidLongitude);
  const bounds = parseBounds(body.bounds);
  if (required) {
    normalizeCoordinatePair({ latitude, longitude, field });
  }
  return {
    ...mapSelection,
    latitude,
    longitude,
    bounds,
  };
};

const hasValidBounds = (bounds) =>
  Boolean(
    bounds &&
      isValidLatitude(toFiniteNumber(bounds.north)) &&
      isValidLatitude(toFiniteNumber(bounds.south)) &&
      isValidLongitude(toFiniteNumber(bounds.east)) &&
      isValidLongitude(toFiniteNumber(bounds.west))
  );

const isGoogleMapSelectionSource = (value) => /^google_/i.test(String(value || '').trim());

const assertStrictGoogleMapSelection = ({
  latitude,
  longitude,
  placeId,
  bounds,
  source,
  field = 'map selection',
}) => {
  normalizeCoordinatePair({ latitude, longitude, field });
  if (!sanitizeOptionalText(placeId, 220)) {
    throw new AppError(`${field} must include a Google Maps place selection`, 400, {
      code: 'MAP_PLACE_REQUIRED',
    });
  }
  if (!hasValidBounds(bounds)) {
    throw new AppError(`${field} must include valid map bounds`, 400, {
      code: 'MAP_BOUNDS_REQUIRED',
    });
  }
  if (!isGoogleMapSelectionSource(source)) {
    throw new AppError(`${field} must come from Google Maps search selection`, 400, {
      code: 'MAP_SELECTION_INVALID',
    });
  }
};

const scopeNameFieldForLevel = (level) => {
  const normalized = String(level || '').toLowerCase();
  return `${normalized}Name`;
};

const resolveOrCreateTenantRootGeography = async ({
  tenantId,
  scopeLevel,
  locationNames,
  mapSelection,
  transaction = null,
}) => {
  if (!tenantId || !scopeLevel || !TENANT_SCOPE_LEVELS.has(scopeLevel)) return null;
  const targetName = sanitizeOptionalText(locationNames?.[scopeNameFieldForLevel(scopeLevel)], 200);
  if (!targetName) return null;
  const normalizedMapSelection = normalizeMapSelectionWithBounds(mapSelection || {}, {
    required: true,
    field: `${scopeLevel} map selection`,
  });
  if (STRICT_GOOGLE_MAP_LEVELS.has(scopeLevel)) {
    assertStrictGoogleMapSelection({
      latitude: normalizedMapSelection.latitude,
      longitude: normalizedMapSelection.longitude,
      placeId: normalizedMapSelection.mapPlaceId,
      bounds: normalizedMapSelection.bounds,
      source: normalizedMapSelection.mapSource,
      field: `${scopeLevel} map selection`,
    });
  }

  const parent = null;
  if (normalizedMapSelection.mapPlaceId) {
    const duplicate = await Geography.findOne({
      where: {
        tenant_id: tenantId,
        parent_id: parent?.id || null,
        level: scopeLevel,
        [Op.or]: [
          { map_place_id: normalizedMapSelection.mapPlaceId },
          { place_id: normalizedMapSelection.mapPlaceId },
        ],
      },
      transaction,
    });
    if (duplicate) return duplicate;
  }

  const existingByName = await Geography.findOne({
    where: {
      tenant_id: tenantId,
      parent_id: parent?.id || null,
      level: scopeLevel,
      name: { [Op.iLike]: targetName },
    },
    transaction,
  });
  if (existingByName) return existingByName;

  const code = await resolveUniqueGeographyCode({
    tenantId,
    level: scopeLevel,
    rawCode: null,
    name: targetName,
  });
  return await Geography.create(
    {
      tenant_id: tenantId,
      parent_id: null,
      level: scopeLevel,
      code,
      name: targetName,
      latitude: normalizedMapSelection.latitude,
      longitude: normalizedMapSelection.longitude,
      centroid_latitude: normalizedMapSelection.latitude,
      centroid_longitude: normalizedMapSelection.longitude,
      bounds: normalizedMapSelection.bounds,
      bounds_north: normalizedMapSelection.bounds?.north ?? null,
      bounds_south: normalizedMapSelection.bounds?.south ?? null,
      bounds_east: normalizedMapSelection.bounds?.east ?? null,
      bounds_west: normalizedMapSelection.bounds?.west ?? null,
      map_display_address: normalizedMapSelection.mapDisplayAddress,
      map_place_id: normalizedMapSelection.mapPlaceId,
      map_source: normalizedMapSelection.mapSource,
      formatted_address: normalizedMapSelection.mapDisplayAddress,
      place_id: normalizedMapSelection.mapPlaceId,
      scope_type: scopeLevel,
      scope_name: targetName,
      is_operational_zone: scopeLevel === 'zone',
    },
    { transaction }
  );
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

const circleGeoJsonFromCenterRadius = ({
  latitude,
  longitude,
  radiusMeters,
  segments = 32,
}) => {
  const centerLat = toFiniteNumber(latitude);
  const centerLng = toFiniteNumber(longitude);
  const radius = toFiniteNumber(radiusMeters);
  if (
    !isValidLatitude(centerLat) ||
    !isValidLongitude(centerLng) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return null;
  }

  const pointCount = Math.max(12, Math.round(toFiniteNumber(segments) || 32));
  const latRadians = (centerLat * Math.PI) / 180;
  const latMetersPerDegree = 111320;
  const lngMetersPerDegree = Math.max(111320 * Math.cos(latRadians), 1);
  const ring = [];

  for (let index = 0; index < pointCount; index += 1) {
    const angle = (2 * Math.PI * index) / pointCount;
    const lat = centerLat + (Math.sin(angle) * radius) / latMetersPerDegree;
    const lng = centerLng + (Math.cos(angle) * radius) / lngMetersPerDegree;
    ring.push([lng, lat]);
  }

  if (ring.length > 0) {
    ring.push([...ring[0]]);
  }

  return {
    type: 'Polygon',
    coordinates: [ring],
  };
};

const deriveGeometryPayload = (body = {}) => {
  const geometryType = String(body.geometryType || '').trim().toLowerCase() || null;
  let geojson = body.geojson && typeof body.geojson === 'object' ? body.geojson : null;
  const explicitCentroidLatitude = toFiniteNumber(
    body.centroidLatitude ?? body.latitude ?? body.lat
  );
  const explicitCentroidLongitude = toFiniteNumber(
    body.centroidLongitude ?? body.longitude ?? body.lng
  );
  const explicitCentroidProvided =
    explicitCentroidLatitude !== null && explicitCentroidLongitude !== null;

  let centroidLatitude = explicitCentroidLatitude;
  let centroidLongitude = explicitCentroidLongitude;
  let boundaryCenterLatitude = toFiniteNumber(body.boundaryCenterLatitude);
  let boundaryCenterLongitude = toFiniteNumber(body.boundaryCenterLongitude);
  let boundaryRadiusMeters = toFiniteNumber(body.boundaryRadiusMeters);
  let bounds = parseBounds(body.bounds);
  let areaSqKm = toFiniteNumber(body.areaSqKm);
  const mapSelection = normalizeMapSelectionPayload(body);

  if (geometryType === 'polygon' && geojson) {
    const points = polygonPointsFromGeoJson(geojson);
    const boundsFromPolygon = pointsToBounds(points);
    const centroid = centroidFromPoints(points);
    if (!bounds && boundsFromPolygon) {
      bounds = boundsFromPolygon;
    }
    if ((centroidLatitude === null || centroidLongitude === null) && centroid) {
      centroidLatitude = centroid.latitude;
      centroidLongitude = centroid.longitude;
    }
    if ((boundaryCenterLatitude === null || boundaryCenterLongitude === null) && centroid) {
      boundaryCenterLatitude = centroid.latitude;
      boundaryCenterLongitude = centroid.longitude;
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
      if (!geojson && boundaryRadiusMeters !== null) {
        geojson = circleGeoJsonFromCenterRadius({
          latitude: centerLat,
          longitude: centerLng,
          radiusMeters: boundaryRadiusMeters,
        });
      }
    }
  }

  return {
    geometryType,
    geojson,
    centroidLatitude,
    centroidLongitude,
    explicitCentroidLatitude,
    explicitCentroidLongitude,
    explicitCentroidProvided,
    boundaryCenterLatitude,
    boundaryCenterLongitude,
    boundaryRadiusMeters,
    bounds,
    areaSqKm,
    boundaryLabel: sanitizeOptionalText(body.boundaryLabel, 220),
    ...mapSelection,
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

const assertMunicipalParentHierarchy = async ({
  tenantId,
  parent,
  childLevel,
  excludeId = null,
}) => {
  const level = String(childLevel || '').trim().toLowerCase();
  const parentLevel = String(parent?.level || '').trim().toLowerCase();

  if (level === 'zone') {
    if (!parent || !['district', 'city'].includes(parentLevel)) {
      throw new AppError('Zone must be created under a district or city', 400, {
        code: 'GEOGRAPHY_PARENT_INVALID',
      });
    }
    const directWardCount = await Geography.count({
      where: {
        tenant_id: tenantId,
        parent_id: parent.id,
        level: 'ward',
        ...(excludeId ? { id: { [Op.ne]: excludeId } } : {}),
      },
    });
    if (directWardCount > 0) {
      throw new AppError(`Move direct ${parentLevel} wards under zones before adding zones to this ${parentLevel}`, 409, {
        code: 'CITY_HAS_DIRECT_WARDS',
      });
    }
    return;
  }

  if (level === 'ward') {
    if (!parent || !['zone', 'district', 'city'].includes(parentLevel)) {
      throw new AppError('Ward must be created under a zone, or directly under a district/city when no zones exist', 400, {
        code: 'GEOGRAPHY_PARENT_INVALID',
      });
    }
    return;
  }

  const immediateParentByLevel = {
    state: 'country',
    district: 'state',
    city: 'district',
  };
  const requiredParentLevel = immediateParentByLevel[level];
  if (requiredParentLevel && parent && parentLevel !== requiredParentLevel) {
    throw new AppError(`${level} must be created under ${requiredParentLevel}`, 400, {
      code: 'GEOGRAPHY_PARENT_INVALID',
    });
  }
};

const getScopedActorGeographyLevel = (req) => {
  if (req.user?.isSuperAdmin) return null;
  const scopeLevel = normalizeGeographyLevel(req.user?.scopeLevel);
  if (!scopeLevel) return null;
  if (scopeLevel === 'cluster') return null;
  return scopeLevel;
};

const assertScopedGeographyCreateAllowed = ({ req, level, parentId }) => {
  const actorScopeLevel = getScopedActorGeographyLevel(req);
  if (!actorScopeLevel) return;

  const actorRank = GEO_LEVEL_RANK.get(actorScopeLevel);
  const targetRank = GEO_LEVEL_RANK.get(level);
  if (actorRank === undefined || targetRank === undefined) return;

  if (targetRank <= actorRank) {
    throw new AppError(
      `${actorScopeLevel} admin can create only lower hierarchy records`,
      403,
      { code: 'HIERARCHY_SCOPE_FORBIDDEN' }
    );
  }

  if (!parentId) {
    throw new AppError('parentId is required for scoped hierarchy creation', 400, {
      code: 'GEOGRAPHY_PARENT_REQUIRED',
    });
  }
};

const assertScopedGeographyMutationAllowed = ({ req, level }) => {
  const actorScopeLevel = getScopedActorGeographyLevel(req);
  if (!actorScopeLevel) return;

  const actorRank = GEO_LEVEL_RANK.get(actorScopeLevel);
  const targetRank = GEO_LEVEL_RANK.get(level);
  if (actorRank === undefined || targetRank === undefined) return;

  if (targetRank <= actorRank) {
    throw new AppError(
      `${actorScopeLevel} admin can manage only lower hierarchy records`,
      403,
      { code: 'HIERARCHY_SCOPE_FORBIDDEN' }
    );
  }
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
    mapDisplayAddress: row.map_display_address || null,
    mapPlaceId: row.map_place_id || null,
    mapSource: row.map_source || null,
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
  const selectedAncestry = req.body.rootGeographyId
    ? await assertGeographyMatchesScopeLevel(req.body.rootGeographyId, scopeLevel)
    : null;
  if (OFFICIAL_PLATFORM_MANAGED_LEVELS.has(scopeLevel) && !selectedAncestry) {
    throw new AppError('rootGeographyId is required for official tenant scopes', 400, {
      code: 'ROOT_GEOGRAPHY_REQUIRED',
    });
  }
  const selectedByLevel = new Map((selectedAncestry || []).map((row) => [row.level, row]));
  const countryName = selectedByLevel.get('country')?.name || sanitizeOptionalText(req.body.countryName, 120);
  const stateName = selectedByLevel.get('state')?.name || sanitizeOptionalText(req.body.stateName, 120);
  const districtName = selectedByLevel.get('district')?.name || sanitizeOptionalText(req.body.districtName, 120);
  const cityName = selectedByLevel.get('city')?.name || sanitizeOptionalText(req.body.cityName, 120);
  const zoneName = selectedByLevel.get('zone')?.name || sanitizeOptionalText(req.body.zoneName, 120);
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
  const tenant = await sequelize.transaction(async (transaction) => {
    const createdTenant = await Tenant.create(
      {
        name: tenantName,
        code: tenantCode,
        status: req.body.status || 'active',
        country_code:
          selectedByLevel.get('country')?.country_code || sanitizeOptionalText(req.body.countryCode, 10),
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
      },
      { transaction }
    );
    if (!req.body.rootGeographyId) {
      const rootGeography = await resolveOrCreateTenantRootGeography({
        tenantId: createdTenant.id,
        scopeLevel,
        locationNames: { countryName, stateName, districtName, cityName, zoneName },
        mapSelection: req.body.geographyMapSelection || req.body.mapSelection || req.body,
        transaction,
      });
      if (rootGeography?.id) {
        await createdTenant.update({ root_geography_id: rootGeography.id }, { transaction });
      }
    } else {
      await enableTenantGeographyAncestry({
        tenantId: createdTenant.id,
        ancestry: selectedAncestry,
        createdByUserId: req.user.id,
        transaction,
      });
    }
    return createdTenant;
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
    const requestedLevel = normalizeTenantScopeLevel(
      req.body.scopeLevel || tenant.scope_level || 'city',
      tenant.scope_level || 'city'
    );
    await assertGeographyMatchesScopeLevel(req.body.rootGeographyId, requestedLevel);
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
  masterGeographyId: row.master_geography_id || null,
  globalGeographyId: row.global_geography_id || null,
  level: row.level,
  code: row.code,
  name: row.name,
  asciiName: row.ascii_name || null,
  localName: row.local_name || null,
  normalizedName: row.normalized_name || normalizeGeographyName(row.name),
  externalSource: row.external_source || null,
  externalCode: row.external_code || null,
  externalPlaceId: row.external_place_id || null,
  countryCode: row.country_code || null,
  countryIso2: row.country_iso2 || row.country_code || null,
  countryIso3: row.country_iso3 || null,
  admin1Code: row.admin1_code || null,
  admin2Code: row.admin2_code || null,
  administrativeType: row.administrative_type || null,
  sourceAdministrativeLevel: row.source_administrative_level || null,
  latitude: row.latitude !== null && row.latitude !== undefined ? Number(row.latitude) : null,
  longitude: row.longitude !== null && row.longitude !== undefined ? Number(row.longitude) : null,
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
  boundsNorth: row.bounds_north !== null && row.bounds_north !== undefined ? Number(row.bounds_north) : null,
  boundsSouth: row.bounds_south !== null && row.bounds_south !== undefined ? Number(row.bounds_south) : null,
  boundsEast: row.bounds_east !== null && row.bounds_east !== undefined ? Number(row.bounds_east) : null,
  boundsWest: row.bounds_west !== null && row.bounds_west !== undefined ? Number(row.bounds_west) : null,
  areaSqKm: row.area_sq_km !== null ? Number(row.area_sq_km) : null,
  boundaryLabel: row.boundary_label || null,
  description: row.description || null,
  mapDisplayAddress: row.map_display_address || null,
  mapPlaceId: row.map_place_id || null,
  mapSource: row.map_source || null,
  formattedAddress: row.formatted_address || row.map_display_address || null,
  placeId: row.place_id || row.map_place_id || null,
  scopeType: row.scope_type || row.level || null,
  scopeName: row.scope_name || row.name || null,
  locationStatus: row.location_status || 'mapped',
  isActive: row.is_active !== false,
  isOfficialSource: Boolean(row.is_official_source),
  isPlatformManaged:
    row.is_platform_managed !== undefined && row.is_platform_managed !== null
      ? Boolean(row.is_platform_managed)
      : OFFICIAL_PLATFORM_MANAGED_LEVELS.has(String(row.level || '').toLowerCase()),
  isVerifiedLocalGovernment: Boolean(row.is_verified_local_government),
  isOperationalZone: Boolean(row.is_operational_zone),
  managedBy:
    row.is_platform_managed !== undefined && row.is_platform_managed !== null
      ? Boolean(row.is_platform_managed)
        ? 'platform'
        : 'tenant'
      : OFFICIAL_PLATFORM_MANAGED_LEVELS.has(String(row.level || '').toLowerCase())
        ? 'platform'
        : 'tenant',
});

const addGeographyPaths = async (rows) => {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  let pendingIds = [...new Set(rows.map((row) => row.parent_id).filter(Boolean).map(String))]
    .filter((id) => !byId.has(id));
  while (pendingIds.length > 0) {
    const parents = await Geography.findAll({
      where: { id: { [Op.in]: pendingIds } },
      attributes: ['id', 'parent_id', 'name'],
    });
    parents.forEach((parent) => byId.set(String(parent.id), parent));
    pendingIds = [...new Set(parents.map((parent) => parent.parent_id).filter(Boolean).map(String))]
      .filter((id) => !byId.has(id));
  }
  return rows.map((row) => {
    const names = [];
    const seen = new Set();
    let cursor = row;
    while (cursor && !seen.has(String(cursor.id))) {
      seen.add(String(cursor.id));
      names.unshift(cursor.name);
      cursor = cursor.parent_id ? byId.get(String(cursor.parent_id)) : null;
    }
    return { ...mapGeographyRow(row), path: names.join(' > ') };
  });
};

const loadActiveGeographyAncestry = async (geographyId, { transaction } = {}) => {
  const ancestry = [];
  const seen = new Set();
  let currentId = geographyId || null;
  while (currentId) {
    if (seen.has(String(currentId))) {
      throw new AppError('Geography hierarchy contains a cycle', 409, {
        code: 'GEOGRAPHY_HIERARCHY_CYCLE',
      });
    }
    seen.add(String(currentId));
    const row = await Geography.findByPk(currentId, { transaction });
    if (!row || row.is_active === false) {
      throw new AppError('Selected geography is missing or inactive', 400, {
        code: 'GEOGRAPHY_INACTIVE',
      });
    }
    ancestry.unshift(row);
    currentId = row.parent_id || null;
  }
  return ancestry;
};

const resolveComparableScopeAncestryIds = async ({ req, tenantId = null, transaction = null } = {}) => {
  if (req.user?.isSuperAdmin) return null;

  const seedIds = await resolveLiveScopeSeedIds({ req, tenantId });
  if (!Array.isArray(seedIds) || seedIds.length === 0) return [];

  const resolvedIds = new Set();
  const visited = new Set();
  const queue = [...seedIds];

  while (queue.length > 0) {
    const currentId = String(queue.shift() || '').trim();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);

    const row = await Geography.findByPk(currentId, {
      attributes: ['id', 'parent_id', 'is_active', 'global_geography_id', 'master_geography_id'],
      transaction,
    });
    if (!row || row.is_active === false) continue;

    resolvedIds.add(String(row.id));

    const canonicalId = row.master_geography_id || row.global_geography_id || null;
    if (canonicalId) {
      queue.push(String(canonicalId));
    }
    if (row.parent_id) {
      queue.push(String(row.parent_id));
    }
  }

  return [...resolvedIds];
};

const assertGeographyMatchesScopeLevel = async (geographyId, scopeLevel, options = {}) => {
  const ancestry = await loadActiveGeographyAncestry(geographyId, options);
  const selected = ancestry[ancestry.length - 1];
  if (!selected || selected.level !== scopeLevel) {
    throw new AppError(`rootGeographyId must reference an active ${scopeLevel}`, 400, {
      code: 'GEOGRAPHY_LEVEL_MISMATCH',
    });
  }
  return ancestry;
};

const enableTenantGeographyAncestry = async ({ tenantId, ancestry, createdByUserId, transaction }) => {
  for (const geography of ancestry) {
    const canonicalId = geography.master_geography_id || geography.id;
    const canonical = geography.master_geography_id
      ? await Geography.findByPk(canonicalId, { transaction })
      : geography;
    if (!canonical || canonical.tenant_id !== null) continue;
    await TenantGeographyAssignment.upsert(
      {
        tenant_id: tenantId,
        geography_id: canonicalId,
        is_enabled: true,
        created_by_user_id: createdByUserId || null,
        updated_at: new Date(),
      },
      { transaction }
    );
  }
};

const deriveGeographyLocationState = ({ level, geometryPayload }) => {
  const normalizedLevel = normalizeGeographyLevel(level);
  if (!normalizedLevel) {
    throw new AppError('Invalid geography level', 400, { code: 'GEOGRAPHY_LEVEL_INVALID' });
  }

  if (STRICT_GOOGLE_MAP_LEVELS.has(normalizedLevel)) {
    assertStrictGoogleMapSelection({
      latitude: geometryPayload.explicitCentroidLatitude,
      longitude: geometryPayload.explicitCentroidLongitude,
      placeId: geometryPayload.mapPlaceId,
      bounds: geometryPayload.bounds,
      source: geometryPayload.mapSource,
      field: `${normalizedLevel} map selection`,
    });
    return {
      centroidLatitude: geometryPayload.explicitCentroidLatitude,
      centroidLongitude: geometryPayload.explicitCentroidLongitude,
      locationStatus: 'mapped',
    };
  }

  if (FLEXIBLE_OPERATIONAL_LEVELS.has(normalizedLevel)) {
    if (geometryPayload.explicitCentroidProvided) {
      normalizeCoordinatePair({
        latitude: geometryPayload.explicitCentroidLatitude,
        longitude: geometryPayload.explicitCentroidLongitude,
        field: `${normalizedLevel} centroid`,
      });
      return {
        centroidLatitude: geometryPayload.explicitCentroidLatitude,
        centroidLongitude: geometryPayload.explicitCentroidLongitude,
        locationStatus: 'mapped',
      };
    }
    return {
      centroidLatitude: null,
      centroidLongitude: null,
      locationStatus: 'unmapped',
    };
  }

  if (
    geometryPayload.centroidLatitude !== null ||
    geometryPayload.centroidLongitude !== null
  ) {
    normalizeCoordinatePair({
      latitude: geometryPayload.centroidLatitude,
      longitude: geometryPayload.centroidLongitude,
      field: `${normalizedLevel} centroid`,
    });
    return {
      centroidLatitude: geometryPayload.centroidLatitude,
      centroidLongitude: geometryPayload.centroidLongitude,
      locationStatus: 'mapped',
    };
  }

  return {
    centroidLatitude: null,
    centroidLongitude: null,
    locationStatus: 'unmapped',
  };
};

const listGeographyTree = async (req) => {
  const tenantId = tenantScope(req, req.query.tenantId);
  if (!tenantId) {
    const countries = await Geography.findAll({
      where: { tenant_id: null, level: 'country', is_active: true },
      order: [['name', 'ASC']],
    });
    return countries.map((row) => ({ ...mapGeographyRow(row), children: [] }));
  }

  const tenantRows = await Geography.findAll({
    where: { tenant_id: tenantId, is_active: true },
    order: [['level', 'ASC'], ['name', 'ASC']],
  });
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['root_geography_id'] });
  const byId = new Map(tenantRows.map((row) => [String(row.id), row]));
  let pendingIds = [...new Set([
    ...tenantRows.map((row) => row.parent_id),
    tenant?.root_geography_id,
    ...uniqueIds(req.user?.scopeGeographyIds || []),
  ].filter(Boolean).map(String))].filter((id) => !byId.has(id));
  while (pendingIds.length > 0) {
    const parents = await Geography.findAll({
      where: { id: { [Op.in]: pendingIds }, is_active: true },
    });
    parents.forEach((parent) => byId.set(String(parent.id), parent));
    pendingIds = [...new Set(parents.map((parent) => parent.parent_id).filter(Boolean).map(String))]
      .filter((id) => !byId.has(id));
  }
  let rows = [...byId.values()];
  if (!req.user?.isSuperAdmin) {
    const scopeSeeds = new Set(uniqueIds(req.user?.scopeGeographyIds || []).map(String));
    const visibleIds = new Set();
    for (const row of rows) {
      const path = [];
      let cursor = row;
      while (cursor) {
        path.push(String(cursor.id));
        if (scopeSeeds.has(String(cursor.id))) {
          path.forEach((id) => visibleIds.add(id));
          break;
        }
        cursor = cursor.parent_id ? byId.get(String(cursor.parent_id)) : null;
      }
    }
    for (const seedId of scopeSeeds) {
      let cursor = byId.get(seedId);
      while (cursor) {
        visibleIds.add(String(cursor.id));
        cursor = cursor.parent_id ? byId.get(String(cursor.parent_id)) : null;
      }
    }
    rows = rows.filter((row) => visibleIds.has(String(row.id)));
  }
  const mapped = rows.map((row) => mapGeographyRow(row));
  return buildGeographyTree(mapped);
};

const getManagedByFilter = ({ managedBy, tenantId, level }) => {
  const normalizedManagedBy = String(managedBy || '').trim().toLowerCase();
  if (normalizedManagedBy === 'platform') {
    return {
      tenant_id: null,
      is_platform_managed: true,
    };
  }
  if (normalizedManagedBy === 'tenant') {
    return {
      tenant_id: tenantId || '__missing_tenant__',
    };
  }
  if (level && OFFICIAL_PLATFORM_MANAGED_LEVELS.has(level)) {
    return {
      [Op.or]: [
        { tenant_id: null },
        ...(tenantId ? [{ tenant_id: tenantId }] : []),
      ],
    };
  }
  if (level && TENANT_MANAGED_LEVELS.has(level)) {
    return {
      tenant_id: tenantId || '__missing_tenant__',
    };
  }
  return tenantId
    ? {
        [Op.or]: [{ tenant_id: null }, { tenant_id: tenantId }],
      }
    : {};
};

const isOfficialIndiaSelectionRequest = ({ officialOnly, countryCode, level }) => (
  String(officialOnly || '').trim().toLowerCase() === 'true' &&
  String(countryCode || '').trim().toUpperCase() === 'IN' &&
  ['state', 'district'].includes(String(level || '').trim().toLowerCase())
);

const listGeographyOptions = async (req) => {
  const tenantId = tenantScope(req, req.query.tenantId);
  const level = normalizeGeographyLevel(req.query.level);
  const activeOnly = String(req.query.activeOnly || 'true').trim().toLowerCase() !== 'false';
  const officialOnly = String(req.query.officialOnly || '').trim().toLowerCase() === 'true';
  const countryCode = req.query.countryCode ? String(req.query.countryCode || '').trim().toUpperCase() : null;
  const officialIndiaLevel = isOfficialIndiaSelectionRequest({ officialOnly, countryCode, level });
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 100 });
  const canUseCache =
    activeOnly &&
    ['country', 'state'].includes(level) &&
    !req.query.search &&
    !req.query.enabledOnly &&
    !officialOnly &&
    page === 1 &&
    (req.user?.isSuperAdmin || String(req.query.ignoreScope || '').trim().toLowerCase() === 'true');
  const cacheKey = canUseCache
    ? JSON.stringify({ tenantId, level, parentId: req.query.parentId || null, limit, countryCode: req.query.countryCode || null })
    : null;
  const cached = cacheKey ? geographyOptionsCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let where = {
    ...(activeOnly ? { is_active: true } : {}),
    ...getManagedByFilter({
      managedBy: req.query.managedBy,
      tenantId,
      level,
    }),
  };

  if (level) where.level = level;
  if (req.query.parentId !== undefined) {
    where.parent_id = req.query.parentId || null;
  }
  if (countryCode) {
    where.country_code = countryCode;
  }
  if (req.query.externalSource) {
    where.external_source = sanitizeOptionalText(req.query.externalSource, 80);
  }
  const enabledOnly = String(req.query.enabledOnly || '').trim().toLowerCase() === 'true';
  if (enabledOnly && tenantId && OFFICIAL_PLATFORM_MANAGED_LEVELS.has(String(level || '').toLowerCase())) {
    const assignments = await TenantGeographyAssignment.findAll({
      where: { tenant_id: tenantId, is_enabled: true },
      attributes: ['geography_id'],
    });
    const enabledIds = assignments.map((assignment) => assignment.geography_id);
    where.id = enabledIds.length > 0 ? { [Op.in]: enabledIds } : EMPTY_SCOPE_UUID;
  }
  if (req.query.search) {
    const q = sanitizeText(req.query.search, 120);
    const normalizedQuery = normalizeGeographyName(q);
    where[Op.or] = [
      { name: { [Op.iLike]: `%${q}%` } },
      { code: { [Op.iLike]: `%${q}%` } },
      { normalized_name: { [Op.iLike]: `%${normalizedQuery}%` } },
      { external_code: { [Op.iLike]: `%${q}%` } },
    ];
  }

  const includeLiveScope =
    !req.user?.isSuperAdmin &&
    !String(req.query.ignoreScope || '').trim().toLowerCase().startsWith('t');
  if (includeLiveScope) {
    if (req.query.parentId) {
      const parentAllowed = await isGeographyInLiveScope(req, req.query.parentId, { tenantId });
      if (!parentAllowed) where.id = EMPTY_SCOPE_UUID;
    } else {
      const ancestryIds = await resolveComparableScopeAncestryIds({ req, tenantId });
      where.id = ancestryIds.length > 0 ? { [Op.in]: ancestryIds } : EMPTY_SCOPE_UUID;
    }
  }

  const sourceInclude = officialIndiaLevel
    ? [{
        model: GlobalGeographySource,
        as: 'globalSources',
        required: true,
        attributes: [],
        where: { source: 'LGD' },
      }]
    : [];

  const { rows, count } = await Geography.findAndCountAll({
    where,
    include: sourceInclude,
    distinct: true,
    order: [
      ['level', 'ASC'],
      ['is_platform_managed', 'DESC'],
      ['name', 'ASC'],
    ],
    limit,
    offset,
  });
  const result = {
    items: await addGeographyPaths(rows),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      activeOnly,
      enabledOnly,
      officialOnly,
    },
  };
  if (cacheKey) {
    geographyOptionsCache.set(cacheKey, {
      value: result,
      expiresAt: Date.now() + GEOGRAPHY_OPTIONS_CACHE_TTL_MS,
    });
  }
  return result;
};

const listGlobalGeographyOptions = async (req) => {
  const canonicalParentId = req.query.parentId
    ? await resolveCanonicalPlatformParentId(req.query.parentId)
    : req.query.parentId;
  const result = await listGeographyOptions({
    ...req,
    query: {
      ...req.query,
      parentId: canonicalParentId,
      managedBy: 'platform',
      countryCode: req.query.countryIso2 || req.query.countryCode,
      activeOnly: req.query.activeOnly ?? 'true',
    },
  });
  return {
    items: result.items.map((item) => ({
      id: item.id,
      name: item.name,
      canonicalLevel: item.level,
      administrativeType: item.administrativeType || null,
      parentId: item.parentId || null,
      path: item.path || [],
      countryIso2: item.countryIso2 || item.countryCode || null,
      countryIso3: item.countryIso3 || null,
      latitude: item.latitude,
      longitude: item.longitude,
      boundsAvailable: Boolean(item.bounds || (
        item.boundsNorth !== null && item.boundsSouth !== null &&
        item.boundsEast !== null && item.boundsWest !== null
      )),
      geometryAvailable: Boolean(item.geometryType),
    })),
    meta: result.meta,
  };
};

const activateGlobalGeography = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  if (!tenantId) throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  const row = await resolveOrCreateTenantGeographyFromGlobal({
    tenantId,
    globalGeographyId: req.params.id,
    createdBy: req.user.id,
    actor: req.user,
  });
  return mapGeographyRow(row);
};

const listGlobalGeographyDataSources = async () => {
  const rows = await GlobalGeographySource.findAll({
    include: [{ model: Geography, as: 'globalGeography', required: true, where: { tenant_id: null, is_active: true }, attributes: [] }],
    attributes: [
      'source', 'source_licence', 'source_attribution', 'source_reference',
      [fn('COUNT', col('GlobalGeographySource.id')), 'record_count'],
    ],
    group: ['source', 'source_licence', 'source_attribution', 'source_reference'],
    order: [['source', 'ASC']],
    raw: true,
  });
  return rows.map((row) => ({
    source: row.source,
    licence: row.source_licence || null,
    attribution: row.source_attribution || null,
    reference: row.source_reference || null,
    recordCount: Number(row.record_count || 0),
  }));
};

const createGeography = async (req) => {
  const tenantId = tenantScope(req, req.body.tenantId);
  const level = normalizeGeographyLevel(req.body.level);
  if (!level) {
    throw new AppError('Invalid geography level', 400, { code: 'GEOGRAPHY_LEVEL_INVALID' });
  }
  const isPlatformManagedLevel = OFFICIAL_PLATFORM_MANAGED_LEVELS.has(String(level || '').toLowerCase());
  const effectiveTenantId = isPlatformManagedLevel ? null : tenantId;
  if (!effectiveTenantId && !isPlatformManagedLevel) {
    throw new AppError('tenantId is required', 400, { code: 'TENANT_REQUIRED' });
  }
  if (isPlatformManagedLevel && !req.user?.isSuperAdmin) {
    throw new AppError('Official geography levels must be requested through the missing-area workflow', 403, {
      code: 'OFFICIAL_GEOGRAPHY_CREATE_FORBIDDEN',
    });
  }
  assertScopedGeographyCreateAllowed({
    req,
    level,
    parentId: req.body.parentId || null,
  });

  let parent = null;
  if (req.body.parentId) {
    if (!(await isGeographyInLiveScope(req, req.body.parentId, { tenantId: effectiveTenantId || tenantId }))) {
      throw new AppError('parentId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    parent = await Geography.findByPk(req.body.parentId);
    const parentBelongsToTenant = parent && (
      parent.tenant_id === effectiveTenantId ||
      (!isPlatformManagedLevel && parent.tenant_id === null && Boolean(parent.is_platform_managed))
    );
    if (!parentBelongsToTenant) {
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
  await assertMunicipalParentHierarchy({
    tenantId: effectiveTenantId,
    parent,
    childLevel: level,
  });

  const geometryPayload = deriveGeometryPayload(req.body);
  const locationState = deriveGeographyLocationState({ level, geometryPayload });
  assertGeographyGeometryInsideParent({
    parent,
    level,
    geometryPayload,
  });
  if (geometryPayload.mapPlaceId) {
    const duplicatePlace = await Geography.findOne({
      where: {
        tenant_id: effectiveTenantId,
        parent_id: req.body.parentId || null,
        level,
        [Op.or]: [
          { map_place_id: geometryPayload.mapPlaceId },
          { place_id: geometryPayload.mapPlaceId },
        ],
      },
      attributes: ['id'],
    });
    if (duplicatePlace) {
      throw new AppError('Geography already exists for the selected map location', 409, {
        code: 'GEOGRAPHY_PLACE_EXISTS',
      });
    }
  }
  const duplicateName = await Geography.findOne({
    where: {
      tenant_id: effectiveTenantId,
      parent_id: req.body.parentId || null,
      level,
      normalized_name: normalizeGeographyName(req.body.name),
    },
    attributes: ['id'],
  });
  if (duplicateName) {
    throw new AppError('An Area with this name already exists in the selected parent scope', 409, {
      code: 'GEOGRAPHY_NAME_EXISTS',
    });
  }
  await assertNoBoundaryConflict({
    tenantId: effectiveTenantId,
    level,
    parentId: req.body.parentId || null,
    bounds: geometryPayload.bounds,
  });

  const code = await resolveUniqueGeographyCode({
    tenantId: effectiveTenantId,
    level,
    rawCode: req.body.code,
    name: req.body.name,
  });
  const row = await Geography.create({
    tenant_id: effectiveTenantId,
    parent_id: req.body.parentId || null,
    level,
    code,
    name: sanitizeText(req.body.name, 200),
    normalized_name: normalizeGeographyName(req.body.name),
    external_source: sanitizeOptionalText(req.body.externalSource, 80),
    external_code: sanitizeOptionalText(req.body.externalCode, 160),
    external_place_id: sanitizeOptionalText(req.body.externalPlaceId, 220),
    country_code:
      sanitizeOptionalText(req.body.countryCode, 10)?.toUpperCase() ||
      parent?.country_code ||
      (level === 'country' ? sanitizeOptionalText(req.body.code, 10)?.toUpperCase() : null),
    administrative_type: sanitizeOptionalText(req.body.administrativeType, 80),
    source_administrative_level: sanitizeOptionalText(req.body.sourceAdministrativeLevel, 80),
    latitude: locationState.centroidLatitude,
    longitude: locationState.centroidLongitude,
    centroid_latitude: locationState.centroidLatitude,
    centroid_longitude: locationState.centroidLongitude,
    geometry_type: geometryPayload.geometryType,
    geojson: geometryPayload.geojson,
    boundary_center_latitude: geometryPayload.boundaryCenterLatitude,
    boundary_center_longitude: geometryPayload.boundaryCenterLongitude,
    boundary_radius_meters: geometryPayload.boundaryRadiusMeters,
    bounds: geometryPayload.bounds,
    bounds_north: geometryPayload.bounds?.north ?? null,
    bounds_south: geometryPayload.bounds?.south ?? null,
    bounds_east: geometryPayload.bounds?.east ?? null,
    bounds_west: geometryPayload.bounds?.west ?? null,
    area_sq_km: geometryPayload.areaSqKm,
    boundary_label: geometryPayload.boundaryLabel,
    description: sanitizeOptionalText(req.body.description, 600),
    map_display_address: geometryPayload.mapDisplayAddress,
    map_place_id: geometryPayload.mapPlaceId,
    map_source: geometryPayload.mapSource,
    formatted_address: geometryPayload.mapDisplayAddress,
    place_id: geometryPayload.mapPlaceId,
    scope_type: level,
    scope_name: sanitizeText(req.body.name, 200),
    location_status: locationState.locationStatus,
    is_active: req.body.isActive !== false,
    is_official_source: req.body.isOfficialSource === true || isPlatformManagedLevel,
    is_platform_managed: req.body.isPlatformManaged !== false ? isPlatformManagedLevel : false,
    is_verified_local_government:
      req.body.isVerifiedLocalGovernment === true ||
      String(req.body.externalSource || '').trim().toLowerCase() === 'lgd',
    is_operational_zone:
      geometryPayload.isOperationalZone !== undefined
        ? geometryPayload.isOperationalZone
        : level === 'zone' || level === 'ward',
  });
  clearGeographyOptionsCache();
  await createAuditLog({
    req,
    action: 'geography.create',
    entityType: 'geography',
    entityId: row.id,
    tenantId: effectiveTenantId || tenantId,
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
  if (!(await isGeographyInLiveScope(req, row.id, { tenantId: row.tenant_id }))) {
    throw new AppError('Geography out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const nextLevel = req.body.level ? normalizeGeographyLevel(req.body.level) : row.level;
  if (!nextLevel) {
    throw new AppError('Invalid geography level', 400, { code: 'GEOGRAPHY_LEVEL_INVALID' });
  }
  if ((row.tenant_id === null || Boolean(row.is_platform_managed)) && !req.user?.isSuperAdmin) {
    throw new AppError('Official geography records cannot be edited by tenant admins', 403, {
      code: 'OFFICIAL_GEOGRAPHY_UPDATE_FORBIDDEN',
    });
  }
  const nextParentId =
    req.body.parentId !== undefined ? req.body.parentId || null : row.parent_id || null;
  assertScopedGeographyCreateAllowed({
    req,
    level: nextLevel,
    parentId: nextParentId,
  });

  let parent = null;
  if (nextParentId) {
    if (!(await isGeographyInLiveScope(req, nextParentId, { tenantId: row.tenant_id }))) {
      throw new AppError('parentId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    parent = await Geography.findByPk(nextParentId);
    const parentBelongsToTenant = parent && (
      parent.tenant_id === row.tenant_id ||
      (row.tenant_id !== null && parent.tenant_id === null && Boolean(parent.is_platform_managed))
    );
    if (!parentBelongsToTenant) {
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
  await assertMunicipalParentHierarchy({
    tenantId: row.tenant_id,
    parent,
    childLevel: nextLevel,
    excludeId: row.id,
  });

  const geometryPayload = deriveGeometryPayload({
    ...mapGeographyRow(row),
    ...req.body,
  });
  const locationState = deriveGeographyLocationState({ level: nextLevel, geometryPayload });
  assertGeographyGeometryInsideParent({
    parent,
    level: nextLevel,
    geometryPayload,
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

  if (req.body.name !== undefined || req.body.parentId !== undefined || req.body.level !== undefined) {
    const duplicateName = await Geography.findOne({
      where: {
        tenant_id: row.tenant_id,
        parent_id: nextParentId,
        level: nextLevel,
        normalized_name: normalizeGeographyName(req.body.name || row.name),
        id: { [Op.ne]: row.id },
      },
      attributes: ['id'],
    });
    if (duplicateName) {
      throw new AppError('An Area with this name already exists in the selected parent scope', 409, {
        code: 'GEOGRAPHY_NAME_EXISTS',
      });
    }
  }

  await row.update({
    parent_id: nextParentId,
    level: nextLevel,
    code,
    name: req.body.name ? sanitizeText(req.body.name, 200) : row.name,
    normalized_name:
      req.body.name !== undefined ? normalizeGeographyName(req.body.name) : row.normalized_name,
    external_source:
      req.body.externalSource !== undefined
        ? sanitizeOptionalText(req.body.externalSource, 80)
        : row.external_source,
    external_code:
      req.body.externalCode !== undefined
        ? sanitizeOptionalText(req.body.externalCode, 160)
        : row.external_code,
    external_place_id:
      req.body.externalPlaceId !== undefined
        ? sanitizeOptionalText(req.body.externalPlaceId, 220)
        : row.external_place_id,
    country_code:
      req.body.countryCode !== undefined
        ? sanitizeOptionalText(req.body.countryCode, 10)?.toUpperCase()
        : row.country_code,
    administrative_type:
      req.body.administrativeType !== undefined
        ? sanitizeOptionalText(req.body.administrativeType, 80)
        : row.administrative_type,
    source_administrative_level:
      req.body.sourceAdministrativeLevel !== undefined
        ? sanitizeOptionalText(req.body.sourceAdministrativeLevel, 80)
        : row.source_administrative_level,
    latitude: locationState.centroidLatitude,
    longitude: locationState.centroidLongitude,
    centroid_latitude: locationState.centroidLatitude,
    centroid_longitude: locationState.centroidLongitude,
    geometry_type: geometryPayload.geometryType,
    geojson: geometryPayload.geojson,
    boundary_center_latitude: geometryPayload.boundaryCenterLatitude,
    boundary_center_longitude: geometryPayload.boundaryCenterLongitude,
    boundary_radius_meters: geometryPayload.boundaryRadiusMeters,
    bounds: geometryPayload.bounds,
    bounds_north: geometryPayload.bounds?.north ?? null,
    bounds_south: geometryPayload.bounds?.south ?? null,
    bounds_east: geometryPayload.bounds?.east ?? null,
    bounds_west: geometryPayload.bounds?.west ?? null,
    area_sq_km: geometryPayload.areaSqKm,
    boundary_label: geometryPayload.boundaryLabel,
    description:
      req.body.description !== undefined ? sanitizeOptionalText(req.body.description, 600) : row.description,
    map_display_address: geometryPayload.mapDisplayAddress,
    map_place_id: geometryPayload.mapPlaceId,
    map_source: geometryPayload.mapSource,
    formatted_address: geometryPayload.mapDisplayAddress,
    place_id: geometryPayload.mapPlaceId,
    scope_type: nextLevel,
    scope_name: req.body.name ? sanitizeText(req.body.name, 200) : row.name,
    location_status: locationState.locationStatus,
    is_active: req.body.isActive !== undefined ? req.body.isActive === true : row.is_active,
    is_official_source:
      req.body.isOfficialSource !== undefined ? req.body.isOfficialSource === true : row.is_official_source,
    is_platform_managed:
      req.body.isPlatformManaged !== undefined ? req.body.isPlatformManaged === true : row.is_platform_managed,
    is_verified_local_government:
      req.body.isVerifiedLocalGovernment !== undefined
        ? req.body.isVerifiedLocalGovernment === true
        : row.is_verified_local_government,
    is_operational_zone:
      geometryPayload.isOperationalZone !== undefined
        ? geometryPayload.isOperationalZone
        : row.is_operational_zone,
    updated_at: new Date(),
  });
  clearGeographyOptionsCache();

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
  if (!(await isGeographyInLiveScope(req, row.id, { tenantId: row.tenant_id }))) {
    throw new AppError('Geography out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  assertScopedGeographyMutationAllowed({ req, level: row.level });
  if (row.tenant_id === null || Boolean(row.is_platform_managed)) {
    throw new AppError('Official geography records are retired through import sync, not direct deletion', 403, {
      code: 'OFFICIAL_GEOGRAPHY_DELETE_FORBIDDEN',
    });
  }

  const [childrenCount, facilitiesCount] = await Promise.all([
    Geography.count({ where: { parent_id: row.id, is_active: true } }),
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

  await row.update({ is_active: false, updated_at: new Date() });
  clearGeographyOptionsCache();
  await createAuditLog({
    req,
    action: 'geography.retire',
    entityType: 'geography',
    entityId: row.id,
    tenantId: row.tenant_id,
  });
  return { id: row.id, deleted: false, retired: true, isActive: false };
};

const buildImportRecordFingerprint = (record = {}) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        externalSource: record.externalSource || null,
        externalCode: record.externalCode || null,
        level: record.level || null,
        parentExternalCode: record.parentExternalCode || null,
        parentId: record.parentId || null,
        name: record.name || null,
        countryCode: record.countryCode || null,
      })
    )
    .digest('hex');

const listGeographyImportJobs = async (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can manage geography imports', 403, {
      code: 'SUPER_ADMIN_ONLY',
    });
  }
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 100 });
  const where = {};
  if (req.query.source) where.source = sanitizeOptionalText(req.query.source, 80);
  if (req.query.countryCode) where.country_code = sanitizeOptionalText(req.query.countryCode, 10)?.toUpperCase();
  if (req.query.level) where.level = normalizeGeographyLevel(req.query.level) || sanitizeOptionalText(req.query.level, 20);
  if (req.query.status) where.status = sanitizeOptionalText(req.query.status, 20);
  const { rows, count } = await GeographyImportJob.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      source: row.source,
      countryCode: row.country_code || null,
      level: row.level || null,
      status: row.status,
      requestedByUserId: row.requested_by_user_id || null,
      idempotencyKey: row.idempotency_key,
      summary: row.summary || null,
      startedAt: row.started_at || null,
      completedAt: row.completed_at || null,
      errorMessage: row.error_message || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const runGeographyImportJob = async (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can run geography imports', 403, {
      code: 'SUPER_ADMIN_ONLY',
    });
  }

  const source = sanitizeOptionalText(req.body.source, 80);
  const countryCode = sanitizeOptionalText(req.body.countryCode, 10)?.toUpperCase() || null;
  const level = normalizeGeographyLevel(req.body.level);
  const records = Array.isArray(req.body.records) ? req.body.records : [];
  const idempotencyKey =
    sanitizeOptionalText(req.body.idempotencyKey, 160) ||
    crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          source,
          countryCode,
          level,
          fullSync: req.body.fullSync === true,
          records: records.map((record) => buildImportRecordFingerprint(record)),
        })
      )
      .digest('hex');

  if (!source) {
    throw new AppError('source is required', 400, { code: 'IMPORT_SOURCE_REQUIRED' });
  }
  if (!level) {
    throw new AppError('level is required', 400, { code: 'IMPORT_LEVEL_REQUIRED' });
  }
  if (records.length === 0) {
    throw new AppError('records must contain at least one geography row', 400, {
      code: 'IMPORT_RECORDS_REQUIRED',
    });
  }

  const existingJob = await GeographyImportJob.findOne({
    where: { idempotency_key: idempotencyKey },
  });
  if (existingJob) {
    return {
      id: existingJob.id,
      status: existingJob.status,
      summary: existingJob.summary || null,
      reused: true,
    };
  }

  const inputHash = crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
  const job = await GeographyImportJob.create({
    source,
    country_code: countryCode,
    level,
    status: 'running',
    requested_by_user_id: req.user.id,
    idempotency_key: idempotencyKey,
    input_hash: inputHash,
    payload: {
      fullSync: req.body.fullSync === true,
      recordCount: records.length,
    },
    started_at: new Date(),
  });

  const summary = {
    total: records.length,
    created: 0,
    updated: 0,
    retired: 0,
    unchanged: 0,
    duplicatesSkipped: 0,
    orphaned: 0,
    invalidHierarchy: 0,
  };

  try {
    await sequelize.transaction(async (transaction) => {
      const seenExternalKeys = new Set();
      const touchedIds = [];

      for (const inputRecord of records) {
        const externalSource = sanitizeOptionalText(inputRecord.externalSource || source, 80) || source;
        const externalCode = sanitizeOptionalText(inputRecord.externalCode, 160);
        const recordLevel = normalizeGeographyLevel(inputRecord.level || level);
        if (!externalCode || !recordLevel) {
          summary.duplicatesSkipped += 1;
          continue;
        }
        const dedupeKey = `${externalSource}::${externalCode}`;
        if (seenExternalKeys.has(dedupeKey)) {
          summary.duplicatesSkipped += 1;
          continue;
        }
        seenExternalKeys.add(dedupeKey);

        let parentId = inputRecord.parentId || null;
        const parentExternalCode = sanitizeOptionalText(inputRecord.parentExternalCode, 160);
        const parentExternalSource = sanitizeOptionalText(inputRecord.parentExternalSource || externalSource, 80);
        if (!parentId && parentExternalCode) {
          const parentIdentifier = await GeographyExternalIdentifier.findOne({
            where: {
              external_source: parentExternalSource,
              external_code: parentExternalCode,
            },
            transaction,
          });
          const parentRow = parentIdentifier
            ? await Geography.findByPk(parentIdentifier.geography_id, { transaction })
            : await Geography.findOne({
                where: {
                  external_source: parentExternalSource,
                  external_code: parentExternalCode,
                },
                transaction,
              });
          parentId = parentRow?.id || null;
        }

        if (recordLevel !== 'country' && !parentId) {
          summary.orphaned += 1;
          continue;
        }
        if (parentId) {
          const parent = await Geography.findByPk(parentId, { transaction });
          const requiredParent = { state: 'country', district: 'state', city: 'district' }[recordLevel];
          if (!parent || (requiredParent && parent.level !== requiredParent)) {
            summary.invalidHierarchy += 1;
            continue;
          }
        }

        const payload = {
          parent_id: parentId,
          level: recordLevel,
          code:
            sanitizeOptionalText(inputRecord.code, 120) ||
            sanitizeOptionalText(inputRecord.externalCode, 120) ||
            sanitizeOptionalText(inputRecord.name, 120),
          name: sanitizeText(inputRecord.name, 200),
          normalized_name: normalizeGeographyName(inputRecord.name),
          external_source: externalSource,
          external_code: externalCode,
          external_place_id: sanitizeOptionalText(inputRecord.externalPlaceId, 220),
          country_code: sanitizeOptionalText(inputRecord.countryCode || countryCode, 10)?.toUpperCase() || null,
          administrative_type: sanitizeOptionalText(inputRecord.administrativeType, 80),
          source_administrative_level: sanitizeOptionalText(inputRecord.sourceAdministrativeLevel, 80),
          latitude: toFiniteNumber(inputRecord.latitude),
          longitude: toFiniteNumber(inputRecord.longitude),
          centroid_latitude: toFiniteNumber(inputRecord.centroidLatitude ?? inputRecord.latitude),
          centroid_longitude: toFiniteNumber(inputRecord.centroidLongitude ?? inputRecord.longitude),
          bounds: parseBounds(inputRecord.bounds),
          bounds_north: toFiniteNumber(inputRecord.bounds?.north),
          bounds_south: toFiniteNumber(inputRecord.bounds?.south),
          bounds_east: toFiniteNumber(inputRecord.bounds?.east),
          bounds_west: toFiniteNumber(inputRecord.bounds?.west),
          place_id: sanitizeOptionalText(inputRecord.placeId, 220),
          map_place_id: sanitizeOptionalText(inputRecord.mapPlaceId || inputRecord.placeId, 220),
          map_display_address: sanitizeOptionalText(inputRecord.mapDisplayAddress || inputRecord.formattedAddress, 500),
          formatted_address: sanitizeOptionalText(inputRecord.formattedAddress || inputRecord.mapDisplayAddress, 500),
          geometry_type: sanitizeOptionalText(inputRecord.geometryType || inputRecord.geometry?.type, 20),
          geojson: inputRecord.geometry || inputRecord.geojson || null,
          is_active: inputRecord.isActive !== false,
          is_official_source: inputRecord.isOfficialSource !== false,
          is_platform_managed: inputRecord.isPlatformManaged !== false,
          is_verified_local_government:
            inputRecord.isVerifiedLocalGovernment === true || externalSource.toLowerCase() === 'lgd',
          location_status:
            inputRecord.locationStatus || (toFiniteNumber(inputRecord.latitude) !== null ? 'mapped' : 'unmapped'),
          tenant_id: inputRecord.tenantId || null,
        };

        const sourceIdentifier = await GeographyExternalIdentifier.findOne({
          where: { external_source: externalSource, external_code: externalCode },
          transaction,
        });
        const overrideSource = sanitizeOptionalText(inputRecord.overrideExternalSource, 80);
        const overrideCode = sanitizeOptionalText(inputRecord.overrideExternalCode, 160);
        const overrideIdentifier = overrideSource && overrideCode
          ? await GeographyExternalIdentifier.findOne({
              where: { external_source: overrideSource, external_code: overrideCode },
              transaction,
            })
          : null;
        let existing = sourceIdentifier
          ? await Geography.findByPk(sourceIdentifier.geography_id, { transaction })
          : null;
        if (!existing && overrideIdentifier) {
          existing = await Geography.findByPk(overrideIdentifier.geography_id, { transaction });
        }
        if (!existing) {
          existing = await Geography.findOne({
            where: { external_source: externalSource, external_code: externalCode },
            transaction,
          });
        }

        if (!existing) {
          const created = await Geography.create(payload, { transaction });
          await GeographyExternalIdentifier.create({
            geography_id: created.id,
            external_source: externalSource,
            external_code: externalCode,
            is_primary: true,
          }, { transaction });
          touchedIds.push(created.id);
          summary.created += 1;
          continue;
        }

        await GeographyExternalIdentifier.findOrCreate({
          where: { external_source: externalSource, external_code: externalCode },
          defaults: {
            geography_id: existing.id,
            is_primary: false,
          },
          transaction,
        });

        const changed =
          existing.parent_id !== payload.parent_id ||
          existing.level !== payload.level ||
          existing.name !== payload.name ||
          existing.normalized_name !== payload.normalized_name ||
          existing.country_code !== payload.country_code ||
          existing.is_active !== payload.is_active ||
          existing.external_place_id !== payload.external_place_id ||
          existing.place_id !== payload.place_id ||
          existing.map_place_id !== payload.map_place_id ||
          existing.map_display_address !== payload.map_display_address;

        if (!changed) {
          touchedIds.push(existing.id);
          summary.unchanged += 1;
          continue;
        }

        await existing.update(
          {
            ...payload,
            code: existing.code || payload.code,
            updated_at: new Date(),
          },
          { transaction }
        );
        touchedIds.push(existing.id);
        summary.updated += 1;
      }

      if (req.body.fullSync === true) {
        const retireWhere = {
          external_source: source,
          level,
          ...(countryCode ? { country_code: countryCode } : {}),
          id: { [Op.notIn]: touchedIds.length > 0 ? touchedIds : ['00000000-0000-0000-0000-000000000000'] },
          is_active: true,
        };
        const [retiredCount] = await Geography.update(
          { is_active: false, updated_at: new Date() },
          { where: retireWhere, transaction }
        );
        summary.retired += Number(retiredCount || 0);
      }
    });

    await job.update({
      status: 'completed',
      summary,
      completed_at: new Date(),
      updated_at: new Date(),
    });
    clearGeographyOptionsCache();
  } catch (error) {
    await job.update({
      status: 'failed',
      error_message: error.message,
      summary,
      completed_at: new Date(),
      updated_at: new Date(),
    });
    throw error;
  }

  return {
    id: job.id,
    status: 'completed',
    summary,
    reused: false,
  };
};

const listGeographyMigrationReviews = async (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can review geography migration matches', 403, {
      code: 'SUPER_ADMIN_ONLY',
    });
  }
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 100 });
  const where = {};
  if (req.query.status) where.status = sanitizeOptionalText(req.query.status, 20);
  if (req.query.tenantId) where.tenant_id = req.query.tenantId;
  const { rows, count } = await GeographyMigrationReview.findAndCountAll({
    where,
    include: [{ model: Geography, as: 'legacyGeography', required: true }],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      legacyGeography: mapGeographyRow(row.legacyGeography),
      candidateMasterGeographyIds: row.candidate_master_geography_ids || [],
      matchMethod: row.match_method || null,
      status: row.status,
      notes: row.notes || null,
      reviewedByUserId: row.reviewed_by_user_id || null,
      reviewedAt: row.reviewed_at || null,
    })),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const resolveGeographyMigrationReview = async (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can resolve geography migration matches', 403, {
      code: 'SUPER_ADMIN_ONLY',
    });
  }
  const review = await GeographyMigrationReview.findByPk(req.params.id);
  if (!review) throw new AppError('Geography migration review not found', 404);
  const status = String(req.body.status || '').trim().toLowerCase();
  if (!['matched', 'ignored'].includes(status)) {
    throw new AppError('status must be matched or ignored', 400);
  }
  let masterGeographyId = null;
  if (status === 'matched') {
    masterGeographyId = req.body.masterGeographyId;
    const candidate = await Geography.findByPk(masterGeographyId);
    const legacy = await Geography.findByPk(review.legacy_geography_id);
    if (!candidate || candidate.tenant_id !== null || candidate.is_active === false || !legacy) {
      throw new AppError('masterGeographyId must reference an active canonical geography', 400);
    }
    if (candidate.level !== legacy.level) {
      throw new AppError('Canonical and legacy geography levels must match', 400);
    }
    await sequelize.transaction(async (transaction) => {
      await legacy.update({ master_geography_id: candidate.id, updated_at: new Date() }, { transaction });
      if (legacy.tenant_id) {
        await TenantGeographyAssignment.upsert({
          tenant_id: legacy.tenant_id,
          geography_id: candidate.id,
          is_enabled: true,
          created_by_user_id: req.user.id,
          updated_at: new Date(),
        }, { transaction });
      }
      await review.update({
        status,
        candidate_master_geography_ids: [candidate.id],
        notes: sanitizeOptionalText(req.body.notes, 1000) || review.notes,
        reviewed_by_user_id: req.user.id,
        reviewed_at: new Date(),
        updated_at: new Date(),
      }, { transaction });
    });
  } else {
    await review.update({
      status,
      notes: sanitizeOptionalText(req.body.notes, 1000) || review.notes,
      reviewed_by_user_id: req.user.id,
      reviewed_at: new Date(),
      updated_at: new Date(),
    });
  }
  return { id: review.id, status, masterGeographyId };
};

const setTenantGeographyAssignment = async (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can manage tenant geography activation', 403, {
      code: 'SUPER_ADMIN_ONLY',
    });
  }
  const tenant = await Tenant.findByPk(req.params.tenantId);
  const geography = await Geography.findByPk(req.params.geographyId);
  if (!tenant || !geography || geography.tenant_id !== null || geography.is_active === false) {
    throw new AppError('Tenant or active canonical geography not found', 404);
  }
  const [assignment] = await TenantGeographyAssignment.upsert({
    tenant_id: tenant.id,
    geography_id: geography.id,
    is_enabled: req.body.isEnabled !== false,
    created_by_user_id: req.user.id,
    updated_at: new Date(),
  }, { returning: true });
  return {
    tenantId: tenant.id,
    geographyId: geography.id,
    isEnabled: assignment.is_enabled,
  };
};

const requestMissingArea = async (req) => {
  const level = normalizeGeographyLevel(req.body.level);
  if (!level || !OFFICIAL_PLATFORM_MANAGED_LEVELS.has(level)) {
    throw new AppError('Missing area requests are only supported for official geography levels', 400, {
      code: 'MISSING_AREA_LEVEL_INVALID',
    });
  }
  const name = sanitizeText(req.body.name, 200);
  if (!name) {
    throw new AppError('name is required', 400, { code: 'MISSING_AREA_NAME_REQUIRED' });
  }
  const parentId = req.body.parentId || null;
  const existing = await Geography.findOne({
    where: {
      level,
      parent_id: parentId,
      normalized_name: normalizeGeographyName(name),
      ...(req.body.countryCode ? { country_code: String(req.body.countryCode).trim().toUpperCase() } : {}),
    },
    attributes: ['id', 'is_active'],
  });
  if (existing?.is_active) {
    throw new AppError('Requested geography already exists', 409, {
      code: 'MISSING_AREA_ALREADY_EXISTS',
      details: { geographyId: existing.id },
    });
  }

  const approval = await SuperAdminApproval.create({
    tenant_id: req.user?.tenantId || null,
    requested_by_user_id: req.user?.id || null,
    category: 'geography_missing_area_request',
    entity_type: 'geography',
    entity_id: parentId || null,
    status: 'pending',
    notes: JSON.stringify({
      name,
      level,
      countryCode: sanitizeOptionalText(req.body.countryCode, 10)?.toUpperCase() || null,
      parentId,
      reason: sanitizeOptionalText(req.body.reason, 500),
      externalSource: sanitizeOptionalText(req.body.externalSource, 80),
      officialReference: sanitizeOptionalText(req.body.officialReference, 500),
      remarks: sanitizeOptionalText(req.body.remarks, 1000),
    }),
  });

  return {
    id: approval.id,
    status: approval.status,
    category: approval.category,
  };
};

const ensureScopedGeographyInTenant = async ({
  req,
  geographyId,
  tenantId,
  field = 'geographyId',
}) => {
  if (!geographyId) return null;
  if (!(await isGeographyInLiveScope(req, geographyId, { tenantId }))) {
    throw new AppError(`${field} is outside scope`, 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const geography = await Geography.findByPk(geographyId);
  if (!geography || geography.is_active === false) {
    throw new AppError(`${field} is outside tenant scope`, 400, {
      code: 'GEOGRAPHY_SCOPE_INVALID',
    });
  }
  if (geography.tenant_id === tenantId) return geography;
  if (geography.tenant_id !== null) {
    throw new AppError(`${field} is outside tenant scope`, 400, {
      code: 'GEOGRAPHY_SCOPE_INVALID',
    });
  }
  const [assignment, tenant] = await Promise.all([
    TenantGeographyAssignment.findOne({
      where: { tenant_id: tenantId, geography_id: geography.id, is_enabled: true },
    }),
    Tenant.findByPk(tenantId, { attributes: ['root_geography_id'] }),
  ]);
  if (assignment) return geography;
  let cursorId = geography.id;
  const seen = new Set();
  while (cursorId && !seen.has(String(cursorId))) {
    if (String(cursorId) === String(tenant?.root_geography_id || '')) return geography;
    seen.add(String(cursorId));
    const cursor = await Geography.findByPk(cursorId, { attributes: ['parent_id'] });
    cursorId = cursor?.parent_id || null;
  }
  throw new AppError(`${field} is outside tenant scope`, 400, {
    code: 'GEOGRAPHY_SCOPE_INVALID',
  });
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

const isGeographyDescendantOf = async (row, ancestorId) => {
  if (!row || !ancestorId) return false;
  let cursor = row;
  const seen = new Set();
  while (cursor && !seen.has(String(cursor.id))) {
    if (String(cursor.id) === String(ancestorId)) return true;
    seen.add(String(cursor.id));
    cursor = cursor.parent_id ? await Geography.findByPk(cursor.parent_id) : null;
  }
  return false;
};

const assertFacilityGeographyConsistency = async ({ geography = null, zone = null, ward = null }) => {
  if (zone && String(zone.level || '').toLowerCase() !== 'zone') {
    throw new AppError('zoneGeographyId must reference a zone geography', 400, {
      code: 'FACILITY_ZONE_INVALID',
    });
  }
  if (ward && String(ward.level || '').toLowerCase() !== 'ward') {
    throw new AppError('wardGeographyId must reference a ward geography', 400, {
      code: 'FACILITY_WARD_INVALID',
    });
  }
  if (geography && !['district', 'city'].includes(String(geography.level || '').toLowerCase())) {
    throw new AppError('geographyId must reference a district or city', 400, {
      code: 'FACILITY_GEOGRAPHY_INVALID',
    });
  }
  if (geography && zone && !(await isGeographyDescendantOf(zone, geography.id))) {
    throw new AppError('zoneGeographyId must belong to the selected district or city', 400, {
      code: 'FACILITY_ZONE_GEOGRAPHY_MISMATCH',
    });
  }
  if (geography && ward && !(await isGeographyDescendantOf(ward, geography.id))) {
    throw new AppError('wardGeographyId must belong to the selected district or city', 400, {
      code: 'FACILITY_WARD_GEOGRAPHY_MISMATCH',
    });
  }
  if (!ward) return;

  const wardParentId = String(ward.parent_id || '');
  if (zone) {
    if (wardParentId !== String(zone.id)) {
      throw new AppError('wardGeographyId must belong to the selected zone', 400, {
        code: 'FACILITY_WARD_ZONE_MISMATCH',
      });
    }
    return;
  }

  const parent = ward.parent_id
    ? await Geography.findByPk(ward.parent_id, { attributes: ['id', 'level'] })
    : null;
  const parentLevel = String(parent?.level || '').toLowerCase();
  if (!parent || !['district', 'city'].includes(parentLevel)) {
    throw new AppError('wardGeographyId requires its parent zone to be selected', 400, {
      code: 'FACILITY_WARD_ZONE_REQUIRED',
    });
  }
};

const normalizeFacilityLocationStatus = (value, { hasCoordinates = false } = {}) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'mapped') return 'mapped';
  if (normalized === 'pending' || normalized === 'location_pending') return 'pending';
  return hasCoordinates ? 'mapped' : 'pending';
};

const pointInPolygon = (point, polygonPoints = []) => {
  if (!point || !Array.isArray(polygonPoints) || polygonPoints.length < 3) return false;
  const x = Number(point.longitude);
  const y = Number(point.latitude);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  let inside = false;
  for (let i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i, i += 1) {
    const xi = Number(polygonPoints[i]?.lng);
    const yi = Number(polygonPoints[i]?.lat);
    const xj = Number(polygonPoints[j]?.lng);
    const yj = Number(polygonPoints[j]?.lat);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersect =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
};

const sampleCirclePerimeterPoints = ({ center, radiusMeters, segments = 16 }) => {
  const lat = toFiniteNumber(center?.lat ?? center?.latitude);
  const lng = toFiniteNumber(center?.lng ?? center?.longitude);
  const radius = toFiniteNumber(radiusMeters);
  const pointCount = Math.max(8, Math.round(toFiniteNumber(segments) || 16));
  if (!isValidLatitude(lat) || !isValidLongitude(lng) || !Number.isFinite(radius) || radius <= 0) return [];
  const normalizedCenter = { lat, lng };
  const latRadians = (normalizedCenter.lat * Math.PI) / 180;
  const latMetersPerDegree = 111320;
  const lngMetersPerDegree = Math.max(111320 * Math.cos(latRadians), 1);
  return Array.from({ length: pointCount }, (_, index) => {
    const angle = (2 * Math.PI * index) / pointCount;
    return {
      lat: normalizedCenter.lat + (Math.sin(angle) * radius) / latMetersPerDegree,
      lng: normalizedCenter.lng + (Math.cos(angle) * radius) / lngMetersPerDegree,
    };
  });
};

const isPointInsideCircle = (point, center, radiusMeters) => {
  const latitude = toFiniteNumber(point?.latitude);
  const longitude = toFiniteNumber(point?.longitude);
  const centerLat = toFiniteNumber(center?.latitude);
  const centerLng = toFiniteNumber(center?.longitude);
  const radius = toFiniteNumber(radiusMeters);
  if (
    !isValidLatitude(latitude) ||
    !isValidLongitude(longitude) ||
    !isValidLatitude(centerLat) ||
    !isValidLongitude(centerLng) ||
    !Number.isFinite(radius) ||
    radius <= 0
  ) {
    return false;
  }
  return (
    haversineMeters({
      lat1: latitude,
      lng1: longitude,
      lat2: centerLat,
      lng2: centerLng,
    }) <= radius
  );
};

const buildGeographyAncestry = async (geography) => {
  const chain = [];
  let cursor = geography || null;
  const seen = new Set();
  while (cursor && !seen.has(String(cursor.id))) {
    chain.push(cursor);
    seen.add(String(cursor.id));
    cursor = cursor.parent_id ? await Geography.findByPk(cursor.parent_id) : null;
  }
  return chain;
};

const deriveFacilityHierarchySnapshot = async ({ area = null, zone = null, ward = null }) => {
  const anchor = ward || zone || area || null;
  const chain = await buildGeographyAncestry(anchor);
  const byLevel = new Map(chain.map((row) => [String(row.level || '').toLowerCase(), row]));
  const areaRow =
    area ||
    ward ||
    zone ||
    byLevel.get('cluster') ||
    byLevel.get('ward') ||
    byLevel.get('zone') ||
    byLevel.get('city') ||
    byLevel.get('district') ||
    null;
  const zoneRow = zone || byLevel.get('zone') || null;
  const wardRow = ward || byLevel.get('ward') || null;

  return {
    countryName: byLevel.get('country')?.name || null,
    stateName: byLevel.get('state')?.name || null,
    districtName: byLevel.get('district')?.name || null,
    cityName: byLevel.get('city')?.name || null,
    zoneName: zoneRow?.name || null,
    wardName: wardRow?.name || null,
    areaId: areaRow?.id || null,
    areaName: areaRow?.name || null,
    areaLevel: areaRow?.level || null,
    areaCode: areaRow?.code || null,
    path: chain
      .slice()
      .reverse()
      .map((row) => row.name)
      .filter(Boolean),
  };
};

const deriveFacilityScopeFromArea = async (area) => {
  if (!area) {
    throw new AppError('Selected Area is required', 400, { code: 'FACILITY_AREA_REQUIRED' });
  }
  const chain = await buildGeographyAncestry(area);
  const byLevel = new Map(chain.map((row) => [String(row.level || '').toLowerCase(), row]));
  const zone = String(area.level || '').toLowerCase() === 'zone' ? area : byLevel.get('zone') || null;
  const ward = String(area.level || '').toLowerCase() === 'ward' ? area : byLevel.get('ward') || null;
  const baseGeography =
    byLevel.get('city') ||
    byLevel.get('district') ||
    zone ||
    ward ||
    area;

  return {
    area,
    zone,
    ward,
    geography: baseGeography,
    hierarchy: await deriveFacilityHierarchySnapshot({ area, zone, ward }),
  };
};

const assertFacilityLocationInsideArea = ({ area = null, point = null }) => {
  if (!area || !point) return;
  const geometryType = String(area.geometry_type || area.geometryType || '').trim().toLowerCase();
  if (geometryType === 'polygon') {
    const polygon = polygonPointsFromGeoJson(area.geojson);
    if (polygon.length >= 3 && !pointInPolygon(point, polygon)) {
      throw new AppError('The selected Facility location is outside the boundary of this Zone. Move the map pin inside the Zone and try again.', 400, {
        code: 'FACILITY_OUTSIDE_AREA_BOUNDARY',
      });
    }
    return;
  }
  if (geometryType === 'circle') {
    const insideCircle = isPointInsideCircle(
      point,
      {
        latitude: area.boundary_center_latitude ?? area.boundaryCenterLatitude,
        longitude: area.boundary_center_longitude ?? area.boundaryCenterLongitude,
      },
      area.boundary_radius_meters ?? area.boundaryRadiusMeters
    );
    if (!insideCircle) {
      throw new AppError('The selected Facility location is outside the boundary of this Zone. Move the map pin inside the Zone and try again.', 400, {
        code: 'FACILITY_OUTSIDE_AREA_BOUNDARY',
      });
    }
  }
};

const assertGeographyGeometryInsideParent = ({
  parent = null,
  level = null,
  geometryPayload = {},
}) => {
  const targetLevel = String(level || '').trim().toLowerCase();
  if (!['zone', 'ward'].includes(targetLevel) || !parent) return;

  const parentGeometryType = String(parent.geometry_type || parent.geometryType || '').trim().toLowerCase();
  const hasParentGeometry = parentGeometryType === 'polygon' || parentGeometryType === 'circle';
  if (!hasParentGeometry) return;

  const childGeometryType = String(geometryPayload.geometryType || '').trim().toLowerCase();
  if (childGeometryType === 'polygon') {
    const childPolygon = polygonPointsFromGeoJson(geometryPayload.geojson);
    if (childPolygon.length < 3) return;
    const outsidePoint = childPolygon.find((point) => {
      try {
        assertFacilityLocationInsideArea({
          area: parent,
          point: { latitude: point.lat, longitude: point.lng },
        });
        return false;
      } catch (_) {
        return true;
      }
    });
    if (outsidePoint) {
      throw new AppError('Boundary must stay inside the selected parent geography', 409, {
        code: 'GEOGRAPHY_OUTSIDE_PARENT_BOUNDARY',
      });
    }
    return;
  }

  if (childGeometryType === 'circle') {
    const center = (() => {
      const lat = toFiniteNumber(geometryPayload.boundaryCenterLatitude);
      const lng = toFiniteNumber(geometryPayload.boundaryCenterLongitude);
      return isValidLatitude(lat) && isValidLongitude(lng) ? { lat, lng } : null;
    })();
    const radius = toFiniteNumber(geometryPayload.boundaryRadiusMeters);
    if (!center || !Number.isFinite(radius) || radius <= 0) return;

    if (parentGeometryType === 'circle') {
      const parentCenter = (() => {
        const lat = toFiniteNumber(parent.boundary_center_latitude ?? parent.boundaryCenterLatitude);
        const lng = toFiniteNumber(parent.boundary_center_longitude ?? parent.boundaryCenterLongitude);
        return isValidLatitude(lat) && isValidLongitude(lng) ? { lat, lng } : null;
      })();
      const parentRadius = toFiniteNumber(parent.boundary_radius_meters ?? parent.boundaryRadiusMeters);
      if (parentCenter && Number.isFinite(parentRadius) && parentRadius > 0) {
        const edgeDistance = haversineMeters({
          lat1: center.lat,
          lng1: center.lng,
          lat2: parentCenter.lat,
          lng2: parentCenter.lng,
        }) + radius;
        if (edgeDistance > parentRadius) {
          throw new AppError('Circle must stay inside the selected parent geography', 409, {
            code: 'GEOGRAPHY_OUTSIDE_PARENT_BOUNDARY',
          });
        }
        return;
      }
    }

    const candidatePoints = [center, ...sampleCirclePerimeterPoints({ center, radiusMeters: radius, segments: 16 })];
    const outsidePoint = candidatePoints.find((point) => {
      try {
        assertFacilityLocationInsideArea({
          area: parent,
          point: { latitude: point.lat, longitude: point.lng },
        });
        return false;
      } catch (_) {
        return true;
      }
    });
    if (outsidePoint) {
      throw new AppError('Circle must stay inside the selected parent geography', 409, {
        code: 'GEOGRAPHY_OUTSIDE_PARENT_BOUNDARY',
      });
    }
    return;
  }

  const centroid = (() => {
    const lat = toFiniteNumber(geometryPayload.centroidLatitude);
    const lng = toFiniteNumber(geometryPayload.centroidLongitude);
    return isValidLatitude(lat) && isValidLongitude(lng) ? { lat, lng } : null;
  })();
  if (centroid) {
    assertFacilityLocationInsideArea({ area: parent, point: centroid });
  }
};

const buildFacilityScopeCode = ({ areaCode, areaName, tenantCode }) => {
  const preferred = sanitizeText(areaCode || '', 40) || sanitizeText(areaName || '', 40) || sanitizeText(tenantCode || '', 40) || 'AREA';
  return String(preferred)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 24) || 'AREA';
};

const resolveUniqueFacilityCode = async ({
  tenantId,
  scopeCode,
  year = new Date().getUTCFullYear(),
}) => {
  const normalizedScopeCode = buildFacilityScopeCode({ areaCode: scopeCode });
  const prefix = `FAC-${normalizedScopeCode}-${year}`;
  let sequence = 1;
  while (sequence <= 999999) {
    const candidate = `${prefix}-${String(sequence).padStart(4, '0')}`;
    const duplicate = await Facility.findOne({
      where: {
        tenant_id: tenantId,
        code: { [Op.iLike]: candidate },
      },
      attributes: ['id'],
    });
    if (!duplicate) return candidate;
    sequence += 1;
  }
  throw new AppError('Unable to generate unique facility code', 409, {
    code: 'FACILITY_CODE_EXISTS',
  });
};

const ensureFacilityQrTokenRecord = async ({
  facility,
  req,
  transaction = null,
  reason = null,
}) => {
  const qrId = uuidv4();
  const token = buildFacilityQrToken({
    facilityId: facility.id,
    tenantId: facility.tenant_id,
    qrId,
  });
  const tokenHash = hashFacilityQrToken(token);

  await FacilityQrCode.update(
    {
      status: reason ? 'replaced' : 'inactive',
      is_primary: false,
      compromised_reason: reason ? sanitizeOptionalText(reason, 600) : null,
      updated_by_user_id: req.user?.id || null,
      updated_at: new Date(),
    },
    {
      where: { facility_id: facility.id, is_primary: true },
      transaction,
    }
  );

  const qrPayload = {
    facilityId: facility.id,
    tenantId: facility.tenant_id,
    target: 'facility',
    resolveUrl: buildFacilityQrResolveUrl(token),
  };

  const qrRow = await FacilityQrCode.create(
    {
      id: qrId,
      tenant_id: facility.tenant_id,
      facility_id: facility.id,
      qr_token_hash: tokenHash,
      schema_version: FACILITY_QR_SCHEMA_VERSION,
      qr_payload: qrPayload,
      status: 'active',
      is_primary: true,
      created_by_user_id: req.user?.id || null,
      updated_by_user_id: req.user?.id || null,
    },
    { transaction }
  );

  const image = await ensureFacilityQrImage({
    facilityId: facility.id,
    qrCodeValue: qrPayload.resolveUrl,
  });

  return {
    qrRow,
    qrCodeValue: qrPayload.resolveUrl,
    qrImageUrl: image.qrImageUrl,
    token,
  };
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
  contactName: row.contact_name || row.metadata?.contactName || null,
  contactPhone: row.contact_phone || row.metadata?.contactPhone || null,
  contactEmail: row.contact_email || row.metadata?.contactEmail || null,
  latitude: row.latitude !== null ? Number(row.latitude) : null,
  longitude: row.longitude !== null ? Number(row.longitude) : null,
  mapDisplayAddress: row.map_display_address || null,
  mapPlaceId: row.map_place_id || null,
  mapSource: row.map_source || null,
  locationStatus: row.location_status || 'mapped',
  status: row.status,
  hierarchy: row.metadata?.hierarchy || null,
  areaId: row.metadata?.hierarchy?.areaId || null,
  areaName: row.metadata?.hierarchy?.areaName || null,
  areaLevel: row.metadata?.hierarchy?.areaLevel || null,
  qr: row.qrCodes?.find((item) => item.is_primary) || row.qr || null,
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
  where = await withLiveGeographyScope(req, where, { tenantId, geographyKey: 'geography_id' });
  where = withFacilityScope(req, where, 'id');
  if (req.query.geographyId) {
    if (!(await isGeographyInLiveScope(req, req.query.geographyId, { tenantId }))) {
      throw new AppError('geographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.geography_id = req.query.geographyId;
  }
  if (req.query.zoneGeographyId) {
    if (!(await isGeographyInLiveScope(req, req.query.zoneGeographyId, { tenantId }))) {
      throw new AppError('zoneGeographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.zone_geography_id = req.query.zoneGeographyId;
  }
  if (req.query.wardGeographyId) {
    if (!(await isGeographyInLiveScope(req, req.query.wardGeographyId, { tenantId }))) {
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
      { model: FacilityQrCode, as: 'qrCodes', attributes: ['id', 'schema_version', 'status', 'is_primary', 'created_at'], required: false },
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

  const selectedArea = await ensureScopedGeographyInTenant({
    req,
    geographyId:
      req.body.areaId || req.body.wardGeographyId || req.body.zoneGeographyId || req.body.geographyId || null,
    tenantId,
    field: 'areaId',
  });
  const facilityScope = await deriveFacilityScopeFromArea(selectedArea);
  const supervisor = await ensureSupervisorForTenant({
    supervisorUserId: req.body.supervisorUserId || null,
    tenantId,
  });
  await assertFacilityGeographyConsistency({
    geography: facilityScope.geography,
    zone: facilityScope.zone,
    ward: facilityScope.ward,
  });

  const hasCoordinates =
    req.body.latitude !== undefined &&
    req.body.longitude !== undefined &&
    req.body.latitude !== '' &&
    req.body.longitude !== '';
  const facilityTimezone = normalizeTimezoneInput(req.body.timezone, { nullable: true });
  const facilityLocation = hasCoordinates
    ? normalizeCoordinatePair({
        latitude: req.body.latitude,
        longitude: req.body.longitude,
        field: 'facility map pin',
      })
    : { latitude: null, longitude: null };
  if (hasCoordinates) {
    assertFacilityLocationInsideArea({ area: selectedArea, point: facilityLocation });
  }
  const facilityMapSelection = normalizeMapSelectionPayload(req.body);
  const locationStatus = normalizeFacilityLocationStatus(req.body.locationStatus, {
    hasCoordinates: Boolean(facilityLocation.latitude !== null && facilityLocation.longitude !== null),
  });
  const requestedStatus = String(req.body.status || '').trim().toLowerCase();
  const operationalStatus =
    locationStatus === 'pending'
      ? 'location_pending'
      : ['active', 'inactive', 'maintenance'].includes(requestedStatus)
        ? requestedStatus
        : 'active';
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'code'] });
  const generatedCode =
    sanitizeText(req.body.code, 120) ||
    await resolveUniqueFacilityCode({
      tenantId,
      scopeCode: facilityScope.hierarchy.areaCode || tenant?.code || 'AREA',
      year: new Date().getUTCFullYear(),
    });
  const metadata = {
    ...(req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
    hierarchy: facilityScope.hierarchy,
  };
  const facility = await Facility.create({
    tenant_id: tenantId,
    geography_id: facilityScope.area.id,
    zone_geography_id: facilityScope.zone?.id || null,
    ward_geography_id: facilityScope.ward?.id || null,
    supervisor_user_id: supervisor?.id || null,
    code: generatedCode,
    name: sanitizeText(req.body.name, 220),
    facility_type: sanitizeText(req.body.facilityType, 80),
    address_line: sanitizeOptionalText(req.body.addressLine || req.body.landmark, 300),
    contact_name: sanitizeOptionalText(req.body.contactName || req.body.caretakerName, 180),
    contact_phone: sanitizeOptionalText(req.body.contactPhone || req.body.caretakerPhone, 32),
    contact_email: sanitizeOptionalText(req.body.contactEmail || req.body.caretakerEmail, 180),
    latitude: facilityLocation.latitude,
    longitude: facilityLocation.longitude,
    map_display_address: facilityMapSelection.mapDisplayAddress,
    map_place_id: facilityMapSelection.mapPlaceId,
    map_source: facilityMapSelection.mapSource,
    location_status: locationStatus,
    timezone: facilityTimezone,
    status: operationalStatus,
    metadata,
  });
  const qrResult = await ensureFacilityQrTokenRecord({ facility, req });
  await createAuditLog({
    req,
    action: 'facility.create',
    entityType: 'facility',
    entityId: facility.id,
    tenantId,
    details: {
      code: facility.code,
      areaName: facilityScope.hierarchy.areaName,
      locationStatus,
      qrSchemaVersion: FACILITY_QR_SCHEMA_VERSION,
    },
  });
  await createAuditLog({
    req,
    action: 'facility.qr_generate',
    entityType: 'facility',
    entityId: facility.id,
    tenantId,
    details: {
      qrId: qrResult.qrRow.id,
      schemaVersion: FACILITY_QR_SCHEMA_VERSION,
    },
  });
  const payload = await Facility.findByPk(facility.id, {
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
      { model: PlatformUser, as: 'supervisor', attributes: ['id', 'full_name'], required: false },
      { model: FacilityQrCode, as: 'qrCodes', attributes: ['id', 'schema_version', 'status', 'is_primary', 'qr_payload', 'created_at'], required: false },
    ],
  });
  const mapped = mapFacilityRow(payload);
  mapped.qr = {
    id: qrResult.qrRow.id,
    schemaVersion: FACILITY_QR_SCHEMA_VERSION,
    qrImageUrl: qrResult.qrImageUrl,
    resolveUrl: qrResult.qrCodeValue,
    printableLabel: buildFacilityPrintableLabel({
      facilityName: mapped.name,
      facilityCode: mapped.code,
      areaLabel: mapped.areaName || mapped.zoneName || mapped.wardName || null,
      qrImageUrl: qrResult.qrImageUrl,
    }),
  };
  return mapped;
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

  const supervisor =
    req.body.supervisorUserId !== undefined
      ? await ensureSupervisorForTenant({
          supervisorUserId: req.body.supervisorUserId || null,
          tenantId: facility.tenant_id,
        })
      : null;
  const nextArea =
    req.body.areaId !== undefined ||
    req.body.geographyId !== undefined ||
    req.body.zoneGeographyId !== undefined ||
    req.body.wardGeographyId !== undefined
      ? await ensureScopedGeographyInTenant({
          req,
          geographyId:
            req.body.areaId || req.body.wardGeographyId || req.body.zoneGeographyId || req.body.geographyId || null,
          tenantId: facility.tenant_id,
          field: 'areaId',
        })
      : facility.geography_id
        ? await Geography.findByPk(facility.geography_id)
        : null;
  const nextScope = await deriveFacilityScopeFromArea(nextArea);
  await assertFacilityGeographyConsistency({
    geography: nextScope.geography,
    zone: nextScope.zone,
    ward: nextScope.ward,
  });
  const facilityTimezone =
    req.body.timezone !== undefined
      ? normalizeTimezoneInput(req.body.timezone, { nullable: true })
      : facility.timezone;
  const nextHasCoordinates =
    req.body.latitude !== undefined || req.body.longitude !== undefined
      ? req.body.latitude !== '' && req.body.longitude !== ''
      : facility.latitude !== null && facility.longitude !== null;
  const facilityLocation =
    req.body.latitude !== undefined || req.body.longitude !== undefined
      ? nextHasCoordinates
        ? normalizeCoordinatePair({
            latitude: req.body.latitude,
            longitude: req.body.longitude,
            field: 'facility map pin',
          })
        : { latitude: null, longitude: null }
      : { latitude: facility.latitude, longitude: facility.longitude };
  if (facilityLocation.latitude !== null && facilityLocation.longitude !== null) {
    assertFacilityLocationInsideArea({ area: nextScope.area, point: facilityLocation });
  }
  const facilityMapSelection = normalizeMapSelectionPayload(req.body);
  const locationStatus = normalizeFacilityLocationStatus(
    req.body.locationStatus !== undefined ? req.body.locationStatus : facility.location_status,
    { hasCoordinates: Boolean(facilityLocation.latitude !== null && facilityLocation.longitude !== null) }
  );
  const requestedStatus = String(req.body.status || facility.status || '').trim().toLowerCase();
  await facility.update({
    geography_id: nextScope.area?.id || null,
    zone_geography_id: nextScope.zone?.id || null,
    ward_geography_id: nextScope.ward?.id || null,
    supervisor_user_id:
      req.body.supervisorUserId !== undefined
        ? supervisor?.id || null
        : facility.supervisor_user_id,
    name: req.body.name ? sanitizeText(req.body.name, 220) : facility.name,
    facility_type: req.body.facilityType || facility.facility_type,
    address_line:
      req.body.addressLine !== undefined || req.body.landmark !== undefined
        ? sanitizeOptionalText(req.body.addressLine || req.body.landmark, 300)
        : facility.address_line,
    contact_name:
      req.body.contactName !== undefined || req.body.caretakerName !== undefined
        ? sanitizeOptionalText(req.body.contactName || req.body.caretakerName, 180)
        : facility.contact_name,
    contact_phone:
      req.body.contactPhone !== undefined || req.body.caretakerPhone !== undefined
        ? sanitizeOptionalText(req.body.contactPhone || req.body.caretakerPhone, 32)
        : facility.contact_phone,
    contact_email:
      req.body.contactEmail !== undefined || req.body.caretakerEmail !== undefined
        ? sanitizeOptionalText(req.body.contactEmail || req.body.caretakerEmail, 180)
        : facility.contact_email,
    latitude: facilityLocation.latitude,
    longitude: facilityLocation.longitude,
    map_display_address:
      req.body.mapDisplayAddress !== undefined || req.body.displayAddress !== undefined
        ? facilityMapSelection.mapDisplayAddress
        : facility.map_display_address,
    map_place_id:
      req.body.mapPlaceId !== undefined || req.body.placeId !== undefined
        ? facilityMapSelection.mapPlaceId
        : facility.map_place_id,
    map_source:
      req.body.mapSource !== undefined || req.body.placeSource !== undefined || req.body.source !== undefined
        ? facilityMapSelection.mapSource
        : facility.map_source,
    location_status: locationStatus,
    timezone: facilityTimezone,
    status:
      locationStatus === 'pending'
        ? 'location_pending'
        : ['active', 'inactive', 'maintenance'].includes(requestedStatus)
          ? requestedStatus
          : facility.status,
    metadata: {
      ...(facility.metadata && typeof facility.metadata === 'object' ? facility.metadata : {}),
      ...(req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}),
      hierarchy: nextScope.hierarchy,
    },
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    action: 'facility.update',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: {
      code: facility.code,
      areaName: nextScope.hierarchy.areaName,
      locationStatus,
    },
  });
  const payload = await Facility.findByPk(facility.id, {
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
      { model: PlatformUser, as: 'supervisor', attributes: ['id', 'full_name'], required: false },
      { model: FacilityQrCode, as: 'qrCodes', attributes: ['id', 'schema_version', 'status', 'is_primary', 'qr_payload', 'created_at'], required: false },
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
      { model: FacilityQrCode, as: 'qrCodes', attributes: ['id', 'schema_version', 'status', 'is_primary', 'qr_payload', 'created_at', 'last_scanned_at'], required: false },
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

  const primaryQr = (facility.qrCodes || []).find((item) => item.is_primary) || null;
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
    mapDisplayAddress: facility.map_display_address || null,
    mapPlaceId: facility.map_place_id || null,
    mapSource: facility.map_source || null,
    locationStatus: facility.location_status || 'mapped',
    status: facility.status,
    contactName: facility.contact_name || facility.metadata?.contactName || null,
    contactPhone: facility.contact_phone || facility.metadata?.contactPhone || null,
    contactEmail: facility.contact_email || facility.metadata?.contactEmail || null,
    hierarchy: facility.metadata?.hierarchy || null,
    areaId: facility.metadata?.hierarchy?.areaId || facility.geography_id || null,
    areaName: facility.metadata?.hierarchy?.areaName || null,
    metadata: facility.metadata,
    qr: primaryQr
      ? {
          id: primaryQr.id,
          schemaVersion: primaryQr.schema_version,
          status: primaryQr.status,
          resolveUrl: primaryQr.qr_payload?.resolveUrl || null,
          qrImageUrl: getFacilityQrImageUrl(facility.id),
          lastScannedAt: primaryQr.last_scanned_at || null,
          printableLabel: buildFacilityPrintableLabel({
            facilityName: facility.name,
            facilityCode: facility.code,
            areaLabel:
              facility.metadata?.hierarchy?.areaName ||
              facility.zone?.name ||
              facility.ward?.name ||
              null,
            qrImageUrl: getFacilityQrImageUrl(facility.id),
          }),
        }
      : null,
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

const loadScopedFacilityWithQr = async (req) => {
  const facility = await Facility.findByPk(req.params.id, {
    include: [
      {
        model: FacilityQrCode,
        as: 'qrCodes',
        attributes: [
          'id',
          'schema_version',
          'status',
          'is_primary',
          'qr_payload',
          'created_at',
          'updated_at',
          'last_scanned_at',
        ],
        required: false,
      },
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
  const primaryQr = (facility.qrCodes || []).find((item) => item.is_primary && item.status === 'active') || null;
  if (!primaryQr) {
    throw new AppError('Facility QR is not available', 404, { code: 'FACILITY_QR_NOT_FOUND' });
  }
  return { facility, primaryQr };
};

const buildFacilityQrResponse = ({ facility, primaryQr }) => ({
  facilityId: facility.id,
  facilityCode: facility.code,
  facilityName: facility.name,
  qrId: primaryQr.id,
  schemaVersion: primaryQr.schema_version,
  status: primaryQr.status,
  resolveUrl: primaryQr.qr_payload?.resolveUrl || null,
  qrImageUrl: getFacilityQrImageUrl(facility.id),
  printableLabel: buildFacilityPrintableLabel({
    facilityName: facility.name,
    facilityCode: facility.code,
    areaLabel:
      facility.metadata?.hierarchy?.areaName ||
      facility.metadata?.hierarchy?.zoneName ||
      facility.metadata?.hierarchy?.wardName ||
      null,
    qrImageUrl: getFacilityQrImageUrl(facility.id),
  }),
});

const getFacilityQr = async (req) => {
  const { facility, primaryQr } = await loadScopedFacilityWithQr(req);
  await createAuditLog({
    req,
    action: 'facility.qr_view',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: { qrId: primaryQr.id },
  });
  return buildFacilityQrResponse({ facility, primaryQr });
};

const downloadFacilityQr = async (req) => {
  const { facility, primaryQr } = await loadScopedFacilityWithQr(req);
  await ensureFacilityQrImage({
    facilityId: facility.id,
    qrCodeValue: primaryQr.qr_payload?.resolveUrl || '',
  });
  await createAuditLog({
    req,
    action: 'facility.qr_download',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: { qrId: primaryQr.id },
  });
  return buildFacilityQrResponse({ facility, primaryQr });
};

const printFacilityQrLabel = async (req) => {
  const { facility, primaryQr } = await loadScopedFacilityWithQr(req);
  await createAuditLog({
    req,
    action: 'facility.qr_print',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: { qrId: primaryQr.id },
  });
  return buildFacilityQrResponse({ facility, primaryQr });
};

const regenerateFacilityQr = async (req) => {
  const { facility, primaryQr } = await loadScopedFacilityWithQr(req);
  await FacilityQrCode.update(
    {
      status: 'replaced',
      is_primary: false,
      compromised_reason: sanitizeOptionalText(req.body?.reason || 'Regenerated by admin', 600),
      updated_by_user_id: req.user?.id || null,
      updated_at: new Date(),
    },
    {
      where: { id: primaryQr.id },
    }
  );
  await createAuditLog({
    req,
    action: 'facility.qr_invalidate',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: { qrId: primaryQr.id, reason: sanitizeOptionalText(req.body?.reason || 'Regenerated by admin', 600) },
  });
  const qrResult = await ensureFacilityQrTokenRecord({
    facility,
    req,
    reason: req.body?.reason || 'Regenerated by admin',
  });
  await createAuditLog({
    req,
    action: 'facility.qr_regenerate',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: { previousQrId: primaryQr.id, qrId: qrResult.qrRow.id },
  });
  return {
    facilityId: facility.id,
    facilityCode: facility.code,
    qrId: qrResult.qrRow.id,
    schemaVersion: FACILITY_QR_SCHEMA_VERSION,
    qrImageUrl: qrResult.qrImageUrl,
    resolveUrl: qrResult.qrCodeValue,
    printableLabel: buildFacilityPrintableLabel({
      facilityName: facility.name,
      facilityCode: facility.code,
      areaLabel: facility.metadata?.hierarchy?.areaName || null,
      qrImageUrl: qrResult.qrImageUrl,
    }),
  };
};

const resolveFacilityFromQr = async (req) => {
  const token =
    sanitizeOptionalText(req.query?.t || req.body?.token || req.body?.rawQrValue, 1200) || null;
  if (!token) {
    throw new AppError('QR token is required', 400, { code: 'FACILITY_QR_TOKEN_REQUIRED' });
  }
  const tokenHash = hashFacilityQrToken(token);
  const qrRow = await FacilityQrCode.findOne({
    where: {
      qr_token_hash: tokenHash,
      status: 'active',
      is_primary: true,
    },
    include: [
      {
        model: Facility,
        as: 'facility',
      },
    ],
  });
  if (!qrRow?.facility) {
    throw new AppError('Facility QR is invalid or inactive', 404, { code: 'FACILITY_QR_INVALID' });
  }
  const facility = qrRow.facility;
  if (!req.user.isSuperAdmin && req.user.tenantId !== facility.tenant_id) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  await qrRow.update({
    last_scanned_at: new Date(),
    updated_by_user_id: req.user?.id || null,
    updated_at: new Date(),
  });
  const permissionCodes = new Set(
    (Array.isArray(req.user?.permissionCodes) ? req.user.permissionCodes : []).map((value) =>
      String(value || '').trim().toLowerCase()
    )
  );
  const targetPath = permissionCodes.has('inspection.create')
    ? `/ops/toilets?facilityId=${facility.id}`
    : `/ops/admin?section=facilities&facilityId=${facility.id}`;
  const targetFlow = permissionCodes.has('inspection.create')
    ? 'inspection_checkin'
    : 'facility_profile';
  await createAuditLog({
    req,
    action: 'facility.qr_scan',
    entityType: 'facility',
    entityId: facility.id,
    tenantId: facility.tenant_id,
    details: { qrId: qrRow.id, targetFlow },
  });
  return {
    facilityId: facility.id,
    facilityCode: facility.code,
    facilityName: facility.name,
    qrId: qrRow.id,
    targetFlow,
    targetPath,
  };
};

const listBlocks = async (req) => {
  const where = {};
  const facilityInclude = {
    model: Facility,
    attributes: ['id', 'tenant_id'],
    required: true,
  };
  facilityInclude.where = await buildFacilityIncludeScopeWhere(req);
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
  facilityInclude.where = await buildFacilityIncludeScopeWhere(req);
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
    if (!(await isGeographyInLiveScope(req, req.query.wardGeographyId))) {
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
  facilityInclude.where = await buildFacilityIncludeScopeWhere(req);

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
    if (!(await isGeographyInLiveScope(req, req.query.wardGeographyId))) {
      throw new AppError('wardGeographyId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    facilityInclude.where.ward_geography_id = req.query.wardGeographyId;
  }

  if (req.query.zoneGeographyId) {
    if (!(await isGeographyInLiveScope(req, req.query.zoneGeographyId))) {
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

    const exactLocation = normalizeCoordinatePair({
      latitude: req.body.latitude,
      longitude: req.body.longitude,
      field: 'toilet map selection',
    });
    const toiletMapSelection = normalizeMapSelectionPayload(req.body);
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
        latitude: exactLocation.latitude,
        longitude: exactLocation.longitude,
        map_display_address: toiletMapSelection.mapDisplayAddress,
        map_place_id: toiletMapSelection.mapPlaceId,
        map_source: toiletMapSelection.mapSource,
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
  listGlobalGeographyOptions,
  isOfficialIndiaSelectionRequest,
  activateGlobalGeography,
  listGlobalGeographyDataSources,
  createGeography,
  patchGeography,
  removeGeography,
  listGeographyImportJobs,
  runGeographyImportJob,
  requestMissingArea,
  listGeographyMigrationReviews,
  resolveGeographyMigrationReview,
  setTenantGeographyAssignment,
  listFacilities,
  createFacility,
  getFacilityQr,
  downloadFacilityQr,
  printFacilityQrLabel,
  regenerateFacilityQr,
  resolveFacilityFromQr,
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
  __private: {
    isGeographyInLiveScope,
    resolveCanonicalPlatformParentId,
    resolvePlatformSeedIdFromLocationNames,
    resolveLiveScopeSeedIds,
    resolveComparableScopeAncestryIds,
    circleGeoJsonFromCenterRadius,
    deriveGeometryPayload,
    normalizeFacilityLocationStatus,
    pointInPolygon,
    isPointInsideCircle,
    buildFacilityScopeCode,
    assertFacilityLocationInsideArea,
    assertGeographyGeometryInsideParent,
    sampleCirclePerimeterPoints,
  },
};
