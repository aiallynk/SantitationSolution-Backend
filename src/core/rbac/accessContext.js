const { Op } = require('sequelize');
const { resolveRoleAccessProfile } = require('./accessMatrix');

const EMPTY_SCOPE_UUID = '00000000-0000-0000-0000-000000000000';

const uniqueIds = (values = []) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];

const toBoolean = (value, fallback = false) => {
  if (value == null) return fallback;
  return Boolean(value);
};

const appendScopedConstraint = (query = {}, key, value) => {
  if (!key || value === undefined) return;
  if (query[key] == null) {
    query[key] = value;
    return;
  }

  const currentAnd = Array.isArray(query[Op.and]) ? query[Op.and] : [];
  query[Op.and] = [...currentAnd, { [key]: value }];
};

const buildAccessContextFromUser = (user = {}) => {
  const roleCodes = uniqueIds(user.roleCodes || user.allRoleCodes || []);
  const profile = resolveRoleAccessProfile({
    role: user.role || roleCodes[0] || null,
    roleCodes,
  });

  const permissions = uniqueIds(user.permissionCodes || user.permissions || profile.permissionCodes || []);
  const geographyIds = uniqueIds(user.scopeGeographyIds || user.assignmentGeographyIds || []);
  const facilityIds = uniqueIds(user.scopeFacilityIds || user.assignmentFacilityIds || []);

  return {
    primaryRole: profile.role,
    personaFamily: profile.personaFamily,
    surfaceType: profile.surfaceType,
    tenantId: user.tenantId || user.organizationId || null,
    geographyIds,
    facilityIds,
    permissions,
    routeKeys: profile.routeKeys || [],
    actionKeys: profile.actionKeys || [],
    widgetKeys: profile.widgetKeys || [],
    readOnly: toBoolean(profile.readOnly, false),
    managementLevel: profile.managementLevel,
    hierarchyLevel: profile.hierarchyLevel,
    scopeType: profile.scopeType,
    scopeLevel: user.scopeLevel || profile.scopeLevel,
    allowedDataDomains: profile.allowedDataDomains || [],
    canAccessWeb: toBoolean(profile.canAccessWeb, false),
    canAccessMobile: toBoolean(profile.canAccessMobile, false),
    isSuperAdmin: toBoolean(user.isSuperAdmin, false),
  };
};

const resolveAllowedGeographyIds = (accessContext = {}) => uniqueIds(accessContext.geographyIds || []);

const resolveAllowedFacilityIds = (accessContext = {}) => uniqueIds(accessContext.facilityIds || []);

const applyScopeToQuery = (
  modelQuery = {},
  accessContext = {},
  domainType = 'tenant',
  options = {},
) => {
  const next = { ...modelQuery };
  const domain = String(domainType || 'tenant').trim().toLowerCase();
  const tenantKey = String(options.tenantKey || 'tenant_id');
  const geographyKey = String(options.geographyKey || 'geography_id');
  const facilityKey = String(options.facilityKey || 'facility_id');

  if (accessContext?.isSuperAdmin) {
    return next;
  }

  const tenantId = accessContext?.tenantId ? String(accessContext.tenantId) : null;
  if (tenantId) {
    appendScopedConstraint(next, tenantKey, tenantId);
  }

  const scopeLevel = String(accessContext?.scopeLevel || '').toLowerCase();
  const geographyIds = resolveAllowedGeographyIds(accessContext);
  const facilityIds = resolveAllowedFacilityIds(accessContext);

  const shouldApplyGeography =
    domain === 'geography' ||
    domain === 'users' ||
    domain === 'adminops' ||
    domain === 'audit';

  const shouldApplyFacility =
    domain === 'facility' ||
    domain === 'dashboard' ||
    domain === 'alert' ||
    domain === 'inspection' ||
    domain === 'task' ||
    domain === 'report' ||
    domain === 'complaint' ||
    domain === 'sensor' ||
    domain === 'audit';

  if (shouldApplyGeography) {
    if (geographyIds.length > 0) {
      appendScopedConstraint(next, geographyKey, { [Op.in]: geographyIds });
    } else if (
      scopeLevel &&
      scopeLevel !== 'organization' &&
      scopeLevel !== 'facility'
    ) {
      appendScopedConstraint(next, geographyKey, EMPTY_SCOPE_UUID);
    }
  }

  if (shouldApplyFacility) {
    if (facilityIds.length > 0) {
      appendScopedConstraint(next, facilityKey, { [Op.in]: facilityIds });
    } else if (scopeLevel === 'facility') {
      appendScopedConstraint(next, facilityKey, EMPTY_SCOPE_UUID);
    }
  }

  return next;
};

module.exports = {
  EMPTY_SCOPE_UUID,
  uniqueIds,
  buildAccessContextFromUser,
  resolveAllowedGeographyIds,
  resolveAllowedFacilityIds,
  applyScopeToQuery,
};
