const { Op } = require('sequelize');

const EMPTY_SCOPE_UUID = '00000000-0000-0000-0000-000000000000';

const uniqueIds = (values = []) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];

const applyTenantScope = (where = {}, req, tenantKey = 'tenant_id') => {
  const next = { ...where };
  if (!req.user?.isSuperAdmin) {
    if (req.user?.tenantId) next[tenantKey] = req.user.tenantId;
  } else if (req.query?.tenantId) {
    next[tenantKey] = req.query.tenantId;
  }
  return next;
};

const applyGeographyScope = (where = {}, req, geographyKey = 'geography_id') => {
  const next = { ...where };
  if (req.user?.isSuperAdmin) return next;
  const geographyIds = uniqueIds(req.user?.scopeGeographyIds || []);
  if (geographyIds.length > 0) {
    next[geographyKey] = { [Op.in]: geographyIds };
  } else if (req.user?.scopeLevel && req.user.scopeLevel !== 'organization' && req.user.scopeLevel !== 'facility') {
    next[geographyKey] = EMPTY_SCOPE_UUID;
  }
  return next;
};

const applyFacilityScope = (where = {}, req, facilityKey = 'facility_id') => {
  const next = { ...where };
  if (req.user?.isSuperAdmin) return next;
  const facilityIds = uniqueIds(req.user?.scopeFacilityIds || []);
  if (facilityIds.length > 0) {
    next[facilityKey] = { [Op.in]: facilityIds };
  } else if (req.user?.scopeLevel === 'facility') {
    next[facilityKey] = EMPTY_SCOPE_UUID;
  }
  return next;
};

const isFacilityInScope = (req, facilityId) => {
  if (req.user?.isSuperAdmin) return true;
  const scopedFacilityIds = uniqueIds(req.user?.scopeFacilityIds || []);
  if (scopedFacilityIds.length === 0) {
    return req.user?.scopeLevel !== 'facility';
  }
  return scopedFacilityIds.includes(String(facilityId || ''));
};

const isGeographyInScope = (req, geographyId) => {
  if (req.user?.isSuperAdmin) return true;
  const scopedGeographyIds = uniqueIds(req.user?.scopeGeographyIds || []);
  if (scopedGeographyIds.length === 0) {
    return req.user?.scopeLevel === 'organization' || req.user?.scopeLevel === 'facility';
  }
  return scopedGeographyIds.includes(String(geographyId || ''));
};

module.exports = {
  EMPTY_SCOPE_UUID,
  uniqueIds,
  applyTenantScope,
  applyGeographyScope,
  applyFacilityScope,
  isFacilityInScope,
  isGeographyInScope,
};
