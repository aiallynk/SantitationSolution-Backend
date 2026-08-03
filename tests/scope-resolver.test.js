const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { ScopeLevels } = require('../src/core/rbac/accessProfiles');
const {
  resolveEffectiveScope,
  expandDescendantGeographies,
} = require('../src/core/rbac/scopeResolver');
const { Geography, Facility, InspectionTask } = require('../src/models');

test('resolveEffectiveScope keeps assignment-based facility scope when assignments exist', async (t) => {
  const originalFindAll = InspectionTask.findAll;
  let called = false;
  InspectionTask.findAll = async () => {
    called = true;
    return [];
  };
  t.after(() => {
    InspectionTask.findAll = originalFindAll;
  });

  const scope = await resolveEffectiveScope({
    roleCode: 'field_worker',
    roleProfile: { scopeLevel: ScopeLevels.FACILITY },
    memberships: [],
    assignments: [
      {
        status: 'active',
        assignment_role: 'field_worker',
        facility_id: 'facility-assigned-1',
      },
    ],
    activeTenantId: 'tenant-1',
    userId: 'worker-1',
    fallbackGeographyId: null,
  });

  assert.equal(scope.scopeLevel, ScopeLevels.FACILITY);
  assert.deepEqual(scope.scopeFacilityIds, ['facility-assigned-1']);
  assert.equal(called, false);
});

test('resolveEffectiveScope falls back to task facilities when worker assignments are missing', async (t) => {
  const originalFindAll = InspectionTask.findAll;
  InspectionTask.findAll = async () => [
    { facility_id: 'facility-task-1' },
    { facility_id: 'facility-task-1' },
    { facility_id: 'facility-task-2' },
  ];
  t.after(() => {
    InspectionTask.findAll = originalFindAll;
  });

  const scope = await resolveEffectiveScope({
    roleCode: 'field_worker',
    roleProfile: { scopeLevel: ScopeLevels.FACILITY },
    memberships: [],
    assignments: [],
    activeTenantId: 'tenant-1',
    userId: 'worker-1',
    fallbackGeographyId: null,
  });

  assert.equal(scope.scopeLevel, ScopeLevels.FACILITY);
  assert.deepEqual(scope.scopeFacilityIds, ['facility-task-1', 'facility-task-2']);
  assert.equal(scope.scopeId, 'facility-task-1');
});

test('resolveEffectiveScope returns empty facility scope when no assignments and no tasks', async (t) => {
  const originalFindAll = InspectionTask.findAll;
  InspectionTask.findAll = async () => [];
  t.after(() => {
    InspectionTask.findAll = originalFindAll;
  });

  const scope = await resolveEffectiveScope({
    roleCode: 'field_worker',
    roleProfile: { scopeLevel: ScopeLevels.FACILITY },
    memberships: [],
    assignments: [],
    activeTenantId: 'tenant-1',
    userId: 'worker-2',
    fallbackGeographyId: null,
  });

  assert.equal(scope.scopeLevel, ScopeLevels.FACILITY);
  assert.deepEqual(scope.scopeFacilityIds, []);
  assert.equal(scope.scopeId, null);
});

test('resolveEffectiveScope derives facility scope from geography assignments for facility-scoped workers', async (t) => {
  const originalGeographyFindAll = Geography.findAll;
  const originalFacilityFindAll = Facility.findAll;
  const originalTaskFindAll = InspectionTask.findAll;
  let taskLookupCalled = false;

  Geography.findAll = async () => [
    { id: 'geo-zone-1', parent_id: null },
    { id: 'geo-ward-1', parent_id: 'geo-zone-1' },
  ];
  Facility.findAll = async () => [{ id: 'facility-1' }, { id: 'facility-2' }];
  InspectionTask.findAll = async () => {
    taskLookupCalled = true;
    return [];
  };

  t.after(() => {
    Geography.findAll = originalGeographyFindAll;
    Facility.findAll = originalFacilityFindAll;
    InspectionTask.findAll = originalTaskFindAll;
  });

  const scope = await resolveEffectiveScope({
    roleCode: 'field_worker',
    roleProfile: { scopeLevel: ScopeLevels.FACILITY },
    memberships: [],
    assignments: [
      {
        status: 'active',
        assignment_role: 'field_worker',
        geography_id: 'geo-zone-1',
      },
    ],
    activeTenantId: 'tenant-1',
    userId: 'worker-3',
    fallbackGeographyId: null,
  });

  assert.equal(scope.scopeLevel, ScopeLevels.FACILITY);
  assert.deepEqual(scope.scopeGeographyIds, ['geo-zone-1', 'geo-ward-1']);
  assert.deepEqual(scope.scopeFacilityIds, ['facility-1', 'facility-2']);
  assert.equal(scope.scopeId, 'facility-1');
  assert.equal(taskLookupCalled, false);
});

test('resolveEffectiveScope geography facility lookup matches geography, zone, and ward mapped facilities', async (t) => {
  const originalGeographyFindAll = Geography.findAll;
  const originalFacilityFindAll = Facility.findAll;
  const originalTaskFindAll = InspectionTask.findAll;
  let capturedWhere = null;

  Geography.findAll = async () => [
    { id: 'geo-zone-1', parent_id: null },
  ];
  Facility.findAll = async ({ where }) => {
    capturedWhere = where;
    return [{ id: 'facility-zone-mapped' }];
  };
  InspectionTask.findAll = async () => [];

  t.after(() => {
    Geography.findAll = originalGeographyFindAll;
    Facility.findAll = originalFacilityFindAll;
    InspectionTask.findAll = originalTaskFindAll;
  });

  const scope = await resolveEffectiveScope({
    roleCode: 'field_worker',
    roleProfile: { scopeLevel: ScopeLevels.FACILITY },
    memberships: [],
    assignments: [
      {
        status: 'active',
        assignment_role: 'field_worker',
        geography_id: 'geo-zone-1',
      },
    ],
    activeTenantId: 'tenant-1',
    userId: 'worker-4',
    fallbackGeographyId: null,
  });

  assert.equal(scope.scopeLevel, ScopeLevels.FACILITY);
  assert.deepEqual(scope.scopeFacilityIds, ['facility-zone-mapped']);
  assert.ok(capturedWhere, 'facility lookup should build a where clause');
  assert.equal(capturedWhere.tenant_id, 'tenant-1');
  assert.ok(Array.isArray(capturedWhere[Op.or]), 'facility lookup should use OR geography mapping');
  assert.equal(capturedWhere[Op.or].length, 3);
});

test('geography traversal follows same-tenant global/master identity links without loading another tenant', async (t) => {
  const originalGeographyFindAll = Geography.findAll;
  let capturedWhere = null;

  Geography.findAll = async ({ where }) => {
    capturedWhere = where;
    return [
      { id: 'global-state-1', parent_id: null, global_geography_id: null, master_geography_id: null },
      {
        id: 'tenant-state-1',
        parent_id: null,
        global_geography_id: 'global-state-1',
        master_geography_id: 'global-state-1',
      },
      {
        id: 'tenant-city-1',
        parent_id: 'tenant-state-1',
        global_geography_id: null,
        master_geography_id: null,
      },
    ];
  };

  t.after(() => {
    Geography.findAll = originalGeographyFindAll;
  });

  const ids = await expandDescendantGeographies({
    tenantId: 'tenant-1',
    seedGeographyIds: ['global-state-1'],
  });

  assert.deepEqual(ids, ['global-state-1', 'tenant-state-1', 'tenant-city-1']);
  assert.equal(capturedWhere.is_active, true);
  assert.equal(capturedWhere[Op.or].length, 2);
});

test('geography-scoped role does not receive geography-less legacy facilities through name matching', async (t) => {
  const originalGeographyFindAll = Geography.findAll;
  const originalFacilityFindAll = Facility.findAll;

  Geography.findAll = async () => [{ id: 'geo-state-1', parent_id: null }];
  Facility.findAll = async () => [];

  t.after(() => {
    Geography.findAll = originalGeographyFindAll;
    Facility.findAll = originalFacilityFindAll;
  });

  const scope = await resolveEffectiveScope({
    roleCode: 'state_admin',
    roleProfile: { scopeLevel: ScopeLevels.STATE },
    memberships: [
      {
        roleCode: 'state_admin',
        tenantId: 'tenant-1',
        geographyId: 'geo-state-1',
      },
    ],
    assignments: [],
    activeTenantId: 'tenant-1',
    userId: 'state-admin-1',
    scopeLocationNames: {
      countryName: 'India',
      stateName: 'Maharashtra',
    },
  });

  assert.equal(scope.scopeLevel, ScopeLevels.STATE);
  assert.deepEqual(scope.scopeFacilityIds, []);
});
