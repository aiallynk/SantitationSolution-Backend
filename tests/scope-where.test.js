const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const {
  applyTenantScope,
  applyFacilityScope,
  isFacilityInScope,
} = require('../src/core/rbac/scopeWhere');

test('applyTenantScope applies authenticated tenant for non-super-admin users', () => {
  const where = applyTenantScope({}, { user: { isSuperAdmin: false, tenantId: 'tenant-1' } });
  assert.equal(where.tenant_id, 'tenant-1');
});

test('applyFacilityScope constrains facility_id when scoped facility ids exist', () => {
  const where = applyFacilityScope(
    {},
    { user: { isSuperAdmin: false, scopeFacilityIds: ['fac-1', 'fac-2'], scopeLevel: 'facility' } }
  );
  assert.deepEqual(where.facility_id, { [Op.in]: ['fac-1', 'fac-2'] });
});

test('isFacilityInScope returns false for out-of-scope facility ids', () => {
  const req = { user: { isSuperAdmin: false, scopeFacilityIds: ['fac-1'], scopeLevel: 'facility' } };
  assert.equal(isFacilityInScope(req, 'fac-2'), false);
  assert.equal(isFacilityInScope(req, 'fac-1'), true);
});
