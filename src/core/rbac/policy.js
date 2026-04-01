const ROLE_CODES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  PLATFORM_OPS: 'platform_ops',
  TENANT_ADMIN: 'tenant_admin',
  STATE_ADMIN: 'state_admin',
  DISTRICT_ADMIN: 'district_admin',
  CITY_ADMIN: 'city_admin',
  ZONE_ADMIN: 'zone_admin',
  FACILITY_MANAGER: 'facility_manager',
  SUPERVISOR: 'supervisor',
  FIELD_WORKER: 'field_worker',
  CONTRACTOR_MANAGER: 'contractor_manager',
  VIEWER: 'viewer',
  AUDITOR: 'auditor',
  COUNTRY_ADMIN: 'country_admin',
});

const ALL_ACTIVE_ROLES = Object.freeze(Object.values(ROLE_CODES));

const APPROVAL_REQUIRED_ACTIONS = Object.freeze(
  new Set([
    'super_admin.tenant_provision',
    'super_admin.tenant_update',
    'super_admin.feature_flags_update',
    'super_admin.approval_update',
    'users.update',
  ])
);

// Scope/depth/action boundaries used by API and UI policy checks.
const ROLE_CAPABILITIES = Object.freeze({
  [ROLE_CODES.SUPER_ADMIN]: {
    scope: 'global',
    depth: 'detailed',
    actions: ['*'],
  },
  [ROLE_CODES.PLATFORM_OPS]: {
    scope: 'global_readonly',
    depth: 'detailed',
    actions: ['operate_system', 'view_all_telemetry', 'manage_integrations'],
  },
  [ROLE_CODES.TENANT_ADMIN]: {
    scope: 'tenant',
    depth: 'detailed',
    actions: ['manage_users', 'manage_assets', 'view_reports', 'manage_tasks'],
  },
  [ROLE_CODES.STATE_ADMIN]: {
    scope: 'state',
    depth: 'summary_and_drilldown',
    actions: ['view_reports', 'export_reports', 'view_alerts'],
  },
  [ROLE_CODES.DISTRICT_ADMIN]: {
    scope: 'district',
    depth: 'summary_and_drilldown',
    actions: ['view_reports', 'manage_alerts', 'assign_supervisors'],
  },
  [ROLE_CODES.CITY_ADMIN]: {
    scope: 'city',
    depth: 'summary_and_drilldown',
    actions: ['view_reports', 'manage_alerts', 'assign_supervisors'],
  },
  [ROLE_CODES.ZONE_ADMIN]: {
    scope: 'zone',
    depth: 'detailed',
    actions: ['view_alerts', 'view_inspections', 'trigger_escalations'],
  },
  [ROLE_CODES.CONTRACTOR_MANAGER]: {
    scope: 'assigned_assets',
    depth: 'detailed',
    actions: ['manage_tasks', 'manage_sla', 'assign_workers'],
  },
  [ROLE_CODES.SUPERVISOR]: {
    scope: 'assigned_facilities',
    depth: 'detailed',
    actions: ['review_inspections', 'override_ai_scores', 'manage_alerts'],
  },
  [ROLE_CODES.FACILITY_MANAGER]: {
    scope: 'facility',
    depth: 'detailed',
    actions: ['view_assets', 'view_inspections', 'manage_alerts', 'manage_tasks'],
  },
  [ROLE_CODES.FIELD_WORKER]: {
    scope: 'assigned_toilets',
    depth: 'task_only',
    actions: ['create_inspection', 'submit_inspection'],
  },
  [ROLE_CODES.AUDITOR]: {
    scope: 'tenant_readonly',
    depth: 'detailed_read_only',
    actions: ['view_audit', 'view_reports', 'export_reports'],
  },
  [ROLE_CODES.VIEWER]: {
    scope: 'tenant_readonly',
    depth: 'summary_read_only',
    actions: ['view_dashboard', 'view_reports'],
  },
});

module.exports = {
  ROLE_CODES,
  ALL_ACTIVE_ROLES,
  APPROVAL_REQUIRED_ACTIONS,
  ROLE_CAPABILITIES,
};
