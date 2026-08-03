const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const {
  sequelize,
  Facility,
  Inspection,
  InspectionMedia,
  AiAnalysisResult,
  Alert,
  SensorDevice,
  SensorReading,
  InspectionTask,
  Complaint,
  StorageUsageMetric,
  DashboardAggregate,
  PlatformUser,
  WorkerAssignment,
  UserRole,
  Role,
  ToiletUnit,
  Geography,
  Tenant,
} = require('../../models');
const storageUsageService = require('../superAdmin/storageUsage.service');
const {
  EMPTY_SCOPE_UUID,
  buildAccessContextFromUser,
  applyScopeToQuery,
  uniqueIds,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');
const { ROLE_CODES } = require('../../core/rbac/personaFamilies');
const {
  resolveDateRange,
  applyDateRangeToWhere,
} = require('../../utils/dateRange');
const { getDefaultTimezone, toTimezoneDateKey } = require('../../utils/timezone');

const scopedTenantWhere = (req, where = {}, key = 'tenant_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'tenant', {
    tenantKey: key,
  });
};

const scopedFacilityWhere = (req, where = {}, facilityKey = 'facility_id', tenantKey = 'tenant_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'facility', {
    tenantKey,
    facilityKey,
  });
};

const scopedFacilityEntityWhere = (req, where = {}) => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'facility', {
    tenantKey: 'tenant_id',
    geographyKey: 'geography_id',
    facilityKey: 'id',
  });
};

const loadDeletedToiletIdsForScope = async (req) => {
  const rows = await ToiletUnit.findAll({
    where: { deleted_at: { [Op.not]: null } },
    attributes: ['id'],
    include: [
      {
        model: Facility,
        attributes: [],
        required: true,
        where: scopedFacilityEntityWhere(req),
      },
    ],
    raw: true,
  });
  return uniqueIds(rows.map((row) => row.id));
};

const excludeDeletedToiletsFromInspectionWhere = (where = {}, deletedToiletIds = []) => {
  if (!deletedToiletIds.length) return where;
  const existingAnd = Array.isArray(where[Op.and]) ? where[Op.and] : [];
  return {
    ...where,
    [Op.and]: [
      ...existingAnd,
      {
        [Op.or]: [
          { toilet_unit_id: { [Op.is]: null } },
          { toilet_unit_id: { [Op.notIn]: deletedToiletIds } },
        ],
      },
    ],
  };
};

const buildTimestampFilter = ({ start = null, end = null } = {}) => {
  const filter = {};
  if (start) filter[Op.gte] = start;
  if (end) filter[Op.lte] = end;
  return filter;
};

const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const GEO_LEVEL_SEQUENCE = ['country', 'state', 'district', 'city', 'zone', 'ward', 'cluster'];
const GEO_LEVEL_RANK = new Map(GEO_LEVEL_SEQUENCE.map((level, index) => [level, index]));
const SCOPE_ZOOM = {
  country: 5,
  state: 7,
  district: 10,
  city: 12,
  zone: 14,
  ward: 15,
  cluster: 16,
  organization: 11,
  platform: 4,
};

const toBoundedNumber = (value, { fallback = 0, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number(value);
  const resolved = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(resolved, min), max);
};

const toTimestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
};

const toIsoOrNull = (value) => {
  const time = toTimestamp(value);
  return time == null ? null : new Date(time).toISOString();
};

const toIstDateKey = (value) => toTimezoneDateKey(value, getDefaultTimezone());

const pickEarlierIso = (left, right) => {
  if (!left) return right || null;
  if (!right) return left || null;
  return toTimestamp(left) <= toTimestamp(right) ? left : right;
};

const pickLaterIso = (left, right) => {
  if (!left) return right || null;
  if (!right) return left || null;
  return toTimestamp(left) >= toTimestamp(right) ? left : right;
};

const isOnOrAfter = (isoValue, thresholdDate) => {
  const ts = toTimestamp(isoValue);
  const threshold = toTimestamp(thresholdDate);
  if (ts == null || threshold == null) return false;
  return ts >= threshold;
};

const resolveWorkforceStatus = ({
  attendanceStatus = 'Absent',
  activityAt = null,
  activeThresholdMinutes = 20,
  idleThresholdMinutes = 120,
}) => {
  // Derived status from attendance + recency because dedicated heartbeat tables are not present.
  const normalizedAttendance = String(attendanceStatus || '').toLowerCase();
  const activityTs = toTimestamp(activityAt);
  if (!activityTs || normalizedAttendance.includes('absent') || normalizedAttendance.includes('checked out')) {
    return 'Offline';
  }
  const ageMinutes = Math.max(0, Math.floor((Date.now() - activityTs) / 60000));
  if (ageMinutes <= activeThresholdMinutes) return 'Active';
  if (ageMinutes <= idleThresholdMinutes) return 'Idle';
  return 'Offline';
};

const getOverview = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const tenantFilter = scopedTenantWhere(req);
  const facilityEntityFilter = scopedFacilityEntityWhere(req);
  const inspectionTenantFilter = scopedFacilityWhere(req);
  const alertTenantFilter = scopedFacilityWhere(req);
  const taskTenantFilter = scopedFacilityWhere(req);
  const complaintTenantFilter = scopedFacilityWhere(req);
  const sensorTenantFilter = scopedFacilityWhere(req);
  const userScopeFilter = applyScopeToQuery(
    { ...tenantFilter },
    buildAccessContextFromUser(req?.user || {}),
    'geography',
    { tenantKey: 'tenant_id', geographyKey: 'geography_id' },
  );
  const deletedToiletIds = await loadDeletedToiletIdsForScope(req);

  const fallbackTodayRange = resolveDateRange({ range: 'today' }, { maxDays: 1 });
  const inspectionActivityFilter = excludeDeletedToiletsFromInspectionWhere(
    dateRange.provided
    ? applyDateRangeToWhere(inspectionTenantFilter, 'captured_at', dateRange)
    : { ...inspectionTenantFilter, created_at: { [Op.gte]: fallbackTodayRange.start } },
    deletedToiletIds,
  );
  const analysisInspectionFilter = excludeDeletedToiletsFromInspectionWhere(
    dateRange.provided
    ? applyDateRangeToWhere(inspectionTenantFilter, 'captured_at', dateRange)
    : inspectionTenantFilter,
    deletedToiletIds,
  );
  const alertActivityFilter = dateRange.provided
    ? applyDateRangeToWhere(alertTenantFilter, 'created_at', dateRange)
    : alertTenantFilter;
  const complaintActivityFilter = dateRange.provided
    ? applyDateRangeToWhere(complaintTenantFilter, 'created_at', dateRange)
    : complaintTenantFilter;
  const taskActivityFilter = dateRange.provided
    ? applyDateRangeToWhere(taskTenantFilter, 'scheduled_at', dateRange)
    : taskTenantFilter;

  const [
    totalFacilities,
    activeAlerts,
    inspectionsInRange,
    avgCleanlinessRow,
    sensorsOnline,
    totalSensors,
    openComplaints,
    tasksInProgress,
    usersActive,
  ] = await Promise.all([
    Facility.count({ where: facilityEntityFilter }),
    Alert.count({ where: { ...alertActivityFilter, status: { [Op.in]: ['open', 'acknowledged'] } } }),
    Inspection.count({ where: inspectionActivityFilter }),
    AiAnalysisResult.findOne({
      attributes: [[fn('AVG', col('cleanliness_score')), 'avgCleanliness']],
      include: [
        {
          model: Inspection,
          attributes: [],
          required: true,
          where: analysisInspectionFilter,
        },
      ],
      raw: true,
    }),
    SensorDevice.count({ where: { ...sensorTenantFilter, status: 'active' } }),
    SensorDevice.count({ where: sensorTenantFilter }),
    Complaint.count({ where: { ...complaintActivityFilter, status: { [Op.ne]: 'resolved' } } }),
    InspectionTask.count({ where: { ...taskActivityFilter, status: 'in_progress' } }),
    PlatformUser.count({ where: { ...userScopeFilter, status: 'active' } }),
  ]);

  return {
    totalFacilities,
    activeAlerts,
    inspectionsCompletedToday: inspectionsInRange,
    inspectionsInRange,
    cleanlinessAverage: Number(toNumber(avgCleanlinessRow?.avgCleanliness, 0).toFixed(2)),
    sensorHealth: {
      online: sensorsOnline,
      total: totalSensors,
      onlinePercent: totalSensors === 0 ? 0 : Number(((sensorsOnline / totalSensors) * 100).toFixed(2)),
    },
    openComplaints,
    workerProductivity: {
      tasksInProgress,
      activeUsers: usersActive,
    },
    dateRange: {
      range: dateRange.range,
      label: dateRange.label,
      days: dateRange.days,
      start: dateRange.start ? dateRange.start.toISOString() : null,
      end: dateRange.end ? dateRange.end.toISOString() : null,
    },
  };
};

const getMap = async (req) => {
  const facilities = await Facility.findAll({
    where: scopedFacilityEntityWhere(req),
    order: [['name', 'ASC']],
  });

  const facilityIds = facilities.map((facility) => facility.id);
  const latestAnalysisByFacility = {};

  if (facilityIds.length > 0) {
    const deletedToiletIds = await loadDeletedToiletIdsForScope(req);
    const inspections = await Inspection.findAll({
      where: excludeDeletedToiletsFromInspectionWhere({ facility_id: { [Op.in]: facilityIds } }, deletedToiletIds),
      include: [{ model: AiAnalysisResult }],
      order: [['captured_at', 'DESC']],
    });
    inspections.forEach((inspection) => {
      if (latestAnalysisByFacility[inspection.facility_id]) return;
      const analysis = (inspection.AiAnalysisResults || [])[0];
      if (analysis) {
        latestAnalysisByFacility[inspection.facility_id] = analysis;
      }
    });
  }

  return facilities.map((facility) => {
    const analysis = latestAnalysisByFacility[facility.id];
    return {
      facilityId: facility.id,
      facilityCode: facility.code,
      facilityName: facility.name,
      latitude: toNumber(facility.latitude, null),
      longitude: toNumber(facility.longitude, null),
      cleanlinessScore: analysis ? Number(analysis.cleanliness_score) : null,
      hygieneScore: analysis ? Number(analysis.hygiene_score) : null,
      facilityType: facility.facility_type,
      status: facility.status,
    };
  });
};

const parseBounds = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const north = toNumber(value.north, null);
  const south = toNumber(value.south, null);
  const east = toNumber(value.east, null);
  const west = toNumber(value.west, null);
  if ([north, south, east, west].some((item) => item === null)) return null;
  return { north, south, east, west };
};

const parseSplitBounds = (row) => {
  if (!row) return null;
  const north = toNumber(row.bounds_north, null);
  const south = toNumber(row.bounds_south, null);
  const east = toNumber(row.bounds_east, null);
  const west = toNumber(row.bounds_west, null);
  if ([north, south, east, west].some((item) => item === null)) return null;
  return { north, south, east, west };
};

const pointsToBounds = (points = []) => {
  const valid = points
    .map((point) => ({
      lat: toNumber(point?.lat ?? point?.latitude, null),
      lng: toNumber(point?.lng ?? point?.longitude, null),
    }))
    .filter((point) => point.lat !== null && point.lng !== null);
  if (valid.length === 0) return null;
  return {
    north: Math.max(...valid.map((point) => point.lat)),
    south: Math.min(...valid.map((point) => point.lat)),
    east: Math.max(...valid.map((point) => point.lng)),
    west: Math.min(...valid.map((point) => point.lng)),
  };
};

const mergeBounds = (left, right) => {
  const a = parseBounds(left);
  const b = parseBounds(right);
  if (!a) return b;
  if (!b) return a;
  return {
    north: Math.max(a.north, b.north),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    west: Math.min(a.west, b.west),
  };
};

const polygonPointsFromGeoJson = (geojson) => {
  if (!geojson || typeof geojson !== 'object') return [];
  if (String(geojson.type || '').toLowerCase() !== 'polygon') return [];
  const ring = Array.isArray(geojson.coordinates?.[0]) ? geojson.coordinates[0] : [];
  return ring
    .map((tuple) => {
      if (!Array.isArray(tuple) || tuple.length < 2) return null;
      const lng = toNumber(tuple[0], null);
      const lat = toNumber(tuple[1], null);
      return lat !== null && lng !== null ? { lat, lng } : null;
    })
    .filter(Boolean);
};

const mapGeographyScopeRow = (row) => {
  if (!row) return null;
  const lat = toNumber(row.latitude ?? row.centroid_latitude ?? row.boundary_center_latitude, null);
  const lng = toNumber(row.longitude ?? row.centroid_longitude ?? row.boundary_center_longitude, null);
  const polygonPoints = polygonPointsFromGeoJson(row.geojson);
  const bounds = parseBounds(row.bounds) || parseSplitBounds(row) || pointsToBounds(polygonPoints);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    parentId: row.parent_id || null,
    level: row.level,
    code: row.code,
    name: row.name,
    latitude: lat,
    longitude: lng,
    centroidLatitude: lat,
    centroidLongitude: lng,
    geometryType: row.geometry_type || null,
    geojson: row.simplified_geojson || row.geojson || null,
    bounds,
    boundaryCenterLatitude: row.boundary_center_latitude !== null ? Number(row.boundary_center_latitude) : null,
    boundaryCenterLongitude: row.boundary_center_longitude !== null ? Number(row.boundary_center_longitude) : null,
    boundaryRadiusMeters: row.boundary_radius_meters !== null ? Number(row.boundary_radius_meters) : null,
    displayAddress: row.formatted_address || row.map_display_address || row.boundary_label || null,
    placeId: row.place_id || row.map_place_id || null,
    source: row.map_source || null,
    scopeType: row.scope_type || row.level || null,
    scopeName: row.scope_name || row.name || null,
  };
};

const getDescendantIds = (rootId, childrenByParent) => {
  if (!rootId) return [];
  const result = [];
  const queue = [String(rootId)];
  const seen = new Set();
  while (queue.length > 0) {
    const parentId = queue.shift();
    if (!parentId || seen.has(parentId)) continue;
    seen.add(parentId);
    for (const child of childrenByParent.get(parentId) || []) {
      result.push(String(child.id));
      queue.push(String(child.id));
    }
  }
  return result;
};

const hasGeographyRestriction = (accessContext = {}) => {
  const scopeLevel = String(accessContext.scopeLevel || '').trim().toLowerCase();
  const geographyIds = uniqueIds(accessContext.geographyIds || []);
  return (
    geographyIds.length > 0 ||
    (scopeLevel && scopeLevel !== 'organization' && scopeLevel !== 'facility')
  );
};

const hasFacilityGeographyMapping = (facility = {}) =>
  uniqueIds([
    facility.geography_id,
    facility.zone_geography_id,
    facility.ward_geography_id,
  ]).length > 0;

const haversineMeters = (left, right) => {
  const radiusMeters = 6_371_000;
  const toRadians = (value) => (Number(value) * Math.PI) / 180;
  const latitudeDelta = toRadians(right.latitude - left.latitude);
  const longitudeDelta = toRadians(right.longitude - left.longitude);
  const latitudeA = toRadians(left.latitude);
  const latitudeB = toRadians(right.latitude);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const pointInsidePolygon = (point, polygon = []) => {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const intersects =
      (currentPoint.lat > point.latitude) !== (previousPoint.lat > point.latitude) &&
      point.longitude <
        ((previousPoint.lng - currentPoint.lng) * (point.latitude - currentPoint.lat)) /
          (previousPoint.lat - currentPoint.lat) +
          currentPoint.lng;
    if (intersects) inside = !inside;
  }
  return inside;
};

const isPointInsideOverviewScope = ({ latitude, longitude, scope = null }) => {
  const point = {
    latitude: toNumber(latitude, null),
    longitude: toNumber(longitude, null),
  };
  if (!scope || point.latitude === null || point.longitude === null) return false;

  const center = {
    latitude: toNumber(scope.boundaryCenterLatitude ?? scope.centroidLatitude ?? scope.latitude, null),
    longitude: toNumber(scope.boundaryCenterLongitude ?? scope.centroidLongitude ?? scope.longitude, null),
  };
  const radiusMeters = toNumber(scope.boundaryRadiusMeters, null);
  if (center.latitude !== null && center.longitude !== null && radiusMeters !== null && radiusMeters > 0) {
    return haversineMeters(point, center) <= radiusMeters;
  }

  const polygon = polygonPointsFromGeoJson(scope.geojson);
  if (polygon.length >= 3) return pointInsidePolygon(point, polygon);

  const bounds = parseBounds(scope.bounds);
  if (!bounds) return false;
  return (
    point.latitude >= bounds.south &&
    point.latitude <= bounds.north &&
    point.longitude >= bounds.west &&
    point.longitude <= bounds.east
  );
};

const isFacilityVisibleOnOverviewMap = ({ facility, scopedGeographyIds, accessContext, tenantId = null, scope = null }) => {
  if (!facility) return false;
  if (tenantId && String(facility.tenant_id || '') !== String(tenantId)) return false;
  if (accessContext?.isSuperAdmin) return true;

  const facilityId = String(facility.id || '').trim();
  const allowedFacilityIds = new Set(uniqueIds(accessContext?.facilityIds || []));
  // Explicit facility assignment is authoritative, including legacy facilities
  // that were created before geography IDs were required.
  if (allowedFacilityIds.has(facilityId)) return true;

  // A facility-scoped user must never receive a second facility through the
  // tenant-wide legacy fallback or a geography branch.
  if (String(accessContext?.scopeLevel || '').trim().toLowerCase() === 'facility') return false;

  const scopedIds = scopedGeographyIds instanceof Set
    ? scopedGeographyIds
    : new Set(uniqueIds(scopedGeographyIds || []));
  const facilityGeographyIds = uniqueIds([
    facility.geography_id,
    facility.zone_geography_id,
    facility.ward_geography_id,
  ]);
  if (facilityGeographyIds.some((id) => scopedIds.has(id))) return true;

  // Tenant-wide users retain access to same-tenant geography-less facilities.
  if (!hasGeographyRestriction(accessContext)) return true;

  // Geography-scoped legacy facilities have no mapping to resolve. They may be
  // shown only when their saved physical location is inside the assigned map
  // circle/polygon/bounds. This is read-only compatibility, never a remap.
  return !hasFacilityGeographyMapping(facility) && isPointInsideOverviewScope({
    latitude: facility.latitude,
    longitude: facility.longitude,
    scope,
  });
};

const resolveToiletMarkerCoordinates = (toilet = {}) => {
  const toiletLatitude = toNumber(toilet.latitude, null);
  const toiletLongitude = toNumber(toilet.longitude, null);
  if (toiletLatitude !== null && toiletLongitude !== null) {
    return { latitude: toiletLatitude, longitude: toiletLongitude, source: 'toilet' };
  }

  const facilityLatitude = toNumber(toilet.Facility?.latitude, null);
  const facilityLongitude = toNumber(toilet.Facility?.longitude, null);
  if (facilityLatitude !== null && facilityLongitude !== null) {
    return { latitude: facilityLatitude, longitude: facilityLongitude, source: 'facility' };
  }

  return null;
};

const resolveScopeGeography = async ({ req, tenantId }) => {
  const explicitScopeId = req.user?.geographyId || req.user?.scopeId || null;
  if (explicitScopeId) {
    const row = await Geography.findOne({
      where: {
        id: explicitScopeId,
        ...(tenantId ? { [Op.or]: [{ tenant_id: tenantId }, { tenant_id: null }] } : {}),
        is_active: true,
      },
    });
    if (row) return row;
  }

  const scopedIds = uniqueIds(req.user?.scopeGeographyIds || []);
  if (scopedIds.length > 0) {
    const rows = await Geography.findAll({
      where: {
        id: { [Op.in]: scopedIds },
        ...(tenantId ? { [Op.or]: [{ tenant_id: tenantId }, { tenant_id: null }] } : {}),
        is_active: true,
      },
    });
    const scopeLevel = String(req.user?.scopeLevel || '').toLowerCase();
    const exact = rows.find((row) => row.level === scopeLevel);
    if (exact) return exact;
    return rows
      .slice()
      .sort((left, right) => (GEO_LEVEL_RANK.get(left.level) ?? 99) - (GEO_LEVEL_RANK.get(right.level) ?? 99))[0] || null;
  }

  if (tenantId) {
    const tenant = await Tenant.findByPk(tenantId);
    if (tenant?.root_geography_id) {
      const root = await Geography.findByPk(tenant.root_geography_id);
      if (root) return root;
    }
    return await Geography.findOne({
      where: { tenant_id: tenantId },
      order: [
        ['level', 'ASC'],
        ['name', 'ASC'],
      ],
    });
  }

  return null;
};

const markerFromGeography = ({ row, children = [], toilets = [], assets = [] }) => {
  const mapped = mapGeographyScopeRow(row);
  if (!mapped || mapped.latitude === null || mapped.longitude === null) return null;
  return {
    id: mapped.id,
    type: 'geography',
    level: mapped.level,
    name: mapped.name,
    latitude: mapped.latitude,
    longitude: mapped.longitude,
    bounds: mapped.bounds,
    geojson: mapped.geojson,
    geometryType: mapped.geometryType,
    boundaryCenterLatitude: mapped.boundaryCenterLatitude,
    boundaryCenterLongitude: mapped.boundaryCenterLongitude,
    boundaryRadiusMeters: mapped.boundaryRadiusMeters,
    displayAddress: mapped.displayAddress,
    drilldown: {
      scopeGeographyId: mapped.id,
      childMarkers: children,
      toilets,
      assets,
      counts: {
        children: children.length,
        toilets: toilets.length,
        assets: assets.length,
      },
    },
  };
};

const getOverviewMapScope = async (req) => {
  const tenantId = req.user?.isSuperAdmin
    ? req.query.tenantId || req.user?.tenantId || null
    : req.user?.tenantId || null;
  const accessContext = buildAccessContextFromUser(req?.user || {});
  const scopeRow = await resolveScopeGeography({ req, tenantId });
  let geographyIds = [];
  if (scopeRow) {
    const descendants = await sequelize.query(
      `WITH RECURSIVE scoped_geographies AS (
         SELECT id, parent_id, global_geography_id, master_geography_id
         FROM geographies
         WHERE id = :scopeId AND is_active = TRUE
         UNION
         SELECT child.id, child.parent_id, child.global_geography_id, child.master_geography_id
         FROM geographies child
         INNER JOIN scoped_geographies parent ON child.parent_id = parent.id
           OR child.id = parent.global_geography_id
           OR child.id = parent.master_geography_id
           OR child.global_geography_id = parent.id
           OR child.master_geography_id = parent.id
           OR (
             child.global_geography_id IS NOT NULL
             AND child.global_geography_id = parent.global_geography_id
           )
           OR (
             child.master_geography_id IS NOT NULL
             AND child.master_geography_id = parent.master_geography_id
           )
         WHERE child.is_active = TRUE
           AND (child.tenant_id IS NULL OR child.tenant_id = :tenantId)
       )
       SELECT DISTINCT id FROM scoped_geographies`,
      {
        replacements: { scopeId: scopeRow.id, tenantId },
        type: QueryTypes.SELECT,
      }
    );
    geographyIds = descendants.map((row) => row.id);
  }
  const geographyWhere = scopeRow
    ? { id: { [Op.in]: geographyIds.length > 0 ? geographyIds : [scopeRow.id] } }
    : tenantId
      ? { tenant_id: tenantId, is_active: true }
      : { id: '00000000-0000-0000-0000-000000000000' };
  const geographies = await Geography.findAll({
    where: geographyWhere,
    order: [
      ['level', 'ASC'],
      ['name', 'ASC'],
    ],
  });
  const childrenByParent = new Map();
  for (const row of geographies) {
    const parentId = row.parent_id ? String(row.parent_id) : null;
    if (!parentId) continue;
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(row);
  }

  const globalScopeRow = scopeRow?.global_geography_id || scopeRow?.master_geography_id
    ? await Geography.findOne({
        where: {
          id: scopeRow.global_geography_id || scopeRow.master_geography_id,
          tenant_id: null,
          is_active: true,
        },
      })
    : null;
  const tenantScope = mapGeographyScopeRow(scopeRow);
  const globalScope = mapGeographyScopeRow(globalScopeRow);
  const scope = tenantScope
    ? {
        ...globalScope,
        ...tenantScope,
        latitude: tenantScope.latitude ?? globalScope?.latitude ?? null,
        longitude: tenantScope.longitude ?? globalScope?.longitude ?? null,
        centroidLatitude: tenantScope.centroidLatitude ?? globalScope?.centroidLatitude ?? null,
        centroidLongitude: tenantScope.centroidLongitude ?? globalScope?.centroidLongitude ?? null,
        geojson: tenantScope.geojson || globalScope?.geojson || null,
        geometryType: tenantScope.geometryType || globalScope?.geometryType || null,
        bounds: tenantScope.bounds || globalScope?.bounds || null,
      }
    : globalScope;
  const scopedGeoIds = scopeRow
    ? uniqueIds([scopeRow.id, ...geographyIds, ...getDescendantIds(scopeRow.id, childrenByParent)])
    : geographies.map((row) => String(row.id));
  const scopedGeoSet = new Set(scopedGeoIds);

  const facilityWhere = scopedFacilityEntityWhere(req);
  if (tenantId) facilityWhere.tenant_id = tenantId;
  const candidateFacilities = await Facility.findAll({
    where: facilityWhere,
    include: [
      { model: Geography, as: 'zone', attributes: ['id', 'name', 'level'], required: false },
      { model: Geography, as: 'ward', attributes: ['id', 'name', 'level'], required: false },
    ],
    order: [['name', 'ASC']],
  });
  const facilities = candidateFacilities.filter((facility) =>
    isFacilityVisibleOnOverviewMap({
      facility,
      scopedGeographyIds: scopedGeoSet,
      accessContext,
      tenantId,
      scope,
    })
  );
  const facilityIds = facilities.map((facility) => facility.id);
  const toilets = facilityIds.length > 0
    ? await ToiletUnit.findAll({
        where: {
          facility_id: { [Op.in]: facilityIds },
          deleted_at: { [Op.is]: null },
        },
        include: [{
          model: Facility,
          attributes: [
            'id',
            'name',
            'code',
            'latitude',
            'longitude',
            'address_line',
            'map_display_address',
            'geography_id',
            'zone_geography_id',
            'ward_geography_id',
          ],
          required: true,
        }],
        order: [['code', 'ASC']],
      })
    : [];

  const assetMarkers = facilities
    .map((facility) => {
      const lat = toNumber(facility.latitude, null);
      const lng = toNumber(facility.longitude, null);
      if (lat === null || lng === null) return null;
      return {
        id: facility.id,
        type: 'asset',
        level: 'asset',
        name: facility.name,
        code: facility.code,
        latitude: lat,
        longitude: lng,
        geographyId: facility.geography_id || null,
        zoneGeographyId: facility.zone_geography_id || null,
        wardGeographyId: facility.ward_geography_id || null,
        displayAddress: facility.map_display_address || facility.address_line || null,
      };
    })
    .filter(Boolean);

  const toiletMarkers = toilets
    .map((toilet) => {
      const coordinates = resolveToiletMarkerCoordinates(toilet);
      if (!coordinates) return null;
      return {
        id: toilet.id,
        type: 'toilet',
        level: 'toilet',
        name: toilet.location_label || toilet.code || toilet.Facility?.name,
        code: toilet.code,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        coordinateSource: coordinates.source,
        facilityId: toilet.facility_id,
        geographyId: toilet.Facility?.geography_id || null,
        zoneGeographyId: toilet.Facility?.zone_geography_id || null,
        wardGeographyId: toilet.Facility?.ward_geography_id || null,
        displayAddress: toilet.map_display_address || toilet.location_label || toilet.Facility?.map_display_address || toilet.Facility?.address_line || null,
        status: toilet.status || null,
        // `latest_score` is the persisted score already maintained for each
        // toilet unit. Expose it on the overview marker so the UI can colour a
        // shared physical-location marker without doing a second inspection query.
        latestScore: toNumber(toilet.latest_score, null),
      };
    })
    .filter(Boolean);

  const markersForGeography = (geoId) => {
    const descendantIds = new Set([String(geoId), ...getDescendantIds(geoId, childrenByParent)]);
    return {
      children: geographies
        .filter((row) => String(row.parent_id || '') === String(geoId))
        .map((row) => markerFromGeography({ row }))
        .filter(Boolean),
      toilets: toiletMarkers.filter((marker) =>
        [marker.geographyId, marker.zoneGeographyId, marker.wardGeographyId].some((id) => descendantIds.has(String(id || '')))
      ),
      assets: assetMarkers.filter((marker) =>
        [marker.geographyId, marker.zoneGeographyId, marker.wardGeographyId].some((id) => descendantIds.has(String(id || '')))
      ),
    };
  };

  const scopeLevel = String(scope?.level || req.user?.scopeLevel || '').toLowerCase();
  const tenantWideScope = !hasGeographyRestriction(accessContext);
  const facilityScopedUser = String(accessContext.scopeLevel || '').toLowerCase() === 'facility';
  const isUnmappedMarkerInsideScope = (marker) =>
    !hasFacilityGeographyMapping({
      geography_id: marker.geographyId,
      zone_geography_id: marker.zoneGeographyId,
      ward_geography_id: marker.wardGeographyId,
    }) &&
    isPointInsideOverviewScope({
      latitude: marker.latitude,
      longitude: marker.longitude,
      scope,
    });
  const childGeographies = scopeRow
    ? geographies.filter((row) => String(row.parent_id || '') === String(scopeRow.id))
    : geographies.filter((row) => !row.parent_id);
  const includeNestedGeographiesDirectly = ['district', 'city'].includes(scopeLevel);
  const geographyMarkers = (includeNestedGeographiesDirectly && scopeRow
    ? geographies.filter((row) => scopedGeoSet.has(String(row.id)) && String(row.id) !== String(scopeRow.id))
    : childGeographies)
    .map((row) => {
      const nested = markersForGeography(row.id);
      return markerFromGeography({
        row,
        children: nested.children,
        toilets: nested.toilets,
        assets: nested.assets,
      });
    })
    .filter(Boolean);

  const directToiletMarkers = scopeRow
    ? toiletMarkers.filter((marker) =>
        tenantWideScope ||
        facilityScopedUser ||
        [marker.geographyId, marker.zoneGeographyId, marker.wardGeographyId].some((id) => scopedGeoSet.has(String(id || ''))) ||
        isUnmappedMarkerInsideScope(marker)
      )
    : toiletMarkers;
  const directAssetMarkers = scopeRow
    ? assetMarkers.filter((marker) =>
        tenantWideScope ||
        facilityScopedUser ||
        [marker.geographyId, marker.zoneGeographyId, marker.wardGeographyId].some((id) => scopedGeoSet.has(String(id || ''))) ||
        isUnmappedMarkerInsideScope(marker)
      )
    : assetMarkers;
  const showDirectOperationalMarkers =
    tenantWideScope ||
    facilityScopedUser ||
    ['country', 'state', 'district', 'city', 'zone', 'ward', 'cluster'].includes(scopeLevel);

  const markers = [
    ...geographyMarkers,
    ...(showDirectOperationalMarkers ? directAssetMarkers : []),
    ...(showDirectOperationalMarkers ? directToiletMarkers : []),
  ];
  const allPoints = [
    ...(scope ? [{ lat: scope.latitude, lng: scope.longitude }] : []),
    ...markers.map((marker) => ({ lat: marker.latitude, lng: marker.longitude })),
  ].filter((point) => point.lat !== null && point.lng !== null);
  const fallbackBounds = pointsToBounds(allPoints);
  const mapBounds = scope?.bounds || pointsToBounds(polygonPointsFromGeoJson(scope?.geojson)) || fallbackBounds;

  return {
    tenantId,
    scope,
    center: scope?.latitude !== null && scope?.longitude !== null
      ? { lat: scope.latitude, lng: scope.longitude }
      : allPoints[0] || null,
    zoom: SCOPE_ZOOM[scopeLevel] || SCOPE_ZOOM.organization,
    bounds: mapBounds,
    boundary: scope?.geojson || null,
    markers,
    counts: {
      geographies: geographyMarkers.length,
      assets: directAssetMarkers.length,
      toilets: directToiletMarkers.length,
    },
  };
};

const getHeatmap = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const deletedToiletIds = await loadDeletedToiletIdsForScope(req);
  const north = toNumber(req.query.north, null);
  const south = toNumber(req.query.south, null);
  const east = toNumber(req.query.east, null);
  const west = toNumber(req.query.west, null);
  const where = excludeDeletedToiletsFromInspectionWhere(applyDateRangeToWhere(
    {
      ...scopedFacilityWhere(req),
      latitude: Number.isFinite(south) && Number.isFinite(north)
        ? { [Op.between]: [Math.min(south, north), Math.max(south, north)] }
        : { [Op.ne]: null },
      longitude: Number.isFinite(west) && Number.isFinite(east)
        ? { [Op.between]: [Math.min(west, east), Math.max(west, east)] }
        : { [Op.ne]: null },
    },
    'captured_at',
    dateRange,
  ), deletedToiletIds);

  const inspections = await Inspection.findAll({
    where,
    include: [{ model: AiAnalysisResult }],
    order: [['captured_at', 'DESC']],
    limit: Number(req.query.limit || 500),
  });

  const severity = String(req.query.severity || 'all').trim().toLowerCase();
  const matchesSeverity = (score) => {
    if (!severity || severity === 'all') return true;
    if (severity === 'critical') return score < 55;
    if (severity === 'warning' || severity === 'moderate') return score >= 55 && score < 75;
    if (severity === 'good' || severity === 'clean') return score >= 75;
    return true;
  };

  return inspections.map((inspection) => ({
    inspectionId: inspection.id,
    facilityId: inspection.facility_id,
    latitude: toNumber(inspection.latitude, null),
    longitude: toNumber(inspection.longitude, null),
    avgScore: toNumber(inspection.AiAnalysisResults?.[0]?.cleanliness_score, 0),
    count: 1,
    label: inspection.overall_status || inspection.processing_status,
  })).filter((point) => matchesSeverity(toNumber(point.avgScore, 0)));
};

const getFacilityDashboard = async (req) => {
  const facilityId = req.params.id;
  const facility = await Facility.findByPk(facilityId);
  if (!facility) return null;
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) return null;
  if (!isFacilityInScope(req, facility.id)) return null;
  const deletedToiletIds = await loadDeletedToiletIdsForScope(req);

  const [inspections, alerts, tasks, complaints] = await Promise.all([
    Inspection.findAll({
      where: excludeDeletedToiletsFromInspectionWhere(scopedFacilityWhere(req, { facility_id: facilityId }), deletedToiletIds),
      include: [{ model: AiAnalysisResult }, { model: InspectionMedia }],
      order: [['captured_at', 'DESC']],
      limit: 20,
    }),
    Alert.findAll({
      where: scopedFacilityWhere(req, { facility_id: facilityId }),
      order: [['created_at', 'DESC']],
      limit: 30,
    }),
    InspectionTask.findAll({
      where: scopedFacilityWhere(req, { facility_id: facilityId }),
      order: [['scheduled_at', 'DESC']],
      limit: 20,
    }),
    Complaint.findAll({
      where: scopedFacilityWhere(req, { facility_id: facilityId }),
      order: [['created_at', 'DESC']],
      limit: 20,
    }),
  ]);

  return {
    facility: {
      id: facility.id,
      code: facility.code,
      name: facility.name,
      addressLine: facility.address_line,
      latitude: toNumber(facility.latitude, null),
      longitude: toNumber(facility.longitude, null),
      status: facility.status,
    },
    inspections: inspections.map((item) => {
      const media = Array.isArray(item.InspectionMedia) ? item.InspectionMedia : [];
      const beforeMediaCount = media.filter((m) => m.capture_stage === 'before').length;
      const afterMediaCount = media.filter((m) => m.capture_stage === 'after').length;
      return {
        id: item.id,
        capturedAt: item.captured_at,
        processingStatus: item.processing_status,
        pipelineStatus: item.pipeline_status || item.processing_status,
        overallStatus: item.overall_status,
        cleanlinessScore: toNumber(item.AiAnalysisResults?.[0]?.cleanliness_score, null),
        beforeMediaCount,
        afterMediaCount,
        totalMediaCount: media.length,
        reviewRequired: Boolean(item.review_required),
      };
    }),
    alerts: alerts.map((alert) => ({
      id: alert.id,
      message: alert.message,
      severity: alert.severity,
      status: alert.status,
      createdAt: alert.created_at,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      taskType: task.task_type,
      status: task.status,
      scheduledAt: task.scheduled_at,
      completedAt: task.completed_at,
    })),
    complaints: complaints.map((complaint) => ({
      id: complaint.id,
      complaintType: complaint.complaint_type,
      status: complaint.status,
      priority: complaint.priority,
      createdAt: complaint.created_at,
    })),
  };
};

const getTrends = async (req) => {
  const dateRange = resolveDateRange(req.query, { defaultDays: 14, maxDays: 90 });
  const days = dateRange.days || 14;
  const start = dateRange.start || new Date();
  const end = dateRange.end || new Date();
  const timezone = getDefaultTimezone();

  const replacements = {
    start,
    end,
    displayTimezone: getDefaultTimezone(),
  };
  let tenantClause = '';
  let facilityClause = '';
  if (!req.user.isSuperAdmin) {
    replacements.tenantId = req.user.tenantId;
    tenantClause = 'AND i.tenant_id = :tenantId';
  } else if (req.query.tenantId) {
    replacements.tenantId = req.query.tenantId;
    tenantClause = 'AND i.tenant_id = :tenantId';
  }
  const scopedFacilityIds = uniqueIds(req.user?.scopeFacilityIds || []);
  if (!req.user.isSuperAdmin && scopedFacilityIds.length > 0) {
    replacements.scopeFacilityIds = scopedFacilityIds;
    facilityClause = 'AND i.facility_id IN (:scopeFacilityIds)';
  } else if (!req.user.isSuperAdmin && req.user?.scopeLevel === 'facility') {
    replacements.scopeFacilityIds = [EMPTY_SCOPE_UUID];
    facilityClause = 'AND i.facility_id IN (:scopeFacilityIds)';
  }

  const rows = await sequelize.query(
    `
      SELECT
        DATE(i.captured_at AT TIME ZONE :displayTimezone) AS label,
        COUNT(i.id)::int AS "inspectionCount",
        COALESCE(AVG(a.cleanliness_score), 0)::numeric AS "avgCleanliness"
      FROM inspections i
      LEFT JOIN ai_analysis_results a ON a.inspection_id = i.id
      LEFT JOIN toilet_units tu ON tu.id = i.toilet_unit_id
      WHERE i.captured_at >= :start
        AND i.captured_at < :end
        AND (i.toilet_unit_id IS NULL OR tu.deleted_at IS NULL)
        ${tenantClause}
        ${facilityClause}
      GROUP BY DATE(i.captured_at AT TIME ZONE :displayTimezone)
      ORDER BY DATE(i.captured_at AT TIME ZONE :displayTimezone) ASC
    `,
    {
      replacements,
      type: QueryTypes.SELECT,
    }
  );

  const map = new Map(rows.map((row) => [toIstDateKey(row.label) || String(row.label).slice(0, 10), row]));
  const points = [];
  for (let i = 0; i < days; i += 1) {
    const current = new Date(start.getTime() + i * 86_400_000);
    const date = toIstDateKey(current);
    const row = map.get(date);
    const avgCleanliness = row?.avgCleanliness;
    points.push({
      date,
      label: date,
      inspectionCount: Number(row?.inspectionCount || 0),
      cleanlinessAverage:
        avgCleanliness === null || avgCleanliness === undefined
          ? null
          : Number(toNumber(avgCleanliness, 0).toFixed(2)),
    });
  }
  return {
    requestedRange: {
      startDate: toIstDateKey(start),
      endDate: toIstDateKey(new Date(end.getTime() - 1)),
      timezone,
    },
    series: points,
  };
};

const getWorkforce = async (req) => {
  const todayStart = resolveDateRange({ range: 'today' }, { maxDays: 1 }).start || new Date();

  const lookbackRaw = Number(req.query.activityDays || 7);
  const activityLookbackDays = Number.isFinite(lookbackRaw)
    ? Math.min(Math.max(lookbackRaw, 1), 30)
    : 7;
  const activeThresholdMinutes = toBoundedNumber(
    req.query.activeThresholdMinutes,
    { fallback: 20, min: 5, max: 240 }
  );
  const idleThresholdMinutes = toBoundedNumber(
    req.query.idleThresholdMinutes,
    { fallback: 120, min: activeThresholdMinutes + 1, max: 720 }
  );
  const shiftStartHour = Math.trunc(
    toBoundedNumber(req.query.shiftStartHour, { fallback: 9, min: 0, max: 23 })
  );
  const minShiftHoursForEarlyExit = toBoundedNumber(
    req.query.minShiftHoursForEarlyExit,
    { fallback: 8, min: 1, max: 24 }
  );

  const requestedRange = resolveDateRange(req.query, { maxDays: 30 });
  const activityStart = requestedRange.start || new Date(todayStart);
  if (!requestedRange.start) {
    activityStart.setDate(activityStart.getDate() - (activityLookbackDays - 1));
  }
  const activityEnd = requestedRange.end || new Date();
  const taskActivityFilter = buildTimestampFilter({
    start: activityStart,
    end: activityEnd,
  });
  const scopedTaskWhere = {
    ...scopedFacilityWhere(req),
    [Op.or]: [
      { scheduled_at: taskActivityFilter },
      { started_at: taskActivityFilter },
      { completed_at: taskActivityFilter },
      { created_at: taskActivityFilter },
    ],
  };

  const assignmentScopeWhere = applyScopeToQuery(
    scopedTenantWhere(req, { status: 'active' }),
    buildAccessContextFromUser(req?.user || {}),
    'audit',
    {
      tenantKey: 'tenant_id',
      geographyKey: 'geography_id',
      facilityKey: 'facility_id',
    },
  );

  // These two scans are independent — run them together to save a round-trip to
  // the (remote) database instead of awaiting them one after another.
  const [scopedTaskRows, scopedAssignmentRows] = await Promise.all([
    InspectionTask.findAll({
      where: scopedTaskWhere,
      attributes: [
        'assigned_to_user_id',
        'facility_id',
        'toilet_unit_id',
        'status',
        'scheduled_at',
        'started_at',
        'completed_at',
        'created_at',
      ],
      raw: true,
    }),
    WorkerAssignment.findAll({
      where: assignmentScopeWhere,
      attributes: ['user_id', 'supervisor_user_id', 'geography_id', 'facility_id', 'toilet_unit_id'],
      raw: true,
    }),
  ]);

  const taskWorkerIds = uniqueIds(scopedTaskRows.map((row) => row.assigned_to_user_id));
  const assignmentWorkerIds = uniqueIds(scopedAssignmentRows.map((row) => row.user_id));
  const candidateWorkerIds = uniqueIds([...taskWorkerIds, ...assignmentWorkerIds]);
  if (candidateWorkerIds.length === 0) return [];

  const fieldWorkerRole = await Role.findOne({
    where: { code: ROLE_CODES.FIELD_WORKER },
    attributes: ['id'],
    raw: true,
  });
  if (!fieldWorkerRole?.id) return [];

  const fieldWorkerRoleRows = await UserRole.findAll({
    where: {
      ...scopedTenantWhere(req, { role_id: fieldWorkerRole.id }, 'tenant_id'),
      user_id: { [Op.in]: candidateWorkerIds },
    },
    attributes: ['user_id'],
    raw: true,
  });
  const scopedWorkerIds = uniqueIds(fieldWorkerRoleRows.map((row) => row.user_id));
  if (scopedWorkerIds.length === 0) return [];

  const workerRows = await PlatformUser.findAll({
    where: {
      id: { [Op.in]: scopedWorkerIds },
      status: 'active',
    },
    attributes: ['id', 'full_name', 'employee_code', 'metadata', 'updated_at'],
    raw: true,
  });
  if (workerRows.length === 0) return [];

  const activeWorkerIds = uniqueIds(workerRows.map((row) => row.id));
  const activeWorkerIdSet = new Set(activeWorkerIds.map((id) => String(id)));

  const assignmentRows = scopedAssignmentRows.filter((row) =>
    activeWorkerIdSet.has(String(row.user_id || ''))
  );
  const taskRows = scopedTaskRows.filter((row) =>
    activeWorkerIdSet.has(String(row.assigned_to_user_id || ''))
  );

  const assignmentToiletUnitIds = uniqueIds(assignmentRows.map((row) => row.toilet_unit_id));
  const assignmentToiletUnitRows =
    assignmentToiletUnitIds.length > 0
      ? await ToiletUnit.findAll({
          where: { id: { [Op.in]: assignmentToiletUnitIds } },
          attributes: ['id', 'facility_id', 'location_label'],
          raw: true,
        })
      : [];
  const assignmentToiletUnitById = new Map(
    assignmentToiletUnitRows.map((row) => [String(row.id), row])
  );
  const assignmentSupervisorIds = uniqueIds(
    assignmentRows.map((row) => row.supervisor_user_id)
  );
  const assignmentSupervisorRows =
    assignmentSupervisorIds.length > 0
      ? await PlatformUser.findAll({
          where: { id: { [Op.in]: assignmentSupervisorIds } },
          attributes: ['id', 'full_name', 'employee_code'],
          raw: true,
        })
      : [];
  const assignmentSupervisorById = new Map(
    assignmentSupervisorRows.map((row) => [String(row.id), row])
  );

  const isSupervisorActor = (Array.isArray(req.user?.roleCodes) ? req.user.roleCodes : []).includes(
    ROLE_CODES.SUPERVISOR
  );

  const workforceByWorkerId = new Map();
  for (const worker of workerRows) {
    const workerId = String(worker.id);
    workforceByWorkerId.set(workerId, {
      workerId,
      workerName: worker.full_name || `Worker-${workerId.slice(0, 6).toUpperCase()}`,
      employeeCode: worker.employee_code || null,
      phoneBatteryPct: toNumber(
        worker?.metadata?.phoneBatteryPct ??
          worker?.metadata?.batteryPct ??
          worker?.metadata?.deviceBatteryPct,
        null
      ),
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      averageCompletionAccumulator: 0,
      checkInLogs: [],
      checkOutLogs: [],
      locationTrail: [],
      facilityIds: new Set(),
      lastSeenAt: toIsoOrNull(worker.updated_at),
      latestLocationPoint: null,
      firstInspectionTodayAt: null,
      assignedToSupervisor: Boolean(isSupervisorActor),
      supervisorId: isSupervisorActor ? req.user.id : null,
      supervisorIds: new Set(),
      supervisorNames: new Set(),
    });
  }

  for (const assignment of assignmentRows) {
    const workerId = String(assignment.user_id || '');
    const row = workforceByWorkerId.get(workerId);
    if (!row) continue;
    if (assignment.supervisor_user_id) {
      const supervisorId = String(assignment.supervisor_user_id);
      const supervisor = assignmentSupervisorById.get(supervisorId);
      row.supervisorIds.add(supervisorId);
      if (supervisor?.full_name || supervisor?.employee_code) {
        row.supervisorNames.add(
          supervisor.full_name || supervisor.employee_code
        );
      }
    }
    if (assignment.facility_id) {
      row.facilityIds.add(String(assignment.facility_id));
    } else if (assignment.toilet_unit_id) {
      const toiletUnit = assignmentToiletUnitById.get(String(assignment.toilet_unit_id));
      if (toiletUnit?.facility_id) {
        row.facilityIds.add(String(toiletUnit.facility_id));
      }
    }
  }

  for (const task of taskRows) {
    const workerId = String(task.assigned_to_user_id || '');
    const row = workforceByWorkerId.get(workerId);
    if (!row) continue;

    row.totalTasks += 1;
    if (task.status === 'completed') {
      row.completedTasks += 1;
      const completedAtTs = toTimestamp(task.completed_at);
      const createdAtTs = toTimestamp(task.created_at);
      if (completedAtTs != null && createdAtTs != null) {
        row.averageCompletionAccumulator += Math.max(0, (completedAtTs - createdAtTs) / 60000);
      }
    } else if (task.status === 'in_progress') {
      row.inProgressTasks += 1;
    }

    if (task.facility_id) {
      row.facilityIds.add(String(task.facility_id));
    }

    const startedAt = toIsoOrNull(task.started_at);
    if (startedAt && isOnOrAfter(startedAt, todayStart)) {
      row.checkInLogs.push({
        at: startedAt,
        source: 'task_start',
        facilityId: task.facility_id || null,
        toiletUnitId: task.toilet_unit_id || null,
      });
    }

    const completedAt = toIsoOrNull(task.completed_at);
    if (completedAt && isOnOrAfter(completedAt, todayStart)) {
      row.checkOutLogs.push({
        at: completedAt,
        source: 'task_complete',
        facilityId: task.facility_id || null,
        toiletUnitId: task.toilet_unit_id || null,
      });
    }

    const activityAt =
      completedAt ||
      startedAt ||
      toIsoOrNull(task.created_at) ||
      toIsoOrNull(task.scheduled_at) ||
      null;
    row.lastSeenAt = pickLaterIso(row.lastSeenAt, activityAt);
  }

  const inspectionRows = await Inspection.findAll({
    where: scopedFacilityWhere(req, {
      inspector_user_id: { [Op.in]: activeWorkerIds },
      captured_at: { [Op.gte]: activityStart },
    }),
    attributes: [
      'id',
      'inspector_user_id',
      'facility_id',
      'toilet_unit_id',
      'latitude',
      'longitude',
      'captured_at',
      'submitted_at',
      'created_at',
    ],
    include: [
      {
        model: Facility,
        attributes: ['id', 'name', 'address_line'],
      },
      {
        model: ToiletUnit,
        attributes: ['id', 'code', 'location_label'],
      },
    ],
    order: [['captured_at', 'DESC']],
  });

  for (const inspection of inspectionRows) {
    const workerId = String(inspection.inspector_user_id || '');
    const row = workforceByWorkerId.get(workerId);
    if (!row) continue;

    const eventAt = toIsoOrNull(
      inspection.submitted_at || inspection.captured_at || inspection.created_at
    );
    if (!eventAt) continue;

    const lat = toNumber(inspection.latitude, null);
    const lng = toNumber(inspection.longitude, null);
    const locationLabel =
      inspection.ToiletUnit?.location_label ||
      inspection.Facility?.name ||
      inspection.Facility?.address_line ||
      null;

    const point = {
      at: eventAt,
      source: 'inspection',
      inspectionId: inspection.id,
      facilityId: inspection.facility_id || null,
      facilityName: inspection.Facility?.name || null,
      toiletUnitId: inspection.toilet_unit_id || null,
      toiletUnitCode: inspection.ToiletUnit?.code || null,
      locationLabel,
      gpsLat: lat,
      gpsLng: lng,
    };

    if (
      !row.latestLocationPoint ||
      toTimestamp(point.at) > toTimestamp(row.latestLocationPoint.at)
    ) {
      row.latestLocationPoint = point;
    }

    if (inspection.facility_id) {
      row.facilityIds.add(String(inspection.facility_id));
    }

    row.lastSeenAt = pickLaterIso(row.lastSeenAt, point.at);

    if (isOnOrAfter(point.at, todayStart)) {
      row.locationTrail.push(point);
      row.firstInspectionTodayAt = pickEarlierIso(row.firstInspectionTodayAt, point.at);
    }
  }

  for (const row of workforceByWorkerId.values()) {
    if (row.checkInLogs.length === 0 && row.firstInspectionTodayAt) {
      row.checkInLogs.push({
        at: row.firstInspectionTodayAt,
        source: 'inspection_capture',
        facilityId: row.latestLocationPoint?.facilityId || null,
        toiletUnitId: row.latestLocationPoint?.toiletUnitId || null,
        locationLabel: row.latestLocationPoint?.locationLabel || null,
        gpsLat: row.latestLocationPoint?.gpsLat ?? null,
        gpsLng: row.latestLocationPoint?.gpsLng ?? null,
      });
    }
  }

  const allFacilityIds = uniqueIds(
    [...workforceByWorkerId.values()].flatMap((row) => [...row.facilityIds.values()])
  );

  const facilityRows =
    allFacilityIds.length > 0
      ? await Facility.findAll({
          where: { id: { [Op.in]: allFacilityIds } },
          attributes: ['id', 'name', 'address_line', 'ward_geography_id'],
          raw: true,
        })
      : [];
  const facilityById = new Map(facilityRows.map((row) => [String(row.id), row]));
  const wardGeographyIds = uniqueIds(
    facilityRows.map((row) => row.ward_geography_id)
  );
  const wardRows =
    wardGeographyIds.length > 0
      ? await Geography.findAll({
          where: { id: { [Op.in]: wardGeographyIds } },
          attributes: ['id', 'name'],
          raw: true,
        })
      : [];
  const wardById = new Map(wardRows.map((row) => [String(row.id), row]));

  const sensorRows =
    allFacilityIds.length > 0
      ? await SensorDevice.findAll({
          where: scopedFacilityWhere(req, {
            facility_id: { [Op.in]: allFacilityIds },
          }),
          attributes: ['facility_id', 'status'],
          raw: true,
        })
      : [];

  const sensorByFacilityId = new Map();
  for (const sensor of sensorRows) {
    const facilityId = String(sensor.facility_id || '');
    if (!facilityId) continue;
    const bucket = sensorByFacilityId.get(facilityId) || { total: 0, online: 0, offline: 0 };
    bucket.total += 1;
    if (sensor.status === 'active') {
      bucket.online += 1;
    } else {
      bucket.offline += 1;
    }
    sensorByFacilityId.set(facilityId, bucket);
  }

  const results = [];
  const nowIso = new Date().toISOString();

  for (const row of workforceByWorkerId.values()) {
    const checkInLogs = row.checkInLogs
      .filter((entry) => Boolean(entry?.at))
      .sort((left, right) => toTimestamp(left.at) - toTimestamp(right.at));
    const checkOutLogs = row.checkOutLogs
      .filter((entry) => Boolean(entry?.at))
      .sort((left, right) => toTimestamp(left.at) - toTimestamp(right.at));
    const locationTrail = row.locationTrail
      .filter((entry) => Boolean(entry?.at))
      .sort((left, right) => toTimestamp(right.at) - toTimestamp(left.at))
      .slice(0, 25);

    const checkInAt = checkInLogs[0]?.at || null;
    const checkOutAt = checkOutLogs[checkOutLogs.length - 1]?.at || null;

    let attendanceStatus = 'Absent';
    if (checkOutAt) {
      attendanceStatus = 'Checked out';
    } else if (checkInAt || row.inProgressTasks > 0 || locationTrail.length > 0) {
      attendanceStatus = 'Present';
    }

    const shiftStartTs = toTimestamp(checkInAt);
    const shiftEndTs = toTimestamp(checkOutAt || nowIso);
    const workingMinutes =
      shiftStartTs != null && shiftEndTs != null
        ? Math.max(0, Math.round((shiftEndTs - shiftStartTs) / 60000))
        : 0;

    const workerFacilityIds = [...row.facilityIds.values()];
    const sensorTotals = workerFacilityIds.reduce(
      (acc, facilityId) => {
        const current = sensorByFacilityId.get(String(facilityId));
        if (!current) return acc;
        acc.total += current.total;
        acc.online += current.online;
        acc.offline += current.offline;
        return acc;
      },
      { total: 0, online: 0, offline: 0 }
    );

    const fallbackFacility = facilityById.get(String(workerFacilityIds[0] || '')) || null;
    const locationLabel =
      row.latestLocationPoint?.locationLabel ||
      fallbackFacility?.name ||
      fallbackFacility?.address_line ||
      null;
    const assignedWardNames = uniqueIds(
      workerFacilityIds
        .map((facilityId) => {
          const wardId = facilityById.get(String(facilityId || ''))?.ward_geography_id;
          if (!wardId) return null;
          return wardById.get(String(wardId || ''))?.name || null;
        })
        .filter(Boolean)
    );
    const assignedWard = assignedWardNames.length > 0 ? assignedWardNames.join(', ') : null;
    const recentActivityAt = row.lastSeenAt || checkOutAt || checkInAt || null;
    const liveStatus = resolveWorkforceStatus({
      attendanceStatus,
      activityAt: recentActivityAt,
      activeThresholdMinutes,
      idleThresholdMinutes,
    });
    const checkInTsForShift = toTimestamp(checkInAt);
    const shiftStartBoundary = checkInTsForShift != null ? new Date(checkInTsForShift) : null;
    if (shiftStartBoundary) {
      shiftStartBoundary.setHours(shiftStartHour, 0, 0, 0);
    }
    const lateArrival = Boolean(
      checkInTsForShift != null &&
        shiftStartBoundary &&
        checkInTsForShift > shiftStartBoundary.getTime()
    );
    const earlyExit = Boolean(
      checkOutAt &&
        Number.isFinite(workingMinutes) &&
        (workingMinutes / 60) < minShiftHoursForEarlyExit
    );

    results.push({
      workerId: row.workerId,
      workerName: row.workerName,
      employeeCode: row.employeeCode,
      attendanceStatus,
      liveStatus,
      checkInAt,
      checkOutAt,
      checkInLogs: checkInLogs.slice(0, 25),
      checkOutLogs: checkOutLogs.slice(0, 25),
      totalTasks: row.totalTasks,
      completedTasks: row.completedTasks,
      inProgressTasks: row.inProgressTasks,
      averageCompletionMinutes:
        row.completedTasks > 0
          ? Number((row.averageCompletionAccumulator / row.completedTasks).toFixed(2))
          : 0,
      workingMinutes,
      workingHours: Number((workingMinutes / 60).toFixed(2)),
      phoneBatteryPct: row.phoneBatteryPct,
      sensorTotal: workerFacilityIds.length > 0 ? sensorTotals.total : null,
      sensorOnline: workerFacilityIds.length > 0 ? sensorTotals.online : null,
      sensorOffline: workerFacilityIds.length > 0 ? sensorTotals.offline : null,
      gpsLat: row.latestLocationPoint?.gpsLat ?? null,
      gpsLng: row.latestLocationPoint?.gpsLng ?? null,
      locationLabel,
      locationTrail,
      movementTrail: locationTrail,
      recentActivityAt,
      lastSeenAt: recentActivityAt,
      lateArrival,
      earlyExit,
      assignedWard,
      assignedToSupervisor: row.assignedToSupervisor,
      supervisorId: row.supervisorId || [...row.supervisorIds.values()][0] || null,
      assignedSupervisorIds: [...row.supervisorIds.values()],
      assignedSupervisorName:
        [...row.supervisorNames.values()].join(', ') ||
        (row.supervisorId === req.user?.id ? req.user?.fullName || null : null),
      facilityIds: workerFacilityIds,
      facilityCount: workerFacilityIds.length,
      currentLocation: row.latestLocationPoint || null,
    });
  }

  return results.sort((left, right) =>
    String(left.workerName || left.workerId || '').localeCompare(
      String(right.workerName || right.workerId || '')
    )
  );
};

const getSla = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const tasks = await InspectionTask.findAll({
    where: dateRange.provided
      ? applyDateRangeToWhere(scopedFacilityWhere(req), 'scheduled_at', dateRange)
      : scopedFacilityWhere(req),
    order: [['scheduled_at', 'DESC']],
    limit: 500,
  });

  const now = Date.now();
  let breached = 0;
  let onTrack = 0;
  const breachedList = [];
  for (const task of tasks) {
    if (!task.sla_minutes) continue;
    const dueAt = new Date(task.scheduled_at).getTime() + task.sla_minutes * 60000;
    const isBreached = task.status !== 'completed' && now > dueAt;
    if (isBreached) {
      breached += 1;
      breachedList.push({
        taskId: task.id,
        scheduledAt: task.scheduled_at,
        slaMinutes: task.sla_minutes,
        status: task.status,
      });
    } else {
      onTrack += 1;
    }
  }

  return {
    breached,
    onTrack,
    totalTracked: breached + onTrack,
    breachedList: breachedList.slice(0, 100),
  };
};

const getStorageUsage = async (req) => {
  if (String(req.query.live || 'true').toLowerCase() !== 'false') {
    return storageUsageService.getTenantStorageUsageForRequest(req);
  }

  const rows = await StorageUsageMetric.findAll({
    where: scopedTenantWhere(req),
    order: [['measured_at', 'DESC']],
    limit: Number(req.query.limit || 30),
  });
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    bucketName: row.bucket_name,
    usedBytes: Number(row.used_bytes),
    objectCount: Number(row.object_count),
    measuredAt: row.measured_at,
  }));
};

const getPlatformHealth = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const latestAggregate = await DashboardAggregate.findOne({
    where: scopedTenantWhere(req),
    order: [['aggregate_date', 'DESC']],
  });

  const [alerts, sensorsFaulty] = await Promise.all([
    Alert.count({
      where: {
        ...(dateRange.provided
          ? applyDateRangeToWhere(scopedFacilityWhere(req), 'created_at', dateRange)
          : scopedFacilityWhere(req)),
        status: 'open',
      },
    }),
    SensorDevice.count({
      where: {
        ...scopedFacilityWhere(req),
        status: 'faulty',
      },
    }),
  ]);

  return {
    openAlerts: alerts,
    faultySensors: sensorsFaulty,
    latestAggregateDate: latestAggregate?.aggregate_date || null,
    latestAggregateMetrics: latestAggregate?.metrics || null,
  };
};

const getContractorPerformance = async (req) => {
  // Contractor mapping is not a first-class table yet; derive from facility metadata.
  const facilities = await Facility.findAll({
    where: scopedFacilityEntityWhere(req),
    attributes: ['id', 'metadata'],
  });
  const byContractor = {};
  facilities.forEach((facility) => {
    const contractor = facility.metadata?.contractor || 'Unknown Contractor';
    byContractor[contractor] = byContractor[contractor] || { contractor, facilities: 0 };
    byContractor[contractor].facilities += 1;
  });
  return Object.values(byContractor);
};

module.exports = {
  getOverview,
  getOverviewMapScope,
  getMap,
  getHeatmap,
  getFacilityDashboard,
  getTrends,
  getWorkforce,
  getSla,
  getStorageUsage,
  getPlatformHealth,
  getContractorPerformance,
  __private: {
    hasGeographyRestriction,
    isPointInsideOverviewScope,
    isFacilityVisibleOnOverviewMap,
    resolveToiletMarkerCoordinates,
  },
};
