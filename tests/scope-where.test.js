const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const {
  applyTenantScope,
  applyFacilityScope,
  isFacilityInScope,
  isFacilityAccessibleForInspection,
  buildAccessContextFromUser,
  applyScopeToQuery,
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

test('isFacilityInScope fails closed for a geography-scoped actor with no authorised facilities', () => {
  const req = {
    user: {
      isSuperAdmin: false,
      scopeFacilityIds: [],
      scopeLevel: 'city',
    },
  };
  assert.equal(isFacilityInScope(req, 'legacy-facility-without-geography'), false);
});

test('applyScopeToQuery enforces facility scope for supervisor access context', () => {
  const accessContext = buildAccessContextFromUser({
    role: 'supervisor',
    roleCodes: ['supervisor'],
    tenantId: 'tenant-1',
    scopeLevel: 'facility',
    scopeFacilityIds: ['fac-1'],
    permissions: ['dashboard.read'],
  });

  const scoped = applyScopeToQuery({}, accessContext, 'dashboard');
  assert.equal(scoped.tenant_id, 'tenant-1');
  assert.deepEqual(scoped.facility_id, { [Op.in]: ['fac-1'] });
});

test('isFacilityAccessibleForInspection allows field workers within tenant', () => {
  const req = {
    user: {
      isSuperAdmin: false,
      tenantId: 'tenant-1',
      roleCodes: ['field_worker'],
      scopeFacilityIds: ['fac-1'],
      scopeLevel: 'facility',
    },
  };
  assert.equal(
    isFacilityAccessibleForInspection(req, 'fac-2', { facilityTenantId: 'tenant-1' }),
    true
  );
  assert.equal(
    isFacilityAccessibleForInspection(req, 'fac-2', { facilityTenantId: 'tenant-2' }),
    false
  );
});

test('isFacilityAccessibleForInspection keeps strict scope for non-field roles', () => {
  const req = {
    user: {
      isSuperAdmin: false,
      tenantId: 'tenant-1',
      roleCodes: ['supervisor'],
      scopeFacilityIds: ['fac-1'],
      scopeLevel: 'facility',
    },
  };
  assert.equal(
    isFacilityAccessibleForInspection(req, 'fac-2', { facilityTenantId: 'tenant-1' }),
    false
  );
});

test('applyScopeToQuery blocks facility-scoped actors without facility assignments', () => {
  const accessContext = buildAccessContextFromUser({
    role: 'supervisor',
    roleCodes: ['supervisor'],
    tenantId: 'tenant-1',
    scopeLevel: 'facility',
    scopeFacilityIds: [],
  });

  const scoped = applyScopeToQuery({}, accessContext, 'task');
  assert.equal(scoped.tenant_id, 'tenant-1');
  assert.equal(scoped.facility_id, '00000000-0000-0000-0000-000000000000');
});
