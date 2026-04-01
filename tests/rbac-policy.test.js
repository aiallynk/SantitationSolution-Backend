const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ROLE_CODES,
  ALL_ACTIVE_ROLES,
  APPROVAL_REQUIRED_ACTIONS,
  ROLE_CAPABILITIES,
} = require('../src/core/rbac/policy');

test('rbac policy excludes country_admin from active roles', () => {
  assert.equal(ALL_ACTIVE_ROLES.includes('country_admin'), false);
});

test('rbac policy includes all required governance roles', () => {
  const required = [
    ROLE_CODES.AUDITOR,
    ROLE_CODES.CITY_ADMIN,
    ROLE_CODES.CONTRACTOR_MANAGER,
    ROLE_CODES.DISTRICT_ADMIN,
    ROLE_CODES.FACILITY_MANAGER,
    ROLE_CODES.FIELD_WORKER,
    ROLE_CODES.PLATFORM_OPS,
    ROLE_CODES.STATE_ADMIN,
    ROLE_CODES.SUPER_ADMIN,
    ROLE_CODES.SUPERVISOR,
    ROLE_CODES.TENANT_ADMIN,
    ROLE_CODES.VIEWER,
    ROLE_CODES.ZONE_ADMIN,
  ];
  required.forEach((role) => assert.equal(ALL_ACTIVE_ROLES.includes(role), true));
});

test('field worker has task-only depth', () => {
  assert.equal(ROLE_CAPABILITIES[ROLE_CODES.FIELD_WORKER].depth, 'task_only');
});

test('critical governance actions are marked approval-required', () => {
  assert.equal(APPROVAL_REQUIRED_ACTIONS.has('super_admin.tenant_provision'), true);
  assert.equal(APPROVAL_REQUIRED_ACTIONS.has('super_admin.tenant_update'), true);
});
