const { PersonaFamilies, ROLE_CODES, getPersonaFamily, normalizeRoleCode } = require('./personaFamilies');

const ScopeLevels = {
  PLATFORM: 'platform',
  ORGANIZATION: 'organization',
  COUNTRY: 'country',
  STATE: 'state',
  DISTRICT: 'district',
  CITY: 'city',
  ZONE: 'zone',
  FACILITY: 'facility',
};

const RoleTypes = {
  PLATFORM: 'platform',
  OPS_ADMIN: 'ops_admin',
  SUPERVISOR: 'supervisor',
  VIEWER: 'viewer',
  AUDITOR: 'auditor',
  FIELD_WORKER: 'field_worker',
  UNKNOWN: 'unknown',
};

const OPS_ADMIN_SHARED_ROUTES = [
  '/ops/overview',
  '/ops/command-center',
  '/ops/toilets',
  '/ops/inspections',
  '/ops/sensors',
  '/ops/alerts',
  '/ops/tasks',
  '/ops/complaints',
  '/ops/contractors',
  '/ops/reports',
  '/ops/admin',
  '/ops/users',
  '/ops/audit',
  '/ops/settings',
  '/ops/profile',
];

const ROLE_PRIORITY = new Map([
  [ROLE_CODES.SUPER_ADMIN, 0],
  [ROLE_CODES.PLATFORM_OPS, 5],
  [ROLE_CODES.TENANT_ADMIN, 10],
  [ROLE_CODES.COUNTRY_ADMIN, 20],
  [ROLE_CODES.STATE_ADMIN, 30],
  [ROLE_CODES.DISTRICT_ADMIN, 40],
  [ROLE_CODES.CITY_ADMIN, 50],
  [ROLE_CODES.ZONE_ADMIN, 60],
  [ROLE_CODES.FACILITY_MANAGER, 70],
  [ROLE_CODES.SUPERVISOR, 80],
  [ROLE_CODES.AUDITOR, 90],
  [ROLE_CODES.VIEWER, 95],
  [ROLE_CODES.CONTRACTOR_MANAGER, 98],
  // Keep field worker as lowest priority so mixed web+mobile role users
  // still resolve to the web persona on web login.
  [ROLE_CODES.FIELD_WORKER, 100],
]);

const ROLE_PROFILES = {
  [ROLE_CODES.SUPER_ADMIN]: {
    roleType: RoleTypes.PLATFORM,
    personaFamily: PersonaFamilies.PLATFORM,
    scopeLevel: ScopeLevels.PLATFORM,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/sa/dashboard',
    allowedRoutes: ['/sa'],
    allowedActions: ['platform.manage', 'tenant.manage', 'user.manage', 'report.export'],
  },
  [ROLE_CODES.PLATFORM_OPS]: {
    roleType: RoleTypes.PLATFORM,
    personaFamily: PersonaFamilies.LEGACY_COMPAT,
    scopeLevel: ScopeLevels.PLATFORM,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/sa/dashboard',
    allowedRoutes: ['/sa'],
    allowedActions: ['platform.read'],
  },
  [ROLE_CODES.TENANT_ADMIN]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    scopeLevel: ScopeLevels.ORGANIZATION,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [...OPS_ADMIN_SHARED_ROUTES],
    allowedActions: [
      'hierarchy.manage',
      'user.manage',
      'facility.manage',
      'task.manage',
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.manage',
      'alert.escalate',
      'report.export',
      'settings.manage',
    ],
  },
  [ROLE_CODES.COUNTRY_ADMIN]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    scopeLevel: ScopeLevels.COUNTRY,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [...OPS_ADMIN_SHARED_ROUTES],
    allowedActions: [
      'hierarchy.manage',
      'user.manage',
      'facility.manage',
      'task.manage',
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.manage',
      'alert.escalate',
      'report.export',
    ],
  },
  [ROLE_CODES.STATE_ADMIN]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    scopeLevel: ScopeLevels.STATE,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [...OPS_ADMIN_SHARED_ROUTES],
    allowedActions: [
      'hierarchy.manage',
      'user.manage',
      'facility.manage',
      'task.manage',
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.manage',
      'alert.escalate',
      'report.export',
    ],
  },
  [ROLE_CODES.DISTRICT_ADMIN]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    scopeLevel: ScopeLevels.DISTRICT,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [...OPS_ADMIN_SHARED_ROUTES],
    allowedActions: [
      'hierarchy.manage',
      'user.manage',
      'facility.manage',
      'task.manage',
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.manage',
      'alert.escalate',
      'report.export',
    ],
  },
  [ROLE_CODES.CITY_ADMIN]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    scopeLevel: ScopeLevels.CITY,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [...OPS_ADMIN_SHARED_ROUTES],
    allowedActions: [
      'hierarchy.manage',
      'user.manage',
      'facility.manage',
      'task.manage',
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.manage',
      'alert.escalate',
      'report.export',
    ],
  },
  [ROLE_CODES.ZONE_ADMIN]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    scopeLevel: ScopeLevels.ZONE,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [...OPS_ADMIN_SHARED_ROUTES],
    allowedActions: [
      'hierarchy.manage',
      'user.manage',
      'facility.manage',
      'task.manage',
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.manage',
      'alert.escalate',
      'report.export',
    ],
  },
  [ROLE_CODES.FACILITY_MANAGER]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    scopeLevel: ScopeLevels.FACILITY,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [
      '/ops/overview',
      '/ops/toilets',
      '/ops/inspections',
      '/ops/sensors',
      '/ops/alerts',
      '/ops/tasks',
      '/ops/reports',
      '/ops/profile',
    ],
    allowedActions: [
      'facility.manage',
      'task.manage',
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.manage',
      'alert.escalate',
      'evidence.review',
    ],
  },
  [ROLE_CODES.SUPERVISOR]: {
    roleType: RoleTypes.SUPERVISOR,
    personaFamily: PersonaFamilies.SUPERVISOR,
    scopeLevel: ScopeLevels.FACILITY,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [
      '/ops/overview',
      '/ops/toilets',
      '/ops/inspections',
      '/ops/alerts',
      '/ops/tasks',
      '/ops/reports',
      '/ops/profile',
    ],
    allowedActions: [
      'task.assign',
      'task.reassign',
      'task.verify',
      'task.execute',
      'alert.escalate',
      'evidence.review',
    ],
  },
  [ROLE_CODES.VIEWER]: {
    roleType: RoleTypes.VIEWER,
    personaFamily: PersonaFamilies.READ_ONLY,
    scopeLevel: ScopeLevels.ORGANIZATION,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [
      '/ops/overview',
      '/ops/command-center',
      '/ops/toilets',
      '/ops/sensors',
      '/ops/alerts',
      '/ops/reports',
      '/ops/profile',
    ],
    allowedActions: [],
  },
  [ROLE_CODES.AUDITOR]: {
    roleType: RoleTypes.AUDITOR,
    personaFamily: PersonaFamilies.READ_ONLY,
    scopeLevel: ScopeLevels.ORGANIZATION,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: [
      '/ops/overview',
      '/ops/inspections',
      '/ops/toilets',
      '/ops/audit',
      '/ops/reports',
      '/ops/profile',
    ],
    allowedActions: ['audit.findings.write', 'evidence.review', 'report.export'],
  },
  [ROLE_CODES.FIELD_WORKER]: {
    roleType: RoleTypes.FIELD_WORKER,
    personaFamily: PersonaFamilies.FIELD_WORKER,
    scopeLevel: ScopeLevels.FACILITY,
    webEnabled: false,
    mobileOnly: true,
    defaultRoute: '/unauthorized',
    allowedRoutes: [],
    allowedActions: ['task.execute', 'inspection.create'],
  },
  [ROLE_CODES.CONTRACTOR_MANAGER]: {
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.LEGACY_COMPAT,
    scopeLevel: ScopeLevels.ORGANIZATION,
    webEnabled: true,
    mobileOnly: false,
    defaultRoute: '/ops/overview',
    allowedRoutes: ['/ops/overview', '/ops/contractors', '/ops/reports', '/ops/profile'],
    allowedActions: ['contractor.manage'],
  },
};

const ROLE_SCOPE_BY_ROLE_CODE = {
  [ROLE_CODES.TENANT_ADMIN]: ScopeLevels.ORGANIZATION,
  [ROLE_CODES.COUNTRY_ADMIN]: ScopeLevels.COUNTRY,
  [ROLE_CODES.STATE_ADMIN]: ScopeLevels.STATE,
  [ROLE_CODES.DISTRICT_ADMIN]: ScopeLevels.DISTRICT,
  [ROLE_CODES.CITY_ADMIN]: ScopeLevels.CITY,
  [ROLE_CODES.ZONE_ADMIN]: ScopeLevels.ZONE,
  [ROLE_CODES.FACILITY_MANAGER]: ScopeLevels.FACILITY,
};

const dedupeNormalized = (values = []) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => normalizeRoleCode(value)).filter(Boolean))];

const resolvePrimaryRoleCode = ({ role = null, roleCodes = [] } = {}) => {
  const normalizedRole = normalizeRoleCode(role);
  if (normalizedRole) return normalizedRole;
  const normalizedCodes = dedupeNormalized(roleCodes);
  if (normalizedCodes.length === 0) return null;
  return [...normalizedCodes].sort((left, right) => {
    const leftRank = ROLE_PRIORITY.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = ROLE_PRIORITY.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  })[0];
};

const roleProfileFallback = (roleCode) => {
  const family = getPersonaFamily(roleCode);
  if (family === PersonaFamilies.PLATFORM) return ROLE_PROFILES[ROLE_CODES.SUPER_ADMIN];
  if (family === PersonaFamilies.OPS_ADMIN) return ROLE_PROFILES[ROLE_CODES.TENANT_ADMIN];
  if (family === PersonaFamilies.SUPERVISOR) return ROLE_PROFILES[ROLE_CODES.SUPERVISOR];
  if (family === PersonaFamilies.READ_ONLY) return ROLE_PROFILES[ROLE_CODES.VIEWER];
  if (family === PersonaFamilies.FIELD_WORKER) return ROLE_PROFILES[ROLE_CODES.FIELD_WORKER];
  return {
    roleType: RoleTypes.UNKNOWN,
    personaFamily: PersonaFamilies.UNKNOWN,
    scopeLevel: ScopeLevels.ORGANIZATION,
    webEnabled: false,
    mobileOnly: false,
    defaultRoute: '/unauthorized',
    allowedRoutes: [],
    allowedActions: [],
  };
};

const resolveRoleProfile = ({ role = null, roleCodes = [] } = {}) => {
  const primaryRoleCode = resolvePrimaryRoleCode({ role, roleCodes });
  const normalizedRoleCodes = dedupeNormalized(roleCodes);
  const base = ROLE_PROFILES[primaryRoleCode] || roleProfileFallback(primaryRoleCode);
  const aggregateProfiles =
    normalizedRoleCodes.length > 0
      ? normalizedRoleCodes.map((code) => ROLE_PROFILES[code] || roleProfileFallback(code))
      : [base];
  const mergedAllowedRoutes = [
    ...new Set(
      aggregateProfiles.flatMap((profile) =>
        Array.isArray(profile.allowedRoutes) ? profile.allowedRoutes : []
      )
    ),
  ];
  const mergedAllowedActions = [
    ...new Set(
      aggregateProfiles.flatMap((profile) =>
        Array.isArray(profile.allowedActions) ? profile.allowedActions : []
      )
    ),
  ];
  return {
    role: primaryRoleCode,
    roleCodes: normalizedRoleCodes,
    roleType: base.roleType,
    personaFamily: base.personaFamily,
    scopeLevel: base.scopeLevel,
    webEnabled: aggregateProfiles.some((profile) => profile.webEnabled !== false),
    mobileOnly: aggregateProfiles.every((profile) => profile.mobileOnly === true),
    defaultRoute: base.defaultRoute || '/unauthorized',
    allowedRoutes: mergedAllowedRoutes,
    allowedActions: mergedAllowedActions,
  };
};

const resolveSeedScopeFromMemberships = ({ roleCode, memberships = [], activeTenantId = null }) => {
  const membershipForRole = (Array.isArray(memberships) ? memberships : []).find(
    (membership) =>
      normalizeRoleCode(membership?.roleCode) === normalizeRoleCode(roleCode) &&
      (activeTenantId ? membership?.tenantId === activeTenantId : true),
  );
  return membershipForRole?.geographyId || null;
};

const resolveScopedRoleLevel = (roleCode) => ROLE_SCOPE_BY_ROLE_CODE[normalizeRoleCode(roleCode)] || null;

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
