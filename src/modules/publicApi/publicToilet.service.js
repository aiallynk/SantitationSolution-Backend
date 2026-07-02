const crypto = require('crypto');
const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  ToiletUnit,
  ToiletBlock,
  Facility,
  Inspection,
  AiAnalysisResult,
  SensorDevice,
  SensorReading,
  Complaint,
} = require('../../models');
const { runtimeConfig } = require('../../config/runtime');
const { formatInTimezone } = require('../../utils/timezone');
const { normalizeList } = require('./publicApiAuth.middleware');

const IST_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_ENDPOINT_PERMISSION = 'toilets:nearby:read';
const INCLUDE_CLOSED_PERMISSION = 'toilets:include_closed';

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const clampScore = (value) => {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, Number(parsed.toFixed(2))));
};

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const haversineMeters = ({ lat1, lng1, lat2, lng2 }) => {
  const radiusMeters = 6371_000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const publicToiletId = (id) =>
  `san_toilet_${crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 16)}`;

const getMetadata = (row) => {
  const metadata = row?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata;
};

const getUnitCoordinates = (unit) => {
  const lat = toNumberOrNull(unit.latitude) ?? toNumberOrNull(unit.Facility?.latitude);
  const lng = toNumberOrNull(unit.longitude) ?? toNumberOrNull(unit.Facility?.longitude);
  return lat === null || lng === null ? null : { lat, lng };
};

const getPublicName = (unit) => {
  const facilityName = unit.Facility?.name || 'Public Toilet';
  const blockName = unit.ToiletBlock?.name || '';
  const unitLabel = unit.location_label || unit.code || '';
  return [facilityName, blockName, unitLabel].filter(Boolean).join(' - ').slice(0, 220);
};

const getAvailabilityStatus = (unit) => {
  const unitStatus = String(unit.status || '').toLowerCase();
  const facilityStatus = String(unit.Facility?.status || '').toLowerCase();
  const deleted = Boolean(unit.deleted_at);
  if (deleted || unitStatus === 'out_of_service' || facilityStatus === 'inactive') {
    return 'closed';
  }
  if (facilityStatus === 'maintenance' || unitStatus === 'critical') {
    return 'temporarily_closed';
  }
  return 'operational';
};

const isOperational = (unit) => getAvailabilityStatus(unit) === 'operational';

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
  const odor = toNumberOrNull(reading.odor_ppm) ?? toNumberOrNull(payload.odor_ppm) ?? toNumberOrNull(payload.odor);
  const ammonia = toNumberOrNull(reading.ammonia_ppm) ?? toNumberOrNull(payload.ammonia_ppm);
  const h2s = toNumberOrNull(reading.h2s_ppm) ?? toNumberOrNull(payload.h2s_ppm);
  const humidity = toNumberOrNull(reading.humidity) ?? toNumberOrNull(payload.humidity);
  let score = 100;
  if (odor !== null) score -= Math.min(25, odor * 2);
  if (ammonia !== null) score -= Math.min(20, ammonia * 4);
  if (h2s !== null) score -= Math.min(20, h2s * 6);
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

const resolveTenantScope = ({ apiKey, project, requestedTenantId }) => {
  const projectTenantIds = normalizeList(project?.allowed_tenant_ids);
  const keyTenantIds = normalizeList(apiKey?.allowed_tenant_ids);
  const allowed = keyTenantIds.length > 0 ? keyTenantIds : projectTenantIds;
  if (!requestedTenantId) return allowed;
  if (!allowed.includes(String(requestedTenantId))) {
    throw new AppError('Requested tenant is outside API key scope', 403, { code: 'TENANT_SCOPE_FORBIDDEN' });
  }
  return [String(requestedTenantId)];
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

  const tenantIds = resolveTenantScope({
    apiKey,
    project,
    requestedTenantId: req.query.tenant_id,
  });

  if (tenantIds.length === 0) {
    return { items: [], meta: { count: 0, radiusMeters: radius, limit, tenantScoped: false } };
  }

  const where = {
    is_public_visible: true,
    deleted_at: null,
  };
  if (!includeClosed) {
    where.status = { [Op.ne]: 'out_of_service' };
  }

  const units = await ToiletUnit.findAll({
    where,
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
          ...(includeClosed ? {} : { status: 'active' }),
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

  const withinRadius = units
    .map((unit) => {
      const coordinates = getUnitCoordinates(unit);
      if (!coordinates) return null;
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
    .filter(({ unit }) => includeClosed || isOperational(unit))
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
      if (cleanlinessMin !== null && cleanliness.cleanliness_score !== null && cleanliness.cleanliness_score < cleanlinessMin) {
        return null;
      }
      if (cleanlinessMin !== null && cleanliness.cleanliness_score === null) {
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

module.exports = {
  getNearbyToilets,
  validateNearbyQuery,
  computeCleanliness,
};
