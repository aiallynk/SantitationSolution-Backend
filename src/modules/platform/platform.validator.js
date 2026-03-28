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
  return errors;
};

module.exports = {
  validateTenantCreate,
  validateGeographyCreate,
  validateFacilityCreate,
  validateBlockCreate,
  validateUnitCreate,
};
