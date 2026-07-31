const { isBlank } = require('../../utils/validators');
const isLikelyEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(value || '').trim());
const isValidTimezone = (value) => {
  const timezone = String(value || '').trim();
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
};
const allowedScopeLevels = new Set(['country', 'state', 'district', 'city', 'zone']);
const allowedGeographyLevels = new Set(['country', 'state', 'district', 'city', 'zone', 'ward', 'cluster']);
const mapRequiredGeographyLevels = new Set(['country', 'state', 'district', 'city']);
const scopeRequiredFields = {
  country: ['countryName'],
  state: ['countryName', 'stateName'],
  district: ['countryName', 'stateName', 'districtName'],
  city: ['countryName', 'stateName', 'cityName'],
  zone: ['countryName', 'stateName', 'cityName', 'zoneName'],
};

const validateTenantCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.name)) errors.push('name is required');
  if (req.body.code !== undefined && isBlank(req.body.code)) errors.push('code cannot be blank when provided');
  if (req.body.contactEmail !== undefined && !isBlank(req.body.contactEmail) && !isLikelyEmail(req.body.contactEmail)) {
    errors.push('contactEmail must be a valid email');
  }
  if (req.body.scopeLevel !== undefined && !allowedScopeLevels.has(String(req.body.scopeLevel).trim().toLowerCase())) {
    errors.push('scopeLevel must be one of country|state|district|city|zone');
  }
  if (req.body.timezone !== undefined && !isValidTimezone(req.body.timezone)) {
    errors.push('timezone must be a valid IANA timezone');
  }
  const scopeLevel = String(req.body.scopeLevel || 'city').trim().toLowerCase();
  const requiredFields = req.body.rootGeographyId ? [] : scopeRequiredFields[scopeLevel] || [];
  requiredFields.forEach((field) => {
    if (isBlank(req.body[field])) {
      errors.push(`${field} is required for ${scopeLevel} scope`);
    }
  });
  if (['country', 'state', 'district', 'city'].includes(scopeLevel) && !req.body.rootGeographyId) {
    errors.push(`rootGeographyId is required for ${scopeLevel} scope`);
  }
  return errors;
};

const validateGeographyCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.level)) errors.push('level is required');
  if (!isBlank(req.body.level) && !allowedGeographyLevels.has(String(req.body.level).trim().toLowerCase())) {
    errors.push('level is invalid');
  }
  if (req.body.code !== undefined && isBlank(req.body.code)) errors.push('code cannot be blank when provided');
  if (isBlank(req.body.name)) errors.push('name is required');
  const level = String(req.body.level || '').trim().toLowerCase();
  if (!mapRequiredGeographyLevels.has(level) && isBlank(req.body.tenantId) && !req.user?.tenantId) {
    errors.push('tenantId is required');
  }
  if (req.body.geometryType !== undefined) {
    const geometryType = String(req.body.geometryType || '').trim().toLowerCase();
    if (geometryType && !['polygon', 'circle'].includes(geometryType)) {
      errors.push('geometryType must be polygon or circle');
    }
  }
  if (req.body.centroidLatitude !== undefined && Number.isNaN(Number(req.body.centroidLatitude))) {
    errors.push('centroidLatitude must be a valid number');
  }
  if (req.body.centroidLongitude !== undefined && Number.isNaN(Number(req.body.centroidLongitude))) {
    errors.push('centroidLongitude must be a valid number');
  }
  if (mapRequiredGeographyLevels.has(level)) {
    const hasLat = req.body.centroidLatitude !== undefined && req.body.centroidLatitude !== '';
    const hasLng = req.body.centroidLongitude !== undefined && req.body.centroidLongitude !== '';
    const hasPlaceId = !isBlank(req.body.mapPlaceId || req.body.placeId);
    const bounds = req.body.bounds;
    const hasBounds =
      bounds &&
      typeof bounds === 'object' &&
      bounds.north !== undefined &&
      bounds.south !== undefined &&
      bounds.east !== undefined &&
      bounds.west !== undefined;
    if (!hasLat || !hasLng || !hasPlaceId || !hasBounds) {
      errors.push(`${level} must use a Google Maps selection with valid coordinates and bounds`);
    }
  }
  return errors;
};

const validateFacilityCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.name)) errors.push('name is required');
  if (isBlank(req.body.facilityType)) errors.push('facilityType is required');
  if (isBlank(req.body.areaId || req.body.geographyId || req.body.zoneGeographyId || req.body.wardGeographyId)) {
    errors.push('areaId is required');
  }
  const hasLat = req.body.latitude !== undefined && req.body.latitude !== '';
  const hasLng = req.body.longitude !== undefined && req.body.longitude !== '';
  if (hasLat !== hasLng) {
    errors.push('latitude and longitude must be provided together');
  }
  if (hasLat && Number.isNaN(Number(req.body.latitude))) {
    errors.push('latitude must be a valid number');
  }
  if (hasLng && Number.isNaN(Number(req.body.longitude))) {
    errors.push('longitude must be a valid number');
  }
  if (req.body.timezone !== undefined && !isBlank(req.body.timezone) && !isValidTimezone(req.body.timezone)) {
    errors.push('timezone must be a valid IANA timezone');
  }
  if (req.body.contactEmail !== undefined && !isBlank(req.body.contactEmail) && !isLikelyEmail(req.body.contactEmail)) {
    errors.push('contactEmail must be a valid email');
  }
  if (req.body.caretakerEmail !== undefined && !isBlank(req.body.caretakerEmail) && !isLikelyEmail(req.body.caretakerEmail)) {
    errors.push('caretakerEmail must be a valid email');
  }
  return errors;
};

const validateFacilityQrResolve = (req) => {
  const errors = [];
  const token = req.body?.token || req.body?.rawQrValue || req.query?.t;
  if (isBlank(token)) errors.push('QR token is required');
  return errors;
};

const validateBlockCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.facilityId)) errors.push('facilityId is required');
  if (isBlank(req.body.code)) errors.push('code is required');
  if (isBlank(req.body.name)) errors.push('name is required');
  return errors;
};

const validateUnitCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.facilityId)) errors.push('facilityId is required');
  if (isBlank(req.body.toiletBlockId)) errors.push('toiletBlockId is required');
  if (isBlank(req.body.unitType)) errors.push('unitType is required');
  if (req.body.latitude === undefined || req.body.longitude === undefined) {
    errors.push('latitude and longitude are required');
  }
  if (req.body.latitude !== undefined && Number.isNaN(Number(req.body.latitude))) {
    errors.push('latitude must be a valid number');
  }
  if (req.body.longitude !== undefined && Number.isNaN(Number(req.body.longitude))) {
    errors.push('longitude must be a valid number');
  }
  if (req.body.sectorCode && String(req.body.sectorCode).length > 40) {
    errors.push('sectorCode must be 40 characters or fewer');
  }
  if (req.body.locationLabel && String(req.body.locationLabel).length > 300) {
    errors.push('locationLabel must be 300 characters or fewer');
  }
  if (req.body.timezone !== undefined && !isBlank(req.body.timezone) && !isValidTimezone(req.body.timezone)) {
    errors.push('timezone must be a valid IANA timezone');
  }
  return errors;
};

const validateUnitBulkCreate = (req) => {
  const errors = validateUnitCreate(req);
  const quantity = Number(req.body.quantity);
  if (!Number.isInteger(quantity) || quantity < 2 || quantity > 200) {
    errors.push('quantity must be an integer between 2 and 200');
  }
  if (!isBlank(req.body.code)) {
    errors.push('code is not allowed for bulk create');
  }
  if (!isBlank(req.body.permanentQrCode) || !isBlank(req.body.qrCode)) {
    errors.push('permanentQrCode/qrCode is not allowed for bulk create');
  }
  return errors;
};

const validateQrResolve = (req) => {
  const errors = [];
  const value = req.body?.rawQrValue;
  if (isBlank(value)) {
    errors.push('rawQrValue is required');
  }
  if (value != null && typeof value !== 'string') {
    errors.push('rawQrValue must be a string');
  }
  if (req.body?.normalizedQrValue != null && typeof req.body.normalizedQrValue !== 'string') {
    errors.push('normalizedQrValue must be a string when provided');
  }
  if (req.body?.workerId != null && typeof req.body.workerId !== 'string') {
    errors.push('workerId must be a string when provided');
  }
  if (req.body?.tenantId != null && typeof req.body.tenantId !== 'string') {
    errors.push('tenantId must be a string when provided');
  }
  if (req.body?.siteId != null && typeof req.body.siteId !== 'string') {
    errors.push('siteId must be a string when provided');
  }
  if (req.body?.scannedAt != null && Number.isNaN(Date.parse(String(req.body.scannedAt)))) {
    errors.push('scannedAt must be an ISO datetime when provided');
  }
  return errors;
};

module.exports = {
  validateTenantCreate,
  validateGeographyCreate,
  validateFacilityCreate,
  validateFacilityQrResolve,
  validateBlockCreate,
  validateUnitCreate,
  validateUnitBulkCreate,
  validateQrResolve,
};
