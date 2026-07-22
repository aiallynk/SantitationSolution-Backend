const crypto = require('crypto');
const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  ToiletUnit,
  ToiletBlock,
  Facility,
  Tenant,
  ApiKey,
  ApiProject,
  Inspection,
  AiAnalysisResult,
  SensorDevice,
  SensorReading,
  Complaint,
} = require('../../models');
const { runtimeConfig } = require('../../config/runtime');
const { formatInTimezone } = require('../../utils/timezone');
const { normalizeList } = require('./publicApiAuth.middleware');
const {
  DEFAULT_ENDPOINT_PERMISSION,
  INCLUDE_CLOSED_PERMISSION,
  getApiScopeTenantIds,
  haversineMeters,
  isPublicOperational,
  isTenantSharingEnabled,
  normalizeOperationalStatus,
  normalizeToiletCoordinates,
  publicUnitWhere,
  shouldIncludeForCleanliness,
  toBoolean,
  toNumberOrNull,
} = require('./toiletPublicFilters');

const IST_TIMEZONE = 'Asia/Kolkata';

const clampScore = (value) => {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, Number(parsed.toFixed(2))));
};

const publicToiletId = (id) =>
  `san_toilet_${crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 16)}`;

const getMetadata = (row) => {
  const metadata = row?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata;
};

const getPublicName = (unit) => {
  const facilityName = unit.Facility?.name || 'Public Toilet';
  const blockName = unit.ToiletBlock?.name || '';
  const unitLabel = unit.location_label || unit.code || '';
  return [facilityName, blockName, unitLabel].filter(Boolean).join(' - ').slice(0, 220);
};

const getAvailabilityStatus = (unit) => {
  const status = normalizeOperationalStatus(unit);
  if (status === 'Open') return 'operational';
  if (status === 'Maintenance') return 'temporarily_closed';
  return 'closed';
};

const extractPublicFacilities = (unit) => {
  const unitMetadata = getMetadata(unit);
  const facilityMetadata = getMetadata(unit.Facility);
  const publicFacilities = {
    ...(facilityMetadata.publicFacilities || facilityMetadata.public_facilities || {}),
    ...(unitMetadata.publicFacilities || unitMetadata.public_facilities || {}),
  };
  const genderText = [
    unit.ToiletBlock?.gender_type,
    unit.unit_type,
    unitMetadata.gender,
    publicFacilities.gender,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return {
    male: toBoolean(publicFacilities.male, genderText.includes('male') && !genderText.includes('female')),
    female: toBoolean(publicFacilities.female, genderText.includes('female')),
    accessible: toBoolean(
      publicFacilities.accessible ??
        publicFacilities.wheelchairAccessible ??
        unitMetadata.accessible ??
        unitMetadata.isAccessible ??
        facilityMetadata.accessible,
      genderText.includes('accessible') || genderText.includes('disabled')
    ),
    water_available: toBoolean(
      publicFacilities.waterAvailable ??
        publicFacilities.water_available ??
        unitMetadata.waterAvailable ??
        unitMetadata.water_available ??
        facilityMetadata.waterAvailable ??
        facilityMetadata.water_available,
      false
    ),
  };
};

const getLatestBy = (rows, foreignKey, dateField) => {
  const map = new Map();
  for (const row of rows || []) {
    const key = row[foreignKey];
    if (!key || map.has(key)) continue;
    map.set(key, row);
  }
  return map;
};

const extractSensorScore = (reading) => {
  if (!reading) return null;
  const payload = getMetadata({ metadata: reading.raw_payload });
  const ppm = toNumberOrNull(reading.ppm) ?? toNumberOrNull(payload.ppm);
  const humidity = toNumberOrNull(reading.humidity) ?? toNumberOrNull(payload.humidity);
  let score = 100;
  if (ppm !== null) score -= Math.min(40, ppm * 2);
  if (humidity !== null && humidity > 85) score -= Math.min(15, (humidity - 85) * 1.5);
  return clampScore(score);
};

const computeCleanliness = ({ unit, inspection, aiResult, sensorReading, activeComplaintCount }) => {
  const staleHours = Number(runtimeConfig.publicApi?.cleanlinessStaleHours || 72);
  const now = Date.now();
  const inspectionScore =
    clampScore(inspection?.avg_after_score) ??
    clampScore(inspection?.avg_before_score) ??
    clampScore(unit.latest_after_score) ??
    clampScore(unit.latest_score);
  const aiScore = clampScore(aiResult?.cleanliness_score);
  const sensorScore = extractSensorScore(sensorReading);

  const scoredSignals = [
    { score: inspectionScore, weight: 0.5 },
    { score: aiScore, weight: 0.3 },
    { score: sensorScore, weight: 0.2 },
  ].filter((item) => item.score !== null);

  const freshnessDates = [
    inspection?.last_scored_at,
    inspection?.captured_at,
    aiResult?.processed_at,
    sensorReading?.recorded_at_utc,
    sensorReading?.timestamp,
    unit.last_inspection_at,
  ]
    .map((value) => (value ? new Date(value) : null))
    .filter((date) => date && !Number.isNaN(date.getTime()));
  const latestUpdate = freshnessDates.sort((a, b) => b.getTime() - a.getTime())[0] || null;
  const stale = !latestUpdate || now - latestUpdate.getTime() > staleHours * 3600_000;

  if (scoredSignals.length === 0 || stale) {
    return {
      cleanliness_score: scoredSignals.length > 0
        ? clampScore(scoredSignals.reduce((sum, item) => sum + item.score, 0) / scoredSignals.length - 8)
        : null,
      cleanliness_status: 'Status Unknown',
      last_cleanliness_updated_at_ist: latestUpdate
        ? formatInTimezone(latestUpdate, IST_TIMEZONE, { includeSeconds: true })
        : null,
      confidence: 'low',
    };
  }

  const weightedSum = scoredSignals.reduce((sum, item) => sum + item.score * item.weight, 0);
  const totalWeight = scoredSignals.reduce((sum, item) => sum + item.weight, 0);
  const complaintPenalty = Math.min(25, Number(activeComplaintCount || 0) * 8);
  const score = clampScore(weightedSum / totalWeight - complaintPenalty);
  let status = 'Avoid / Under Maintenance';
  if (score >= 85) status = 'Clean';
  else if (score >= 70) status = 'Usable';
  else if (score >= 50) status = 'Needs Cleaning';

  return {
    cleanliness_score: score,
    cleanliness_status: status,
    last_cleanliness_updated_at_ist: latestUpdate
      ? formatInTimezone(latestUpdate, IST_TIMEZONE, { includeSeconds: true })
      : null,
    confidence: scoredSignals.length >= 2 ? 'medium' : 'low',
  };
};

const validateNearbyQuery = (query = {}) => {
  const errors = [];
  const lat = toNumberOrNull(query.lat);
  const lng = toNumberOrNull(query.lng);
  const defaultRadius = Number(runtimeConfig.publicApi?.defaultNearbyRadiusMeters || 2000);
  const maxRadius = Number(runtimeConfig.publicApi?.maxNearbyRadiusMeters || 10000);
  const defaultLimit = Number(runtimeConfig.publicApi?.defaultNearbyLimit || 20);
  const maxLimit = Number(runtimeConfig.publicApi?.maxNearbyLimit || 100);
  const radius = query.radius === undefined || query.radius === '' ? defaultRadius : toNumberOrNull(query.radius);
  const limit = query.limit === undefined || query.limit === '' ? defaultLimit : Number.parseInt(String(query.limit), 10);
  const cleanlinessMin = query.cleanliness_min === undefined || query.cleanliness_min === ''
    ? null
    : toNumberOrNull(query.cleanliness_min);
  const includeClosed = toBoolean(query.include_closed, false);

  if (lat === null) errors.push('lat is required and must be a valid number');
  else if (lat < -90 || lat > 90) errors.push('lat must be between -90 and 90');
  if (lng === null) errors.push('lng is required and must be a valid number');
  else if (lng < -180 || lng > 180) errors.push('lng must be between -180 and 180');
  if (radius === null || radius <= 0) errors.push('radius must be a positive number');
  else if (radius > maxRadius) errors.push(`radius must be ${maxRadius} meters or less`);
  if (!Number.isInteger(limit) || limit <= 0) errors.push('limit must be a positive integer');
  else if (limit > maxLimit) errors.push(`limit must be ${maxLimit} or less`);
  if (cleanlinessMin !== null && (cleanlinessMin < 0 || cleanlinessMin > 100)) {
    errors.push('cleanliness_min must be between 0 and 100');
  }

  if (errors.length > 0) {
    throw new AppError('Validation failed', 400, { code: 'VALIDATION_ERROR', errors });
  }
  return { lat, lng, radius, limit, cleanlinessMin, includeClosed };
};

const resolveEligibleTenants = async ({ apiKey, project, requestedTenantId }) => {
  const scopedTenantIds = getApiScopeTenantIds({ apiKey, project });
  const requested = requestedTenantId ? String(requestedTenantId) : null;
  if (requested && scopedTenantIds.length > 0 && !scopedTenantIds.includes(requested)) {
    throw new AppError('Requested tenant is outside API key scope', 403, { code: 'TENANT_SCOPE_FORBIDDEN' });
  }

  const where = {
    status: 'active',
    external_api_sharing_enabled: true,
  };
  if (requested) {
    where.id = requested;
  } else if (scopedTenantIds.length > 0) {
    where.id = { [Op.in]: scopedTenantIds };
  }

  const tenants = await Tenant.findAll({
    where,
    attributes: ['id', 'name', 'code', 'status', 'external_api_sharing_enabled', 'metadata'],
  });
  const tenantIds = tenants.map((tenant) => String(tenant.id));

  if (requested && !tenantIds.includes(requested)) {
    throw new AppError('Requested tenant is not enabled for external sharing', 403, {
      code: 'TENANT_SHARING_DISABLED',
    });
  }

  return { tenantIds, tenants };
};

const fetchLatestSignals = async (toiletIds) => {
  if (toiletIds.length === 0) {
    return {
      inspectionsByToilet: new Map(),
      aiByInspection: new Map(),
      sensorByToilet: new Map(),
      complaintsByToilet: new Map(),
    };
  }

  const inspections = await Inspection.findAll({
    where: { toilet_unit_id: { [Op.in]: toiletIds } },
    order: [['captured_at', 'DESC'], ['created_at', 'DESC']],
    limit: Math.max(50, toiletIds.length * 3),
  });
  const inspectionsByToilet = getLatestBy(inspections, 'toilet_unit_id');
  const inspectionIds = inspections.map((row) => row.id).filter(Boolean);

  const [aiResults, devices, complaintRows] = await Promise.all([
    inspectionIds.length > 0
      ? AiAnalysisResult.findAll({
          where: { inspection_id: { [Op.in]: inspectionIds } },
          order: [['processed_at', 'DESC'], ['created_at', 'DESC']],
        })
      : [],
    SensorDevice.findAll({
      where: {
        toilet_unit_id: { [Op.in]: toiletIds },
        status: 'active',
      },
      attributes: ['id', 'toilet_unit_id'],
    }),
    Complaint.findAll({
      where: {
        toilet_unit_id: { [Op.in]: toiletIds },
        status: { [Op.in]: ['open', 'assigned'] },
      },
      attributes: ['id', 'toilet_unit_id'],
    }),
  ]);

  const aiByInspection = getLatestBy(aiResults, 'inspection_id');
  const deviceToToilet = new Map(devices.map((device) => [device.id, device.toilet_unit_id]));
  const readings = devices.length > 0
    ? await SensorReading.findAll({
        where: { device_id: { [Op.in]: devices.map((device) => device.id) } },
        order: [['timestamp', 'DESC'], ['created_at', 'DESC']],
        limit: Math.max(50, devices.length * 3),
      })
    : [];
  const sensorByToilet = new Map();
  for (const reading of readings) {
    const toiletId = deviceToToilet.get(reading.device_id);
    if (!toiletId || sensorByToilet.has(toiletId)) continue;
    sensorByToilet.set(toiletId, reading);
  }

  const complaintsByToilet = new Map();
  for (const row of complaintRows) {
    const toiletId = row.toilet_unit_id;
    complaintsByToilet.set(toiletId, Number(complaintsByToilet.get(toiletId) || 0) + 1);
  }

  return { inspectionsByToilet, aiByInspection, sensorByToilet, complaintsByToilet };
};

const getNearbyToilets = async (req) => {
  const { lat, lng, radius, limit, cleanlinessMin, includeClosed } = validateNearbyQuery(req.query);
  const apiKey = req.publicApi?.key;
  const project = req.publicApi?.project;
  const permissions = normalizeList(apiKey?.permissions);

  if (!permissions.includes(DEFAULT_ENDPOINT_PERMISSION) && !permissions.includes('*')) {
    throw new AppError('API key does not have toilet read permission', 403, { code: 'PERMISSION_FORBIDDEN' });
  }
  if (includeClosed && !permissions.includes(INCLUDE_CLOSED_PERMISSION) && !permissions.includes('*')) {
    throw new AppError('API key is not allowed to request closed toilets', 403, { code: 'INCLUDE_CLOSED_FORBIDDEN' });
  }

  const { tenantIds } = await resolveEligibleTenants({
    apiKey,
    project,
    requestedTenantId: req.query.tenant_id,
  });

  if (tenantIds.length === 0) {
    req.publicApi = {
      ...(req.publicApi || {}),
      nearbyStats: {
        eligible_tenant_count: 0,
        candidate_toilet_count: 0,
        returned_count: 0,
      },
    };
    return { items: [], meta: { count: 0, radiusMeters: radius, limit, tenantScoped: false } };
  }

  const units = await ToiletUnit.findAll({
    where: publicUnitWhere({ includeClosed }),
    attributes: [
      'id',
      'facility_id',
      'toilet_block_id',
      'code',
      'unit_type',
      'status',
      'location_label',
      'latitude',
      'longitude',
      'latest_score',
      'latest_after_score',
      'last_inspection_at',
      'last_cleaned_at',
      'timezone',
      'location',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
    include: [
      {
        model: Facility,
        required: true,
        attributes: ['id', 'tenant_id', 'name', 'address_line', 'latitude', 'longitude', 'status', 'timezone', 'metadata'],
        where: {
          tenant_id: { [Op.in]: tenantIds },
          ...(includeClosed ? {} : { status: { [Op.notIn]: ['inactive', 'maintenance'] } }),
        },
      },
      {
        model: ToiletBlock,
        required: false,
        attributes: ['id', 'name', 'gender_type', 'status'],
      },
    ],
    limit: Math.max(limit * 10, 200),
  });

  const stats = {
    eligible_tenant_count: tenantIds.length,
    candidate_toilet_count: units.length,
    returned_count: 0,
    dropped_missing_coordinates_count: 0,
    dropped_invalid_coordinates_count: 0,
    dropped_tenant_sharing_count: 0,
    dropped_api_scope_count: 0,
    dropped_public_visibility_count: 0,
    dropped_status_count: 0,
    dropped_cleanliness_count: 0,
  };

  const withinRadius = units
    .map((unit) => {
      const coordinates = normalizeToiletCoordinates(unit);
      if (!coordinates.valid) {
        if (coordinates.reason === 'MISSING_COORDINATES') stats.dropped_missing_coordinates_count += 1;
        else stats.dropped_invalid_coordinates_count += 1;
        return null;
      }
      const distance = haversineMeters({
        lat1: lat,
        lng1: lng,
        lat2: coordinates.lat,
        lng2: coordinates.lng,
      });
      if (distance > radius) return null;
      return { unit, coordinates, distance };
    })
    .filter(Boolean)
    .filter(({ unit }) => {
      const included = includeClosed || isPublicOperational(unit);
      if (!included) stats.dropped_status_count += 1;
      return included;
    })
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit);

  const toiletIds = withinRadius.map(({ unit }) => unit.id);
  const { inspectionsByToilet, aiByInspection, sensorByToilet, complaintsByToilet } =
    await fetchLatestSignals(toiletIds);

  const items = withinRadius
    .map(({ unit, coordinates, distance }) => {
      const inspection = inspectionsByToilet.get(unit.id) || null;
      const aiResult = inspection ? aiByInspection.get(inspection.id) || null : null;
      const sensorReading = sensorByToilet.get(unit.id) || null;
      const cleanliness = computeCleanliness({
        unit,
        inspection,
        aiResult,
        sensorReading,
        activeComplaintCount: complaintsByToilet.get(unit.id) || 0,
      });
      if (!shouldIncludeForCleanliness({
        cleanlinessScore: cleanliness.cleanliness_score,
        cleanlinessMin,
      })) {
        stats.dropped_cleanliness_count += 1;
        return null;
      }
      const verifiedAt = inspection?.captured_at || unit.last_inspection_at || unit.updated_at || null;
      return {
        public_toilet_id: publicToiletId(unit.id),
        toilet_name: getPublicName(unit),
        latitude: Number(coordinates.lat.toFixed(7)),
        longitude: Number(coordinates.lng.toFixed(7)),
        address: unit.Facility?.address_line || null,
        distance_meters: Math.round(distance),
        cleanliness_score: cleanliness.cleanliness_score,
        cleanliness_status: cleanliness.cleanliness_status,
        last_cleanliness_updated_at_ist: cleanliness.last_cleanliness_updated_at_ist,
        availability_status: getAvailabilityStatus(unit),
        last_verified_at_ist: verifiedAt
          ? formatInTimezone(verifiedAt, IST_TIMEZONE, { includeSeconds: true })
          : null,
        public_facilities: extractPublicFacilities(unit),
      };
    })
    .filter(Boolean)
    .slice(0, limit);

  stats.returned_count = items.length;
  req.publicApi = {
    ...(req.publicApi || {}),
    nearbyStats: stats,
  };

  return {
    items,
    meta: {
      count: items.length,
      radiusMeters: radius,
      limit,
      tenantScoped: Boolean(req.query.tenant_id),
      maxRadiusMeters: Number(runtimeConfig.publicApi?.maxNearbyRadiusMeters || 10000),
    },
  };
};

const loadDebugApiKeyContext = async ({ apiKeyId, keyPrefix }) => {
  if (!apiKeyId && !keyPrefix) return { apiKey: null, project: null };
  const where = apiKeyId ? { id: apiKeyId } : { key_prefix: { [Op.iLike]: `${String(keyPrefix).trim()}%` } };
  const apiKey = await ApiKey.findOne({
    where,
    include: [{ model: ApiProject, as: 'project', required: false }],
  });
  if (!apiKey) {
    throw new AppError('API key not found for debug simulation', 404, { code: 'API_KEY_NOT_FOUND' });
  }
  return { apiKey, project: apiKey.project || apiKey.ApiProject || null };
};

const sampleToilet = ({ unit, reason = null, fieldValue = undefined, distance = null, cleanliness = null, coordinates = null }) => ({
  toiletId: unit.id,
  toiletUnitId: unit.id,
  toiletName: getPublicName(unit),
  tenantId: unit.Facility?.tenant_id || null,
  tenantName: unit.Facility?.Tenant?.name || null,
  status: normalizeOperationalStatus(unit),
  isPublicVisible: Boolean(unit.is_public_visible),
  latitude: unit.latitude ?? null,
  longitude: unit.longitude ?? null,
  locationCoordinates: unit.location?.coordinates || null,
  cleanlinessScore: cleanliness?.cleanliness_score ?? unit.latest_after_score ?? unit.latest_score ?? null,
  lastInspectionTime: unit.last_inspection_at || null,
  environment: process.env.NODE_ENV || runtimeConfig.nodeEnv || null,
  createdAt: unit.created_at || null,
  updatedAt: unit.updated_at || null,
  ...(distance !== null ? { distanceMeters: Math.round(distance) } : {}),
  ...(coordinates ? { normalizedCoordinates: coordinates } : {}),
  ...(reason ? { reason, fieldValue } : {}),
});

const addExcluded = (excludedSamples, payload) => {
  if (excludedSamples.length >= 50) return;
  excludedSamples.push(payload);
};

const getDebugNearbyToilets = async ({
  lat,
  lng,
  radius,
  apiKeyId = null,
  keyPrefix = null,
  cleanlinessMin = 0,
  includeClosed = false,
} = {}) => {
  const query = {
    lat,
    lng,
    radius,
    cleanliness_min: cleanlinessMin,
    include_closed: includeClosed,
    limit: 50,
  };
  const validated = validateNearbyQuery(query);
  const { apiKey, project } = await loadDebugApiKeyContext({ apiKeyId, keyPrefix });
  const scopedTenantIds = apiKey || project ? getApiScopeTenantIds({ apiKey, project }) : [];
  const tenants = await Tenant.findAll({
    attributes: ['id', 'name', 'code', 'status', 'external_api_sharing_enabled', 'metadata', 'created_at', 'updated_at'],
  });
  const tenantById = new Map(tenants.map((tenant) => [String(tenant.id), tenant]));
  const sharingTenantIds = tenants
    .filter((tenant) => tenant.status === 'active' && isTenantSharingEnabled(tenant))
    .map((tenant) => String(tenant.id));
  const allowedTenantIds = scopedTenantIds.length > 0
    ? sharingTenantIds.filter((tenantId) => scopedTenantIds.includes(tenantId))
    : sharingTenantIds;
  const allowedTenantSet = new Set(allowedTenantIds);

  const units = await ToiletUnit.findAll({
    where: { deleted_at: null },
    attributes: [
      'id',
      'facility_id',
      'toilet_block_id',
      'code',
      'unit_type',
      'status',
      'is_public_visible',
      'location_label',
      'latitude',
      'longitude',
      'latest_score',
      'latest_after_score',
      'last_inspection_at',
      'location',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
    include: [
      {
        model: Facility,
        required: false,
        attributes: ['id', 'tenant_id', 'name', 'address_line', 'latitude', 'longitude', 'status', 'metadata'],
        include: [{ model: Tenant, attributes: ['id', 'name', 'code', 'external_api_sharing_enabled'], required: false }],
      },
      { model: ToiletBlock, required: false, attributes: ['id', 'name', 'gender_type', 'status'] },
    ],
    limit: 5000,
  });

  const toiletIds = units.map((unit) => unit.id).filter(Boolean);
  const { inspectionsByToilet, aiByInspection, sensorByToilet, complaintsByToilet } = await fetchLatestSignals(toiletIds);
  const funnel = {
    totalToiletsInDb: units.length,
    withValidCoordinates: 0,
    withinRadius: 0,
    afterTenantSharing: 0,
    afterApiKeyScope: 0,
    afterPublicVisible: 0,
    afterStatusFilter: 0,
    afterCleanlinessFilter: 0,
    finalReturned: 0,
  };
  const excludedSamples = [];
  const matchedSamples = [];
  let hasRelevantPublicToiletWithInvalidCoordinates = false;

  for (const unit of units) {
    const coordinates = normalizeToiletCoordinates(unit);
    const tenantId = String(unit.Facility?.tenant_id || '');
    const tenant = tenantById.get(tenantId) || unit.Facility?.Tenant || null;
    const tenantAllowedForPublicApi = allowedTenantSet.has(tenantId);
    const publicVisible = unit.is_public_visible === true;
    const statusAllowed = validated.includeClosed || isPublicOperational(unit);
    if (!coordinates.valid) {
      if (tenantAllowedForPublicApi && publicVisible && statusAllowed) {
        hasRelevantPublicToiletWithInvalidCoordinates = true;
      }
      addExcluded(excludedSamples, sampleToilet({ unit, reason: coordinates.reason, fieldValue: coordinates, coordinates }));
      continue;
    }
    funnel.withValidCoordinates += 1;
    const distance = haversineMeters({
      lat1: validated.lat,
      lng1: validated.lng,
      lat2: coordinates.lat,
      lng2: coordinates.lng,
    });
    if (distance > validated.radius) {
      addExcluded(excludedSamples, sampleToilet({ unit, reason: 'OUTSIDE_RADIUS', fieldValue: Math.round(distance), distance, coordinates }));
      continue;
    }
    funnel.withinRadius += 1;

    if (!tenant || !isTenantSharingEnabled(tenant)) {
      addExcluded(excludedSamples, sampleToilet({ unit, reason: 'TENANT_SHARING_DISABLED', fieldValue: tenant?.external_api_sharing_enabled ?? null, distance, coordinates }));
      continue;
    }
    funnel.afterTenantSharing += 1;

    if (scopedTenantIds.length > 0 && !scopedTenantIds.includes(tenantId)) {
      addExcluded(excludedSamples, sampleToilet({ unit, reason: 'API_KEY_TENANT_SCOPE_DENIED', fieldValue: tenantId, distance, coordinates }));
      continue;
    }
    funnel.afterApiKeyScope += 1;

    if (unit.is_public_visible !== true) {
      addExcluded(excludedSamples, sampleToilet({ unit, reason: 'IS_PUBLIC_VISIBLE_FALSE', fieldValue: unit.is_public_visible, distance, coordinates }));
      continue;
    }
    funnel.afterPublicVisible += 1;

    if (!validated.includeClosed && !isPublicOperational(unit)) {
      addExcluded(excludedSamples, sampleToilet({ unit, reason: 'STATUS_NOT_ALLOWED', fieldValue: normalizeOperationalStatus(unit), distance, coordinates }));
      continue;
    }
    funnel.afterStatusFilter += 1;

    const inspection = inspectionsByToilet.get(unit.id) || null;
    const aiResult = inspection ? aiByInspection.get(inspection.id) || null : null;
    const cleanliness = computeCleanliness({
      unit,
      inspection,
      aiResult,
      sensorReading: sensorByToilet.get(unit.id) || null,
      activeComplaintCount: complaintsByToilet.get(unit.id) || 0,
    });
    if (!shouldIncludeForCleanliness({ cleanlinessScore: cleanliness.cleanliness_score, cleanlinessMin: validated.cleanlinessMin })) {
      addExcluded(excludedSamples, sampleToilet({ unit, reason: 'CLEANLINESS_BELOW_THRESHOLD', fieldValue: cleanliness.cleanliness_score, distance, cleanliness, coordinates }));
      continue;
    }
    funnel.afterCleanlinessFilter += 1;
    funnel.finalReturned += 1;
    if (matchedSamples.length < 50) {
      matchedSamples.push(sampleToilet({ unit, distance, cleanliness, coordinates }));
    }
  }

  const recommendedFixes = [];
  if (funnel.withinRadius > funnel.afterTenantSharing) {
    recommendedFixes.push('Enable external API sharing for tenants that should publish toilets.');
  }
  if (funnel.afterApiKeyScope > funnel.afterPublicVisible) {
    recommendedFixes.push('Mark selected intended toilets as public visible.');
  }
  if (funnel.afterPublicVisible > funnel.afterStatusFilter) {
    recommendedFixes.push('Set intended public toilets to an open or operational status.');
  }
  if (funnel.afterStatusFilter > funnel.afterCleanlinessFilter) {
    recommendedFixes.push('Review cleanliness_min or unknown cleanliness policy.');
  }
  if (scopedTenantIds.length > 0 && funnel.afterTenantSharing > funnel.afterApiKeyScope) {
    recommendedFixes.push('Update API key/project tenant scope to include the share-enabled tenant.');
  }
  if (hasRelevantPublicToiletWithInvalidCoordinates) {
    recommendedFixes.push('Fix missing or invalid toilet coordinates.');
  }

  return {
    input: {
      lat: validated.lat,
      lng: validated.lng,
      radius: validated.radius,
      cleanliness_min: validated.cleanlinessMin ?? null,
      include_closed: validated.includeClosed,
      api_key_id: apiKey?.id || null,
      key_prefix: apiKey?.key_prefix || keyPrefix || null,
    },
    funnel,
    excludedSamples,
    matchedSamples,
    tenantScope: {
      sharingEnabledTenantCount: sharingTenantIds.length,
      apiScopeTenantCount: scopedTenantIds.length,
      eligibleTenantCount: allowedTenantIds.length,
    },
    recommendedFixes,
  };
};

module.exports = {
  getNearbyToilets,
  getDebugNearbyToilets,
  validateNearbyQuery,
  computeCleanliness,
  normalizeToiletCoordinates,
  resolveEligibleTenants,
};
