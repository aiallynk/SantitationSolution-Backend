const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assertRoleDelegationAllowed,
  collectRoleDelegationErrors,
} = require('../src/core/rbac/roleDelegationRules');

test('super admin can assign any role including platform/global roles', () => {
  const errors = collectRoleDelegationErrors({
    actorRoleCodes: ['super_admin'],
    targetRoleCodes: ['super_admin', 'tenant_admin', 'state_admin'],
    isSuperAdmin: true,
  });
  assert.equal(errors.length, 0);
});

test('scoped ops admin cannot assign higher-scope roles', () => {
  const errors = collectRoleDelegationErrors({
    actorRoleCodes: ['state_admin'],
    targetRoleCodes: ['country_admin', 'tenant_admin'],
    isSuperAdmin: false,
  });
  assert.equal(errors.length > 0, true);
  assert.equal(errors[0].includes('country_admin'), true);
  assert.equal(errors[0].includes('tenant_admin'), true);
});

test('scoped ops admin can assign same or lower scope roles', () => {
  const errors = collectRoleDelegationErrors({
    actorRoleCodes: ['state_admin'],
    targetRoleCodes: ['state_admin', 'district_admin', 'city_admin', 'field_worker'],
    isSuperAdmin: false,
  });
  assert.equal(errors.length, 0);
});

test('role delegation assertion throws with explicit forbidden code', () => {
  assert.throws(
    () =>
      assertRoleDelegationAllowed({
        actorRoleCodes: ['city_admin'],
        targetRoleCodes: ['tenant_admin'],
        isSuperAdmin: false,
      }),
    (error) => error?.code === 'ROLE_DELEGATION_FORBIDDEN'
  );
});
