const { isBlank } = require('../../utils/validators');

const validateTenantCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.name)) errors.push('name is required');
  if (isBlank(req.body.code)) errors.push('code is required');
  return errors;
};

const validateGeographyCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.level)) errors.push('level is required');
  if (isBlank(req.body.code)) errors.push('code is required');
  if (isBlank(req.body.name)) errors.push('name is required');
  if (isBlank(req.body.tenantId) && !req.user?.tenantId) {
    errors.push('tenantId is required');
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

module.exports = {
  validateTenantCreate,
  validateGeographyCreate,
  validateFacilityCreate,
  validateBlockCreate,
  validateUnitCreate,
};
