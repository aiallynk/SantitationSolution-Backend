const test = require('node:test');
const assert = require('node:assert/strict');

const { ScopeLevels } = require('../src/core/rbac/accessProfiles');
const { resolveEffectiveScope } = require('../src/core/rbac/scopeResolver');
const { InspectionTask } = require('../src/models');

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
