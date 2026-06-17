const {
  PersonaFamilies,
  ROLE_CODES,
  getPersonaFamily,
  normalizeRoleCode,
} = require('./personaFamilies');

const SurfaceTypes = {
  PLATFORM_WEB: 'platform_web',
  OPS_WEB: 'ops_web',
  MOBILE_ONLY: 'mobile_only',
  OPS_WEB_AND_MOBILE: 'ops_web_and_mobile',
};

const ScopeTypes = {
  NONE: 'none',
  GEOGRAPHY: 'geography',
  FACILITY: 'facility',
};

const ManagementLevels = {
  PLATFORM: 'platform',
  TENANT: 'tenant',
  GEOGRAPHY: 'geography',
  FACILITY: 'facility',
  EXECUTION: 'execution',
};

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
  LEGACY: 'legacy',
  UNKNOWN: 'unknown',
};

const RouteKeys = {
  SA_OVERVIEW: 'SA_OVERVIEW',
  SA_TENANTS: 'SA_TENANTS',
  SA_GLOBAL_USERS: 'SA_GLOBAL_USERS',
  SA_PLATFORM_HEALTH: 'SA_PLATFORM_HEALTH',
  OPS_OVERVIEW: 'OPS_OVERVIEW',
  OPS_MONITORING: 'OPS_MONITORING',
  OPS_AUDITOR_DASHBOARD: 'OPS_AUDITOR_DASHBOARD',
  OPS_AUDITOR_AUDITS: 'OPS_AUDITOR_AUDITS',
  OPS_AUDITOR_ASSETS: 'OPS_AUDITOR_ASSETS',
  OPS_AUDITOR_MONITORING: 'OPS_AUDITOR_MONITORING',
  OPS_AUDITOR_ATTENDANCE: 'OPS_AUDITOR_ATTENDANCE',
  OPS_AUDITOR_ALERTS: 'OPS_AUDITOR_ALERTS',
  OPS_AUDITOR_EVIDENCE: 'OPS_AUDITOR_EVIDENCE',
  OPS_AUDITOR_REPORTS: 'OPS_AUDITOR_REPORTS',
  OPS_COMMAND_CENTER: 'OPS_COMMAND_CENTER',
  OPS_TOILETS: 'OPS_TOILETS',
  OPS_INSPECTIONS: 'OPS_INSPECTIONS',
  OPS_ALERTS: 'OPS_ALERTS',
  OPS_TASKS: 'OPS_TASKS',
  OPS_REPORTS: 'OPS_REPORTS',
  OPS_SENSORS: 'OPS_SENSORS',
  OPS_COMPLAINTS: 'OPS_COMPLAINTS',
  OPS_CONTRACTORS: 'OPS_CONTRACTORS',
  OPS_ADMINOPS: 'OPS_ADMINOPS',
  OPS_USERS: 'OPS_USERS',
  OPS_AUDIT: 'OPS_AUDIT',
  OPS_SETTINGS: 'OPS_SETTINGS',
  OPS_PROFILE: 'OPS_PROFILE',
  SUPERVISOR_OVERVIEW: 'SUPERVISOR_OVERVIEW',
  SUPERVISOR_WORKERS: 'SUPERVISOR_WORKERS',
  SUPERVISOR_ATTENDANCE: 'SUPERVISOR_ATTENDANCE',
  SUPERVISOR_LIVE_LOCATION: 'SUPERVISOR_LIVE_LOCATION',
  SUPERVISOR_CHECKIN_CHECKOUT: 'SUPERVISOR_CHECKIN_CHECKOUT',
  SUPERVISOR_DEVICE_HEALTH: 'SUPERVISOR_DEVICE_HEALTH',
  SUPERVISOR_WORK_PROGRESS: 'SUPERVISOR_WORK_PROGRESS',
  SUPERVISOR_CLEANLINESS: 'SUPERVISOR_CLEANLINESS',
  SUPERVISOR_ALERTS: 'SUPERVISOR_ALERTS',
  SUPERVISOR_REPORTS: 'SUPERVISOR_REPORTS',
};

const RouteKeyToPaths = {
  [RouteKeys.SA_OVERVIEW]: [
    '/sa',
    '/sa/dashboard',
    '/sa/action-center',
    '/sa/notifications',
    '/sa/multi-city',
  ],
  [RouteKeys.SA_TENANTS]: [
    '/sa/organizations',
    '/sa/client-workspace',
    '/sa/projects',
    '/sa/topology',
  ],
  [RouteKeys.SA_GLOBAL_USERS]: [
    '/sa/global-users',
    '/sa/roles-permissions',
    '/sa/approvals',
    '/sa/global-audit',
  ],
  [RouteKeys.SA_PLATFORM_HEALTH]: [
    '/sa/platform-analytics',
    '/sa/storage',
    '/sa/ai-usage',
    '/sa/queue-health',
    '/sa/sync-failures',
    '/sa/device-fleet',
    '/sa/tenant-health',
    '/sa/master-data',
    '/sa/scoring-thresholds',
    '/sa/escalation-policies',
    '/sa/templates',
    '/sa/localization',
    '/sa/support',
    '/sa/integrations',
    '/sa/releases',
    '/sa/backup',
    '/sa/policy',
    '/sa/reliability',
    '/sa/settings',
  ],
  [RouteKeys.OPS_OVERVIEW]: ['/ops/overview'],
  [RouteKeys.OPS_MONITORING]: ['/ops/monitoring'],
  [RouteKeys.OPS_AUDITOR_DASHBOARD]: ['/ops/auditor/dashboard'],
  [RouteKeys.OPS_AUDITOR_AUDITS]: ['/ops/auditor/audits'],
  [RouteKeys.OPS_AUDITOR_ASSETS]: ['/ops/auditor/assets'],
  [RouteKeys.OPS_AUDITOR_MONITORING]: ['/ops/auditor/monitoring'],
  [RouteKeys.OPS_AUDITOR_ATTENDANCE]: ['/ops/auditor/attendance'],
  [RouteKeys.OPS_AUDITOR_ALERTS]: ['/ops/auditor/alerts-review'],
  [RouteKeys.OPS_AUDITOR_EVIDENCE]: ['/ops/auditor/evidence'],
  [RouteKeys.OPS_AUDITOR_REPORTS]: ['/ops/auditor/reports'],
  [RouteKeys.OPS_COMMAND_CENTER]: ['/ops/command-center'],
  [RouteKeys.OPS_TOILETS]: ['/ops/toilets'],
  [RouteKeys.OPS_INSPECTIONS]: ['/ops/inspections'],
  [RouteKeys.OPS_ALERTS]: ['/ops/alerts'],
  [RouteKeys.OPS_TASKS]: ['/ops/tasks'],
  [RouteKeys.OPS_REPORTS]: ['/ops/reports'],
  [RouteKeys.OPS_SENSORS]: ['/ops/sensors'],
  [RouteKeys.OPS_COMPLAINTS]: ['/ops/complaints'],
  [RouteKeys.OPS_CONTRACTORS]: ['/ops/contractors'],
  [RouteKeys.OPS_ADMINOPS]: ['/ops/admin'],
  [RouteKeys.OPS_USERS]: ['/ops/users'],
  [RouteKeys.OPS_AUDIT]: ['/ops/audit'],
  [RouteKeys.OPS_SETTINGS]: ['/ops/settings'],
  [RouteKeys.OPS_PROFILE]: ['/ops/profile'],
  [RouteKeys.SUPERVISOR_OVERVIEW]: ['/ops/supervisor/overview'],
  [RouteKeys.SUPERVISOR_WORKERS]: [
    '/ops/supervisor/workers',
    '/ops/supervisor/workers/create',
    '/ops/supervisor/workers/:workerId',
  ],
  [RouteKeys.SUPERVISOR_ATTENDANCE]: ['/ops/supervisor/attendance'],
  [RouteKeys.SUPERVISOR_LIVE_LOCATION]: ['/ops/supervisor/live-map'],
  [RouteKeys.SUPERVISOR_CHECKIN_CHECKOUT]: ['/ops/supervisor/checkins'],
  [RouteKeys.SUPERVISOR_DEVICE_HEALTH]: ['/ops/supervisor/device-health'],
  [RouteKeys.SUPERVISOR_WORK_PROGRESS]: ['/ops/supervisor/work-progress'],
  [RouteKeys.SUPERVISOR_CLEANLINESS]: ['/ops/supervisor/cleanliness'],
  [RouteKeys.SUPERVISOR_ALERTS]: ['/ops/supervisor/alerts'],
  [RouteKeys.SUPERVISOR_REPORTS]: ['/ops/supervisor/reports'],
};

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
  [ROLE_CODES.FIELD_WORKER, 100],
]);

const OPS_ADMIN_ROUTE_KEYS = [
  RouteKeys.OPS_OVERVIEW,
  RouteKeys.OPS_COMMAND_CENTER,
  RouteKeys.OPS_TOILETS,
  RouteKeys.OPS_INSPECTIONS,
  RouteKeys.OPS_ALERTS,
  RouteKeys.OPS_TASKS,
  RouteKeys.OPS_REPORTS,
  RouteKeys.OPS_SENSORS,
  RouteKeys.OPS_COMPLAINTS,
  RouteKeys.OPS_CONTRACTORS,
  RouteKeys.OPS_ADMINOPS,
  RouteKeys.OPS_USERS,
  RouteKeys.OPS_AUDIT,
  RouteKeys.OPS_SETTINGS,
  RouteKeys.OPS_PROFILE,
];

const OPS_ADMIN_ACTION_KEYS = [
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
];

const ADMIN_WIDGET_KEYS = [
  'W_HYGIENE_TREND',
  'W_ALERT_BACKLOG',
  'W_OPEN_TASKS',
  'W_REVIEW_QUEUE',
  'W_COMPLAINT_SLA',
  'W_SENSOR_HEALTH',
  'W_CONTRACTOR_PERFORMANCE',
  'W_GEO_COMPARISON',
];

const FACILITY_WIDGET_KEYS = [
  'W_FACILITY_SCORE',
  'W_FACILITY_ALERTS',
  'W_TASK_COMPLETION',
  'W_PENDING_INSPECTIONS',
  'W_WASHROOM_STATUS',
  'W_DEVICE_ISSUES',
];

const SUPERVISOR_WIDGET_KEYS = [
  'W_TODAY_TASKS',
  'W_FACILITY_SCORE',
  'W_PENDING_INSPECTIONS',
  'W_UNRESOLVED_ISSUES',
  'W_WORKER_PRODUCTIVITY',
];

const READ_ONLY_WIDGET_KEYS = [
  'W_READ_ONLY_OVERVIEW',
  'W_READ_ONLY_ALERTS',
  'W_READ_ONLY_REPORTS',
];

const AUDITOR_WIDGET_KEYS = [
  'W_AUDIT_COMPLIANCE',
  'W_EVIDENCE_QUEUE',
  'W_INSPECTION_TRAIL',
];

const PLATFORM_WIDGET_KEYS = [
  'W_TENANT_COUNT',
  'W_ACTIVE_USERS',
  'W_AI_USAGE',
  'W_STORAGE_CONSUMPTION',
  'W_QUEUE_HEALTH',
  'W_SYNC_FAILURES',
  'W_SYSTEM_UPTIME',
  'W_PLATFORM_ALERTS',
  'W_CROSS_TENANT_HEATMAP',
  'W_TOP_FAILING_TENANTS',
];

const TENANT_ADMIN_PERMISSION_CODES = [
  'auth.read',
  'dashboard.read',
  'inspection.review',
  'task.manage',
  'alerts.manage',
  'sensor.read',
  'users.manage',
  'reports.read',
  'reports.export',
  'audit.read',
];

const FACILITY_MANAGER_PERMISSION_CODES = [
  'auth.read',
  'dashboard.read',
  'inspection.review',
  'task.manage',
  'alerts.manage',
  'sensor.read',
  'reports.read',
];

const SUPERVISOR_PERMISSION_CODES = [
  'auth.read',

  'supervisor.overview.read',
  'supervisor.workers.read',
  'worker.attendance.read',
  'worker.location.read',
  'worker.checkin.read',
  'worker.device_health.read',
  'worker.task_progress.read',
  'cleanliness.verification.read',
  'cleanliness.verification.review',
  'supervisor.alerts.read',
  'supervisor.alerts.escalate',
  'supervisor.reports.read',

];

const VIEWER_PERMISSION_CODES = ['auth.read', 'dashboard.read', 'reports.read'];

const AUDITOR_PERMISSION_CODES = [
  'auth.read',
  'dashboard.read',
  'inspection.review',
  'inspection.create',
  'reports.read',
  'audit.read',
];

const FIELD_WORKER_PERMISSION_CODES = [
  'auth.read',
  'inspection.create',
  'dashboard.read',
];

const createGeoAdminEntry = ({
  roleCode,
  hierarchyLevel,
  scopeLevel,
}) => ({
  roleCode,
  roleType: RoleTypes.OPS_ADMIN,
  personaFamily: PersonaFamilies.OPS_ADMIN,
  hierarchyLevel,
  surfaceType: SurfaceTypes.OPS_WEB,
  scopeType: ScopeTypes.GEOGRAPHY,
  scopeLevel,
  managementLevel: ManagementLevels.GEOGRAPHY,
  primaryLandingRoute: '/ops/overview',
  allowedRouteKeys: [...OPS_ADMIN_ROUTE_KEYS],
  allowedActionKeys: [...OPS_ADMIN_ACTION_KEYS],
  allowedWidgetKeys: [...ADMIN_WIDGET_KEYS],
  allowedDataDomains: [
    'geography.dashboard',
    'geography.users',
    'geography.alerts',
    'geography.tasks',
    'geography.reports',
    'geography.audit',
  ],
  permissionCodes: [...TENANT_ADMIN_PERMISSION_CODES],
  readOnly: false,
  canAccessWeb: true,
  canAccessMobile: false,
});

const ROLE_ACCESS_MATRIX = {
  [ROLE_CODES.SUPER_ADMIN]: {
    roleCode: ROLE_CODES.SUPER_ADMIN,
    roleType: RoleTypes.PLATFORM,
    personaFamily: PersonaFamilies.PLATFORM,
    hierarchyLevel: 0,
    surfaceType: SurfaceTypes.PLATFORM_WEB,
    scopeType: ScopeTypes.NONE,
    scopeLevel: ScopeLevels.PLATFORM,
    managementLevel: ManagementLevels.PLATFORM,
    primaryLandingRoute: '/sa/dashboard',
    allowedRouteKeys: [
      RouteKeys.SA_OVERVIEW,
      RouteKeys.SA_TENANTS,
      RouteKeys.SA_GLOBAL_USERS,
      RouteKeys.SA_PLATFORM_HEALTH,
    ],
    allowedActionKeys: ['platform.manage', 'tenant.manage', 'user.manage', 'report.export'],
    allowedWidgetKeys: [...PLATFORM_WIDGET_KEYS],
    allowedDataDomains: [
      'platform.analytics',
      'platform.tenants',
      'platform.users',
      'platform.health',
      'platform.audit',
    ],
    permissionCodes: [
      'auth.read',
      'dashboard.read',
      'inspection.review',
      'task.manage',
      'alerts.manage',
      'sensor.read',
      'super_admin.read',
      'super_admin.write',
      'users.manage',
      'reports.read',
      'reports.export',
      'tenants.manage',
      'audit.read',
    ],
    readOnly: false,
    canAccessWeb: true,
    canAccessMobile: false,
  },

  [ROLE_CODES.PLATFORM_OPS]: {
    roleCode: ROLE_CODES.PLATFORM_OPS,
    roleType: RoleTypes.LEGACY,
    personaFamily: PersonaFamilies.LEGACY_COMPAT,
    hierarchyLevel: 5,
    surfaceType: SurfaceTypes.PLATFORM_WEB,
    scopeType: ScopeTypes.NONE,
    scopeLevel: ScopeLevels.PLATFORM,
    managementLevel: ManagementLevels.PLATFORM,
    primaryLandingRoute: '/sa/dashboard',
    allowedRouteKeys: [RouteKeys.SA_OVERVIEW, RouteKeys.SA_PLATFORM_HEALTH],
    allowedActionKeys: ['platform.read'],
    allowedWidgetKeys: ['W_QUEUE_HEALTH', 'W_SYNC_FAILURES', 'W_SYSTEM_UPTIME', 'W_PLATFORM_ALERTS'],
    allowedDataDomains: ['platform.health', 'platform.alerts'],
    permissionCodes: ['auth.read', 'dashboard.read', 'super_admin.read'],
    readOnly: true,
    canAccessWeb: true,
    canAccessMobile: false,
  },

  [ROLE_CODES.TENANT_ADMIN]: {
    roleCode: ROLE_CODES.TENANT_ADMIN,
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    hierarchyLevel: 10,
    surfaceType: SurfaceTypes.OPS_WEB,
    scopeType: ScopeTypes.NONE,
    scopeLevel: ScopeLevels.ORGANIZATION,
    managementLevel: ManagementLevels.TENANT,
    primaryLandingRoute: '/ops/overview',
    allowedRouteKeys: [...OPS_ADMIN_ROUTE_KEYS],
    allowedActionKeys: [...OPS_ADMIN_ACTION_KEYS],
    allowedWidgetKeys: [...ADMIN_WIDGET_KEYS],
    allowedDataDomains: [
      'tenant.dashboard',
      'tenant.users',
      'tenant.alerts',
      'tenant.tasks',
      'tenant.reports',
      'tenant.audit',
      'tenant.settings',
    ],
    permissionCodes: [...TENANT_ADMIN_PERMISSION_CODES],
    readOnly: false,
    canAccessWeb: true,
    canAccessMobile: false,
  },

  [ROLE_CODES.COUNTRY_ADMIN]: createGeoAdminEntry({
    roleCode: ROLE_CODES.COUNTRY_ADMIN,
    hierarchyLevel: 20,
    scopeLevel: ScopeLevels.COUNTRY,
  }),

  [ROLE_CODES.STATE_ADMIN]: createGeoAdminEntry({
    roleCode: ROLE_CODES.STATE_ADMIN,
    hierarchyLevel: 30,
    scopeLevel: ScopeLevels.STATE,
  }),

  [ROLE_CODES.DISTRICT_ADMIN]: createGeoAdminEntry({
    roleCode: ROLE_CODES.DISTRICT_ADMIN,
    hierarchyLevel: 40,
    scopeLevel: ScopeLevels.DISTRICT,
  }),

  [ROLE_CODES.CITY_ADMIN]: createGeoAdminEntry({
    roleCode: ROLE_CODES.CITY_ADMIN,
    hierarchyLevel: 50,
    scopeLevel: ScopeLevels.CITY,
  }),

  [ROLE_CODES.ZONE_ADMIN]: createGeoAdminEntry({
    roleCode: ROLE_CODES.ZONE_ADMIN,
    hierarchyLevel: 60,
    scopeLevel: ScopeLevels.ZONE,
  }),

  [ROLE_CODES.FACILITY_MANAGER]: {
    roleCode: ROLE_CODES.FACILITY_MANAGER,
    roleType: RoleTypes.OPS_ADMIN,
    personaFamily: PersonaFamilies.OPS_ADMIN,
    hierarchyLevel: 70,
    surfaceType: SurfaceTypes.OPS_WEB,
    scopeType: ScopeTypes.FACILITY,
    scopeLevel: ScopeLevels.FACILITY,
    managementLevel: ManagementLevels.FACILITY,
    primaryLandingRoute: '/ops/overview',
    allowedRouteKeys: [
      RouteKeys.OPS_OVERVIEW,
      RouteKeys.OPS_TOILETS,
      RouteKeys.OPS_INSPECTIONS,
      RouteKeys.OPS_ALERTS,
      RouteKeys.OPS_TASKS,
      RouteKeys.OPS_REPORTS,
      RouteKeys.OPS_SENSORS,
      RouteKeys.OPS_COMPLAINTS,
      RouteKeys.OPS_PROFILE,
    ],
    allowedActionKeys: [
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
    allowedWidgetKeys: [...FACILITY_WIDGET_KEYS],
    allowedDataDomains: [
      'facility.dashboard',
      'facility.alerts',
      'facility.tasks',
      'facility.inspections',
      'facility.reports',
      'facility.sensors',
      'facility.complaints',
    ],
    permissionCodes: [...FACILITY_MANAGER_PERMISSION_CODES],
    readOnly: false,
    canAccessWeb: true,
    canAccessMobile: false,
  },

  [ROLE_CODES.SUPERVISOR]: {
    roleCode: ROLE_CODES.SUPERVISOR,
    roleType: RoleTypes.SUPERVISOR,
    personaFamily: PersonaFamilies.SUPERVISOR,
    hierarchyLevel: 80,
    surfaceType: SurfaceTypes.OPS_WEB_AND_MOBILE,

    scopeType: ScopeTypes.FACILITY,
    scopeLevel: ScopeLevels.FACILITY,
    managementLevel: ManagementLevels.FACILITY,
    primaryLandingRoute: '/ops/supervisor/overview',
    allowedRouteKeys: [

      RouteKeys.OPS_PROFILE,
      RouteKeys.SUPERVISOR_OVERVIEW,
      RouteKeys.SUPERVISOR_WORKERS,
      RouteKeys.SUPERVISOR_ATTENDANCE,
      RouteKeys.SUPERVISOR_LIVE_LOCATION,
      RouteKeys.SUPERVISOR_CHECKIN_CHECKOUT,
      RouteKeys.SUPERVISOR_DEVICE_HEALTH,
      RouteKeys.SUPERVISOR_WORK_PROGRESS,
      RouteKeys.SUPERVISOR_CLEANLINESS,
      RouteKeys.SUPERVISOR_ALERTS,
      RouteKeys.SUPERVISOR_REPORTS,
    ],
    allowedActionKeys: [

      'task.reassign',
      'supervisor.alerts.escalate',
      'cleanliness.verification.review',
    ],
    allowedWidgetKeys: [...SUPERVISOR_WIDGET_KEYS],
    allowedDataDomains: [

      'supervisor.workers',
      'supervisor.attendance',
      'supervisor.locations',
      'supervisor.checkins',
      'supervisor.device_health',
      'supervisor.work_progress',
      'supervisor.cleanliness',
      'supervisor.alerts',
      'supervisor.reports',
    ],
    permissionCodes: [...SUPERVISOR_PERMISSION_CODES],
    readOnly: false,
    canAccessWeb: true,
    canAccessMobile: true,
  },

  [ROLE_CODES.VIEWER]: {
    roleCode: ROLE_CODES.VIEWER,
    roleType: RoleTypes.VIEWER,
    personaFamily: PersonaFamilies.READ_ONLY,
    hierarchyLevel: 95,
    surfaceType: SurfaceTypes.OPS_WEB,
    scopeType: ScopeTypes.NONE,
    scopeLevel: ScopeLevels.ORGANIZATION,
    managementLevel: ManagementLevels.EXECUTION,
    primaryLandingRoute: '/ops/overview',
    allowedRouteKeys: [
      RouteKeys.OPS_OVERVIEW,
      RouteKeys.OPS_TOILETS,
      RouteKeys.OPS_ALERTS,
      RouteKeys.OPS_REPORTS,
      RouteKeys.OPS_PROFILE,
    ],
    allowedActionKeys: [],
    allowedWidgetKeys: [...READ_ONLY_WIDGET_KEYS],
    allowedDataDomains: ['read.dashboard', 'read.alerts', 'read.reports', 'read.inspections'],
    permissionCodes: [...VIEWER_PERMISSION_CODES],
    readOnly: true,
    canAccessWeb: true,
    canAccessMobile: false,
  },

  [ROLE_CODES.AUDITOR]: {
    roleCode: ROLE_CODES.AUDITOR,
    roleType: RoleTypes.AUDITOR,
    personaFamily: PersonaFamilies.READ_ONLY,
    hierarchyLevel: 90,
    surfaceType: SurfaceTypes.OPS_WEB,
    scopeType: ScopeTypes.NONE,
    scopeLevel: ScopeLevels.ORGANIZATION,
    managementLevel: ManagementLevels.EXECUTION,
    primaryLandingRoute: '/ops/auditor/dashboard',
    allowedRouteKeys: [
      RouteKeys.OPS_AUDITOR_DASHBOARD,
      RouteKeys.OPS_AUDITOR_AUDITS,
      RouteKeys.OPS_AUDITOR_ASSETS,
      RouteKeys.OPS_AUDITOR_MONITORING,
      RouteKeys.OPS_AUDITOR_ATTENDANCE,
      RouteKeys.OPS_AUDITOR_ALERTS,
      RouteKeys.OPS_AUDITOR_EVIDENCE,
      RouteKeys.OPS_AUDITOR_REPORTS,
      RouteKeys.OPS_PROFILE,
    ],
    allowedActionKeys: [],
    allowedWidgetKeys: [...READ_ONLY_WIDGET_KEYS, ...AUDITOR_WIDGET_KEYS],
    allowedDataDomains: [
      'read.dashboard',
      'read.reports',
      'audit.logs',
      'audit.compliance',
      'audit.inspection_trail',
      'audit.evidence',
      'audit.attendance',
    ],
    permissionCodes: [...AUDITOR_PERMISSION_CODES],
    readOnly: true,
    canAccessWeb: true,
    canAccessMobile: false,
  },

  [ROLE_CODES.FIELD_WORKER]: {
    roleCode: ROLE_CODES.FIELD_WORKER,
    roleType: RoleTypes.FIELD_WORKER,
    personaFamily: PersonaFamilies.FIELD_WORKER,
    hierarchyLevel: 100,
    surfaceType: SurfaceTypes.MOBILE_ONLY,
    scopeType: ScopeTypes.FACILITY,
    scopeLevel: ScopeLevels.FACILITY,
    managementLevel: ManagementLevels.EXECUTION,
    primaryLandingRoute: '/unauthorized',
    allowedRouteKeys: [
      RouteKeys.OPS_TOILETS,
      RouteKeys.OPS_INSPECTIONS,
      RouteKeys.OPS_TASKS,
      RouteKeys.OPS_COMPLAINTS,
      RouteKeys.OPS_PROFILE,
    ],
    allowedActionKeys: ['task.execute', 'inspection.create', 'issue.report', 'sync.offline'],
    allowedWidgetKeys: [
      'W_MOBILE_TASKS',
      'W_MOBILE_QR_SCAN',
      'W_MOBILE_INSPECTION_CAPTURE',
      'W_MOBILE_ISSUE_REPORT',
      'W_MOBILE_HISTORY',
      'W_MOBILE_SYNC',
    ],
    allowedDataDomains: [
      'worker.assigned_tasks',
      'worker.assigned_toilets',
      'worker.inspections',
      'worker.history',
    ],
    permissionCodes: [...FIELD_WORKER_PERMISSION_CODES],
    readOnly: false,
    canAccessWeb: false,
    canAccessMobile: true,
  },

  [ROLE_CODES.CONTRACTOR_MANAGER]: {
    roleCode: ROLE_CODES.CONTRACTOR_MANAGER,
    roleType: RoleTypes.LEGACY,
    personaFamily: PersonaFamilies.LEGACY_COMPAT,
    hierarchyLevel: 98,
    surfaceType: SurfaceTypes.OPS_WEB,
    scopeType: ScopeTypes.NONE,
    scopeLevel: ScopeLevels.ORGANIZATION,
    managementLevel: ManagementLevels.TENANT,
    primaryLandingRoute: '/ops/overview',
    allowedRouteKeys: [
      RouteKeys.OPS_OVERVIEW,
      RouteKeys.OPS_CONTRACTORS,
      RouteKeys.OPS_REPORTS,
      RouteKeys.OPS_PROFILE,
    ],
    allowedActionKeys: ['contractor.manage'],
    allowedWidgetKeys: ['W_CONTRACTOR_OVERVIEW', 'W_CONTRACTOR_SLA'],
    allowedDataDomains: ['contractor.performance', 'contractor.reports'],
    permissionCodes: ['auth.read', 'dashboard.read', 'reports.read'],
    readOnly: false,
    canAccessWeb: true,
    canAccessMobile: false,
  },
};

const UNKNOWN_ACCESS_ENTRY = {
  roleCode: null,
  roleType: RoleTypes.UNKNOWN,
  personaFamily: PersonaFamilies.UNKNOWN,
  hierarchyLevel: Number.MAX_SAFE_INTEGER,
  surfaceType: SurfaceTypes.OPS_WEB,
  scopeType: ScopeTypes.NONE,
  scopeLevel: ScopeLevels.ORGANIZATION,
  managementLevel: ManagementLevels.EXECUTION,
  primaryLandingRoute: '/unauthorized',
  allowedRouteKeys: [],
  allowedActionKeys: [],
  allowedWidgetKeys: [],
  allowedDataDomains: [],
  permissionCodes: [],
  readOnly: true,
  canAccessWeb: false,
  canAccessMobile: false,
};

const dedupeStrings = (values = []) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];

const dedupeRoleCodes = (roleCodes = []) =>
  [...new Set((Array.isArray(roleCodes) ? roleCodes : []).map((roleCode) => normalizeRoleCode(roleCode)).filter(Boolean))];

const expandRouteKeysToPaths = (routeKeys = []) => {
  const keys = dedupeStrings(routeKeys);
  return dedupeStrings(keys.flatMap((routeKey) => RouteKeyToPaths[routeKey] || []));
};

const resolvePrimaryRoleCode = ({ role = null, roleCodes = [] } = {}) => {
  const normalizedRole = normalizeRoleCode(role);
  if (normalizedRole) return normalizedRole;

  const normalizedCodes = dedupeRoleCodes(roleCodes);
  if (normalizedCodes.length === 0) return null;

  return [...normalizedCodes].sort((left, right) => {
    const leftRank = ROLE_PRIORITY.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = ROLE_PRIORITY.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  })[0];
};

const buildFamilyFallback = (roleCode) => {
  const family = getPersonaFamily(roleCode);
  if (family === PersonaFamilies.PLATFORM) return ROLE_ACCESS_MATRIX[ROLE_CODES.SUPER_ADMIN];
  if (family === PersonaFamilies.OPS_ADMIN) return ROLE_ACCESS_MATRIX[ROLE_CODES.TENANT_ADMIN];
  if (family === PersonaFamilies.SUPERVISOR) return ROLE_ACCESS_MATRIX[ROLE_CODES.SUPERVISOR];
  if (family === PersonaFamilies.READ_ONLY) return ROLE_ACCESS_MATRIX[ROLE_CODES.VIEWER];
  if (family === PersonaFamilies.FIELD_WORKER) return ROLE_ACCESS_MATRIX[ROLE_CODES.FIELD_WORKER];
  if (family === PersonaFamilies.LEGACY_COMPAT) return ROLE_ACCESS_MATRIX[ROLE_CODES.CONTRACTOR_MANAGER];
  return UNKNOWN_ACCESS_ENTRY;
};

const getRoleAccessEntry = (roleCode) => {
  const normalizedRoleCode = normalizeRoleCode(roleCode);
  return ROLE_ACCESS_MATRIX[normalizedRoleCode] || buildFamilyFallback(normalizedRoleCode);
};

const resolveRoleAccessProfile = ({ role = null, roleCodes = [] } = {}) => {
  const primaryRoleCode = resolvePrimaryRoleCode({ role, roleCodes });
  const normalizedRoleCodes = dedupeRoleCodes(roleCodes);
  const effectiveRoleCodes =
    normalizedRoleCodes.length > 0
      ? normalizedRoleCodes
      : primaryRoleCode
        ? [primaryRoleCode]
        : [];

  const entries =
    effectiveRoleCodes.length > 0
      ? effectiveRoleCodes.map((roleCode) => getRoleAccessEntry(roleCode))
      : [UNKNOWN_ACCESS_ENTRY];

  const base = getRoleAccessEntry(primaryRoleCode);

  const routeKeys = dedupeStrings(entries.flatMap((entry) => entry.allowedRouteKeys || []));
  const actionKeys = dedupeStrings(entries.flatMap((entry) => entry.allowedActionKeys || []));
  const widgetKeys = dedupeStrings(entries.flatMap((entry) => entry.allowedWidgetKeys || []));
  const allowedDataDomains = dedupeStrings(entries.flatMap((entry) => entry.allowedDataDomains || []));
  const permissionCodes = dedupeStrings(entries.flatMap((entry) => entry.permissionCodes || []));

  const canAccessWeb = entries.some((entry) => entry.canAccessWeb !== false);
  const canAccessMobile = entries.some((entry) => entry.canAccessMobile === true);

  return {
    role: primaryRoleCode,
    roleCodes: effectiveRoleCodes,
    roleType: base.roleType || RoleTypes.UNKNOWN,
    personaFamily: base.personaFamily || PersonaFamilies.UNKNOWN,
    hierarchyLevel: Number.isFinite(base.hierarchyLevel) ? base.hierarchyLevel : Number.MAX_SAFE_INTEGER,
    surfaceType: base.surfaceType || SurfaceTypes.OPS_WEB,
    scopeType: base.scopeType || ScopeTypes.NONE,
    scopeLevel: base.scopeLevel || ScopeLevels.ORGANIZATION,
    managementLevel: base.managementLevel || ManagementLevels.EXECUTION,
    primaryLandingRoute: base.primaryLandingRoute || '/unauthorized',
    routeKeys,
    actionKeys,
    widgetKeys,
    allowedDataDomains,
    permissionCodes,
    readOnly: entries.every((entry) => entry.readOnly === true),
    canAccessWeb,
    canAccessMobile,
    webEnabled: canAccessWeb,
    mobileOnly: !canAccessWeb && canAccessMobile,
    defaultRoute: base.primaryLandingRoute || '/unauthorized',
    allowedRoutes: expandRouteKeysToPaths(routeKeys),
    allowedActions: actionKeys,
  };
};

const ROLE_SCOPE_BY_ROLE_CODE = {
  [ROLE_CODES.TENANT_ADMIN]: ScopeLevels.ORGANIZATION,
  [ROLE_CODES.COUNTRY_ADMIN]: ScopeLevels.COUNTRY,
  [ROLE_CODES.STATE_ADMIN]: ScopeLevels.STATE,
  [ROLE_CODES.DISTRICT_ADMIN]: ScopeLevels.DISTRICT,
  [ROLE_CODES.CITY_ADMIN]: ScopeLevels.CITY,
  [ROLE_CODES.ZONE_ADMIN]: ScopeLevels.ZONE,
  [ROLE_CODES.FACILITY_MANAGER]: ScopeLevels.FACILITY,
  [ROLE_CODES.SUPERVISOR]: ScopeLevels.ZONE,
  [ROLE_CODES.FIELD_WORKER]: ScopeLevels.FACILITY,
};

const resolveScopedRoleLevel = (roleCode) => ROLE_SCOPE_BY_ROLE_CODE[normalizeRoleCode(roleCode)] || null;

const resolveSeedScopeFromMemberships = ({ roleCode, memberships = [], activeTenantId = null }) => {
  const membershipForRole = (Array.isArray(memberships) ? memberships : []).find(
    (membership) =>
      normalizeRoleCode(membership?.roleCode) === normalizeRoleCode(roleCode) &&
      (activeTenantId ? membership?.tenantId === activeTenantId : true),
  );
  return membershipForRole?.geographyId || null;
};

module.exports = {
  SurfaceTypes,
  ScopeTypes,
  ManagementLevels,
  ScopeLevels,
  RoleTypes,
  RouteKeys,
  RouteKeyToPaths,
  ROLE_PRIORITY,
  ROLE_ACCESS_MATRIX,
  UNKNOWN_ACCESS_ENTRY,
  dedupeRoleCodes,
  dedupeStrings,
  expandRouteKeysToPaths,
  resolvePrimaryRoleCode,
  getRoleAccessEntry,
  resolveRoleAccessProfile,
  resolveScopedRoleLevel,
  resolveSeedScopeFromMemberships,
};
