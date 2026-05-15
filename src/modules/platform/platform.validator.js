const { isBlank } = require('../../utils/validators');
const isLikelyEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(value || '').trim());
const allowedScopeLevels = new Set(['country', 'state', 'district', 'city', 'zone']);
const allowedGeographyLevels = new Set(['country', 'state', 'district', 'city', 'zone', 'ward', 'cluster']);
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
  const scopeLevel = String(req.body.scopeLevel || 'city').trim().toLowerCase();
  const requiredFields = scopeRequiredFields[scopeLevel] || [];
  requiredFields.forEach((field) => {
    if (isBlank(req.body[field])) {
      errors.push(`${field} is required for ${scopeLevel} scope`);
    }
  });
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
  if (isBlank(req.body.tenantId) && !req.user?.tenantId) {
    errors.push('tenantId is required');
  }
  if (req.body.geometryType !== undefined) {
    const geometryType = String(req.body.geometryType || '').trim().toLowerCase();
    if (geometryType && !['polygon', 'circle'].includes(geometryType)) {
      errors.push('geometryType must be polygon or circle');
    }
  }
  return errors;
};

const validateFacilityCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.code)) errors.push('code is required');
  if (isBlank(req.body.name)) errors.push('name is required');
  if (isBlank(req.body.facilityType)) errors.push('facilityType is required');
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
  validateBlockCreate,
  validateUnitCreate,
  validateUnitBulkCreate,
  validateQrResolve,
};
