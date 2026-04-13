const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PersonaFamilies,
  getPersonaFamily,
  getRequiredScopeType,
} = require('../src/core/rbac/personaFamilies');
const { resolvePrimaryRoleCode } = require('../src/core/rbac/accessProfiles');
const { resolveRoleAccessProfile, RouteKeys } = require('../src/core/rbac/accessMatrix');
const { ROLE_PERMISSION_BUNDLES } = require('../src/core/rbac/defaultRoleBundles');
const { collectRoleScopeValidationErrors } = require('../src/core/rbac/roleScopeRules');

test('maps role codes to persona families', () => {
  assert.equal(getPersonaFamily('super_admin'), PersonaFamilies.PLATFORM);
  assert.equal(getPersonaFamily('tenant_admin'), PersonaFamilies.OPS_ADMIN);
  assert.equal(getPersonaFamily('supervisor'), PersonaFamilies.SUPERVISOR);
  assert.equal(getPersonaFamily('viewer'), PersonaFamilies.READ_ONLY);
  assert.equal(getPersonaFamily('field_worker'), PersonaFamilies.FIELD_WORKER);
  assert.equal(getPersonaFamily('platform_ops'), PersonaFamilies.LEGACY_COMPAT);
});

test('role bundles keep geography admins aligned and enforce facility/supervisor hierarchy limits', () => {
  const scopedRoles = ['country_admin', 'state_admin', 'district_admin', 'city_admin', 'zone_admin'];
  const tenantAdminPermissions = ROLE_PERMISSION_BUNDLES.tenant_admin;
  assert.equal(tenantAdminPermissions.includes('task.manage'), true);
  assert.equal(tenantAdminPermissions.includes('users.manage'), true);

  scopedRoles.forEach((roleCode) => {
    assert.deepEqual(ROLE_PERMISSION_BUNDLES[roleCode], tenantAdminPermissions);
  });

  assert.equal(ROLE_PERMISSION_BUNDLES.facility_manager.includes('users.manage'), false);
  assert.equal(ROLE_PERMISSION_BUNDLES.facility_manager.includes('audit.read'), false);
  assert.equal(ROLE_PERMISSION_BUNDLES.supervisor.includes('users.manage'), false);
  assert.equal(ROLE_PERMISSION_BUNDLES.supervisor.includes('audit.read'), false);

  assert.equal(ROLE_PERMISSION_BUNDLES.auditor.includes('audit.read'), true);
  assert.equal(ROLE_PERMISSION_BUNDLES.auditor.includes('task.manage'), false);
});

test('scope rules enforce scoped role requirements', () => {
  assert.equal(getRequiredScopeType('city_admin'), 'geography');
  assert.equal(getRequiredScopeType('facility_manager'), 'facility');
  assert.equal(getRequiredScopeType('supervisor'), 'facility');
  assert.equal(getRequiredScopeType('field_worker'), 'facility');

  const missingCityScope = collectRoleScopeValidationErrors({
    roleCodes: ['city_admin'],
    geographyId: null,
    assignments: [],
  });
  assert.equal(missingCityScope.length > 0, true);

  const validFacilityScope = collectRoleScopeValidationErrors({
    roleCodes: ['facility_manager'],
    geographyId: null,
    assignments: [{ assignmentLevel: 'facility', facilityId: 'facility-1' }],
  });
  assert.equal(validFacilityScope.length, 0);
  const missingSupervisorFacilityScope = collectRoleScopeValidationErrors({
    roleCodes: ['supervisor'],
    geographyId: null,
    assignments: [],
  });
  assert.equal(missingSupervisorFacilityScope.length > 0, true);
});

test('role access profile resolves strict route, widget, and action keys for supervisors', () => {
  const profile = resolveRoleAccessProfile({
    roleCodes: ['supervisor'],
  });

  assert.equal(profile.routeKeys.includes(RouteKeys.OPS_USERS), false);
  assert.equal(profile.routeKeys.includes(RouteKeys.OPS_ADMINOPS), false);
  assert.equal(profile.routeKeys.includes(RouteKeys.OPS_SETTINGS), false);
  assert.equal(profile.routeKeys.includes(RouteKeys.OPS_OVERVIEW), true);
  assert.equal(profile.actionKeys.includes('task.assign'), true);
  assert.equal(profile.actionKeys.includes('user.manage'), false);
  assert.equal(profile.widgetKeys.includes('W_WORKER_PRODUCTIVITY'), true);
});

test('primary role resolution prefers web persona over field_worker when both exist', () => {
  const role = resolvePrimaryRoleCode({
    roleCodes: ['field_worker', 'supervisor'],
  });
  assert.equal(role, 'supervisor');
});
