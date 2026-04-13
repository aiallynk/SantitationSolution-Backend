const {
  ScopeLevels,
  RoleTypes,
  ROLE_PRIORITY,
  ROLE_ACCESS_MATRIX,
  resolvePrimaryRoleCode,
  resolveRoleAccessProfile,
  resolveSeedScopeFromMemberships,
  resolveScopedRoleLevel,
} = require('./accessMatrix');

const ROLE_PROFILES = Object.fromEntries(
  Object.entries(ROLE_ACCESS_MATRIX).map(([roleCode, entry]) => [
    roleCode,
    {
      roleType: entry.roleType,
      personaFamily: entry.personaFamily,
      scopeLevel: entry.scopeLevel,
      scopeType: entry.scopeType,
      hierarchyLevel: entry.hierarchyLevel,
      managementLevel: entry.managementLevel,
      surfaceType: entry.surfaceType,
      webEnabled: entry.canAccessWeb,
      mobileOnly: !entry.canAccessWeb && entry.canAccessMobile,
      canAccessWeb: entry.canAccessWeb,
      canAccessMobile: entry.canAccessMobile,
      defaultRoute: entry.primaryLandingRoute,
      primaryLandingRoute: entry.primaryLandingRoute,
      allowedRoutes: [],
      routeKeys: entry.allowedRouteKeys,
      allowedActions: entry.allowedActionKeys,
      actionKeys: entry.allowedActionKeys,
      widgetKeys: entry.allowedWidgetKeys,
      allowedDataDomains: entry.allowedDataDomains,
      readOnly: entry.readOnly,
      permissionCodes: entry.permissionCodes,
    },
  ])
);

const resolveRoleProfile = ({ role = null, roleCodes = [] } = {}) => {
  const resolved = resolveRoleAccessProfile({ role, roleCodes });
  return {
    role: resolved.role,
    roleCodes: resolved.roleCodes,
    roleType: resolved.roleType,
    personaFamily: resolved.personaFamily,
    scopeLevel: resolved.scopeLevel,
    scopeType: resolved.scopeType,
    hierarchyLevel: resolved.hierarchyLevel,
    managementLevel: resolved.managementLevel,
    surfaceType: resolved.surfaceType,
    webEnabled: resolved.webEnabled,
    mobileOnly: resolved.mobileOnly,
    canAccessWeb: resolved.canAccessWeb,
    canAccessMobile: resolved.canAccessMobile,
    defaultRoute: resolved.defaultRoute,
    primaryLandingRoute: resolved.primaryLandingRoute,
    allowedRoutes: resolved.allowedRoutes,
    routeKeys: resolved.routeKeys,
    allowedActions: resolved.allowedActions,
    actionKeys: resolved.actionKeys,
    widgetKeys: resolved.widgetKeys,
    allowedDataDomains: resolved.allowedDataDomains,
    readOnly: resolved.readOnly,
    permissionCodes: resolved.permissionCodes,
  };
};

for (const [roleCode, profile] of Object.entries(ROLE_PROFILES)) {
  const resolved = resolveRoleAccessProfile({ role: roleCode, roleCodes: [roleCode] });
  profile.allowedRoutes = resolved.allowedRoutes;
}

module.exports = {
  ScopeLevels,
  RoleTypes,
  ROLE_PROFILES,
  ROLE_PRIORITY,
  resolvePrimaryRoleCode,
  resolveRoleProfile,
  resolveSeedScopeFromMemberships,
  resolveScopedRoleLevel,
};
