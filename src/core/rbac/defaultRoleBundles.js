const TENANT_ADMIN_BASE_PERMISSIONS = [
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

const VIEWER_BASE_PERMISSIONS = ['auth.read', 'dashboard.read', 'reports.read'];

const ROLE_PERMISSION_BUNDLES = {
  super_admin: [
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
  tenant_admin: [...TENANT_ADMIN_BASE_PERMISSIONS],
  country_admin: [...TENANT_ADMIN_BASE_PERMISSIONS],
  state_admin: [...TENANT_ADMIN_BASE_PERMISSIONS],
  district_admin: [...TENANT_ADMIN_BASE_PERMISSIONS],
  city_admin: [...TENANT_ADMIN_BASE_PERMISSIONS],
  zone_admin: [...TENANT_ADMIN_BASE_PERMISSIONS],
  facility_manager: [...TENANT_ADMIN_BASE_PERMISSIONS],
  supervisor: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'reports.read',
  ],
  field_worker: ['auth.read', 'inspection.create', 'dashboard.read'],
  viewer: [...VIEWER_BASE_PERMISSIONS],
  auditor: [...VIEWER_BASE_PERMISSIONS, 'audit.read'],
};

module.exports = {
  TENANT_ADMIN_BASE_PERMISSIONS,
  VIEWER_BASE_PERMISSIONS,
  ROLE_PERMISSION_BUNDLES,
};
