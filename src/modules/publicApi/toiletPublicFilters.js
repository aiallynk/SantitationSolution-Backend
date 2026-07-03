const { Op } = require('sequelize');

const { runtimeConfig } = require('../../config/runtime');
const { normalizeList } = require('./publicApiAuth.middleware');

const DEFAULT_ENDPOINT_PERMISSION = 'toilets:nearby:read';
const INCLUDE_CLOSED_PERMISSION = 'toilets:include_closed';

const OPEN_STATUS_VALUES = new Set([
  'active',
  'clean',
  'moderate',
  'open',
  'operational',
  'poor',
]);

const CLOSED_STATUS_VALUES = new Set([
  'archived',
  'closed',
  'deleted',
  'draft',
  'inactive',
  'maintenance',
  'out_of_service',
]);

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeStatusValue = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const isValidCoordinatePair = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

const readValue = (row, key) => {
  if (!row) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  if (typeof row.getDataValue === 'function') return row.getDataValue(key);
  if (typeof row.get === 'function') return row.get(key);
  return undefined;
};

const getMetadata = (row) => {
  const metadata = readValue(row, 'metadata');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata;
};

const getGeoJsonCoordinates = (row) => {
  const metadata = getMetadata(row);
  const location =
    readValue(row, 'location') ||
    metadata.location ||
    metadata.geojson ||
    metadata.geoJson ||
    null;
  const coordinates = Array.isArray(location?.coordinates) ? location.coordinates : null;
  if (!coordinates || coordinates.length < 2) return null;
  return coordinates;
};

const normalizePair = ({ lat, lng, source }) => {
  if (lat === null || lng === null) {
    return { lat: null, lng: null, source: source || null, valid: false, reason: 'MISSING_COORDINATES' };
  }
  if (!isValidCoordinatePair(lat, lng)) {
    return { lat, lng, source: source || null, valid: false, reason: 'INVALID_COORDINATES' };
  }
  return { lat, lng, source, valid: true, reason: null };
};

const normalizeToiletCoordinates = (toilet) => {
  const facility = toilet?.Facility || toilet?.facility || null;
  const unitLat = readValue(toilet, 'latitude');
  const unitLng = readValue(toilet, 'longitude');
  const parsedUnitLat = toNumberOrNull(unitLat);
  const parsedUnitLng = toNumberOrNull(unitLng);
  if (parsedUnitLat !== null || parsedUnitLng !== null) {
    const source = typeof unitLat === 'string' || typeof unitLng === 'string' ? 'parsed_string' : 'lat_lng_columns';
    return normalizePair({ lat: parsedUnitLat, lng: parsedUnitLng, source });
  }

  const facilityLat = readValue(facility, 'latitude');
  const facilityLng = readValue(facility, 'longitude');
  const parsedFacilityLat = toNumberOrNull(facilityLat);
  const parsedFacilityLng = toNumberOrNull(facilityLng);
  if (parsedFacilityLat !== null || parsedFacilityLng !== null) {
    const source = typeof facilityLat === 'string' || typeof facilityLng === 'string' ? 'parsed_string' : 'lat_lng_columns';
    return normalizePair({ lat: parsedFacilityLat, lng: parsedFacilityLng, source });
  }

  const coordinates = getGeoJsonCoordinates(toilet) || getGeoJsonCoordinates(facility);
  if (coordinates) {
    const lng = toNumberOrNull(coordinates[0]);
    const lat = toNumberOrNull(coordinates[1]);
    return normalizePair({ lat, lng, source: 'geojson' });
  }

  if (typeof unitLat === 'string' || typeof unitLng === 'string' || typeof facilityLat === 'string' || typeof facilityLng === 'string') {
    return normalizePair({
      lat: parsedUnitLat ?? parsedFacilityLat,
      lng: parsedUnitLng ?? parsedFacilityLng,
      source: 'parsed_string',
    });
  }

  return { lat: null, lng: null, source: null, valid: false, reason: 'MISSING_COORDINATES' };
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

const isTenantSharingEnabled = (tenant) =>
  toBoolean(
    tenant?.external_api_sharing_enabled ??
      tenant?.public_api_sharing_enabled ??
      getMetadata(tenant).externalApiSharingEnabled ??
      getMetadata(tenant).external_api_sharing_enabled ??
      getMetadata(tenant).publicApiSharingEnabled ??
      getMetadata(tenant).public_api_sharing_enabled,
    false
  );

const getApiScopeTenantIds = ({ apiKey, project }) => {
  const keyTenantIds = normalizeList(apiKey?.allowed_tenant_ids);
  const projectTenantIds = normalizeList(project?.allowed_tenant_ids);
  return keyTenantIds.length > 0 ? keyTenantIds : projectTenantIds;
};

const normalizeOperationalStatus = (unit) => {
  const unitStatus = normalizeStatusValue(unit?.status);
  const facilityStatus = normalizeStatusValue(unit?.Facility?.status || unit?.facility?.status);
  const blockStatus = normalizeStatusValue(unit?.ToiletBlock?.status || unit?.toiletBlock?.status);

  if (unit?.deleted_at || unit?.deletedAt) return 'Deleted';
  if (CLOSED_STATUS_VALUES.has(unitStatus) || CLOSED_STATUS_VALUES.has(facilityStatus) || CLOSED_STATUS_VALUES.has(blockStatus)) {
    return unitStatus === 'maintenance' || facilityStatus === 'maintenance' || blockStatus === 'maintenance'
      ? 'Maintenance'
      : 'Closed';
  }
  if (OPEN_STATUS_VALUES.has(unitStatus) || OPEN_STATUS_VALUES.has(facilityStatus) || OPEN_STATUS_VALUES.has(blockStatus)) {
    return 'Open';
  }
  return unitStatus || facilityStatus || blockStatus ? 'Open' : 'Status Unknown';
};

const isPublicOperational = (unit) => normalizeOperationalStatus(unit) === 'Open';

const includeUnknownCleanlinessWhenMinZero = () =>
  toBoolean(runtimeConfig.publicApi?.includeUnknownCleanlinessWhenMinZero, true);

const shouldIncludeForCleanliness = ({ cleanlinessScore, cleanlinessMin }) => {
  if (cleanlinessMin === null || cleanlinessMin === undefined) return true;
  if (cleanlinessScore !== null && cleanlinessScore !== undefined) {
    return Number(cleanlinessScore) >= cleanlinessMin;
  }
  return Number(cleanlinessMin) === 0 && includeUnknownCleanlinessWhenMinZero();
};

const publicUnitWhere = ({ includeClosed = false } = {}) => ({
  is_public_visible: true,
  deleted_at: null,
  ...(includeClosed ? {} : { status: { [Op.notIn]: ['out_of_service'] } }),
});

module.exports = {
  DEFAULT_ENDPOINT_PERMISSION,
  INCLUDE_CLOSED_PERMISSION,
  CLOSED_STATUS_VALUES,
  OPEN_STATUS_VALUES,
  getApiScopeTenantIds,
  haversineMeters,
  isPublicOperational,
  isTenantSharingEnabled,
  normalizeOperationalStatus,
  normalizeStatusValue,
  normalizeToiletCoordinates,
  publicUnitWhere,
  shouldIncludeForCleanliness,
  toBoolean,
  toNumberOrNull,
};
