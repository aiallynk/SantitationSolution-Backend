const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const platformService = require('../src/modules/platform/platform.service');
const inspectionService = require('../src/modules/inspections/inspection.service');
const notificationService = require('../src/modules/notifications/notification.service');
const {
  Geography,
  sequelize,
  AuditLog,
  Facility,
  Inspection,
  InspectionEvent,
  InspectionMedia,
  InspectionSubmission,
  ToiletUnit,
} = require('../src/models');

const IDS = {
  tenant: '00000000-0000-0000-0000-000000000001',
  otherTenant: '00000000-0000-0000-0000-000000000002',
  globalCity: '00000000-0000-0000-0000-000000000101',
  legacyFacility: '00000000-0000-0000-0000-000000000201',
  otherLegacyFacility: '00000000-0000-0000-0000-000000000202',
  mappedFacility: '00000000-0000-0000-0000-000000000203',
};

const matchesWhere = (row, where = {}) => {
  for (const key of Reflect.ownKeys(where)) {
    const expected = where[key];
    if (key === Op.and) {
      if (!expected.every((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (key === Op.or) {
      if (!expected.some((clause) => matchesWhere(row, clause))) return false;
      continue;
    }
    if (expected && typeof expected === 'object' && Op.in in expected) {
      if (!expected[Op.in].map(String).includes(String(row[key] || ''))) return false;
      continue;
    }
    if (expected && typeof expected === 'object' && Op.is in expected) {
      if (row[key] !== expected[Op.is]) return false;
      continue;
    }
    if (String(row[key] || '') !== String(expected || '')) return false;
  }
  return true;
};

after(async () => {
  await sequelize.close();
});

test('live geography traversal follows parent and global/master compatibility edges in the same tenant', async (t) => {
  const originalFindAll = Geography.findAll;
  const originalQuery = sequelize.query;
  let capturedSql = '';
  let capturedReplacements = null;

  Geography.findAll = async () => [{
    id: IDS.globalCity,
    global_geography_id: null,
    master_geography_id: null,
  }];
  sequelize.query = async (sql, options) => {
    capturedSql = sql;
    capturedReplacements = options.replacements;
    return [{ id: IDS.globalCity }, { id: 'tenant-city-copy' }, { id: 'legacy-zone-child' }];
  };
  t.after(() => {
    Geography.findAll = originalFindAll;
    sequelize.query = originalQuery;
  });

  const ids = await platformService.__private.resolveLiveScopedGeographyIds({
    req: {
      user: {
        isSuperAdmin: false,
        tenantId: IDS.tenant,
        scopeGeographyIds: [IDS.globalCity],
      },
    },
    tenantId: IDS.tenant,
  });

  assert.deepEqual(ids, [IDS.globalCity, 'tenant-city-copy', 'legacy-zone-child']);
  assert.deepEqual(capturedReplacements, { seedIds: [IDS.globalCity], tenantId: IDS.tenant });
  assert.match(capturedSql, /child\.parent_id = parent\.id/);
  assert.match(capturedSql, /child\.global_geography_id = parent\.id/);
  assert.match(capturedSql, /child\.id = parent\.global_geography_id/);
  assert.match(capturedSql, /child\.tenant_id IS NULL OR child\.tenant_id = :tenantId/);
});

test('tenant-wide scope keeps geography-less legacy facilities visible while retaining tenant isolation', async () => {
  const where = await platformService.__private.buildFacilityIncludeScopeWhere({
    query: {},
    user: {
      isSuperAdmin: false,
      tenantId: IDS.tenant,
      scopeLevel: 'organization',
      scopeGeographyIds: [],
      scopeFacilityIds: [],
    },
  });

  assert.equal(where.tenant_id, IDS.tenant);
  assert.equal(where.geography_id, undefined);
  assert.deepEqual(where[Op.and], [{ tenant_id: IDS.tenant }]);
});

test('tenant-wide scope returns same-tenant legacy and mapped facilities, never another tenant legacy facility', async () => {
  const where = await platformService.__private.buildFacilityIncludeScopeWhere({
    query: {},
    user: {
      isSuperAdmin: false,
      tenantId: IDS.tenant,
      scopeLevel: 'organization',
      scopeGeographyIds: [],
      scopeFacilityIds: [],
    },
  });
  const facilities = [
    { id: IDS.legacyFacility, tenant_id: IDS.tenant, geography_id: null },
    { id: IDS.mappedFacility, tenant_id: IDS.tenant, geography_id: IDS.globalCity },
    { id: IDS.otherLegacyFacility, tenant_id: IDS.otherTenant, geography_id: null },
  ];

  assert.deepEqual(
    facilities.filter((facility) => matchesWhere(facility, where)).map((facility) => facility.id),
    [IDS.legacyFacility, IDS.mappedFacility],
  );
});

test('geography scope allows only resolved geography context, never a geography-less facility', async (t) => {
  const originalFindAll = Geography.findAll;
  const originalQuery = sequelize.query;
  Geography.findAll = async () => [{ id: IDS.globalCity, global_geography_id: null, master_geography_id: null }];
  sequelize.query = async () => [{ id: IDS.globalCity }, { id: 'tenant-city-copy' }];
  t.after(() => {
    Geography.findAll = originalFindAll;
    sequelize.query = originalQuery;
  });

  const where = await platformService.__private.buildFacilityIncludeScopeWhere({
    query: {},
    user: {
      isSuperAdmin: false,
      tenantId: IDS.tenant,
      scopeLevel: 'city',
      scopeGeographyIds: [IDS.globalCity],
      scopeFacilityIds: [],
    },
  });

  assert.equal(where.tenant_id, IDS.tenant);
  assert.deepEqual(where[Op.and][0], {
    geography_id: { [Op.in]: [IDS.globalCity, 'tenant-city-copy'] },
  });
  assert.deepEqual(where[Op.and][1], { tenant_id: IDS.tenant });
});

test('facility-scoped actor can use an explicitly assigned legacy facility without opening other legacy facilities', async (t) => {
  const originalFindAll = Geography.findAll;
  const originalQuery = sequelize.query;
  Geography.findAll = async () => [{ id: IDS.globalCity, global_geography_id: null, master_geography_id: null }];
  sequelize.query = async () => [{ id: IDS.globalCity }];
  t.after(() => {
    Geography.findAll = originalFindAll;
    sequelize.query = originalQuery;
  });

  const where = await platformService.__private.buildFacilityIncludeScopeWhere({
    query: {},
    user: {
      isSuperAdmin: false,
      tenantId: IDS.tenant,
      scopeLevel: 'facility',
      scopeGeographyIds: [IDS.globalCity],
      scopeFacilityIds: [IDS.legacyFacility],
    },
  });

  assert.equal(where.tenant_id, IDS.tenant);
  assert.deepEqual(where.id, { [Op.in]: [IDS.legacyFacility] });
  assert.deepEqual(where[Op.and][0], {
    [Op.or]: [
      { geography_id: { [Op.in]: [IDS.globalCity] } },
      { id: { [Op.in]: [IDS.legacyFacility] } },
    ],
  });
  assert.deepEqual(where[Op.and][1], { tenant_id: IDS.tenant });
});

test('facility-scoped branch excludes another same-tenant legacy facility and another tenant facility', async (t) => {
  const originalFindAll = Geography.findAll;
  const originalQuery = sequelize.query;
  Geography.findAll = async () => [{ id: IDS.globalCity, global_geography_id: null, master_geography_id: null }];
  sequelize.query = async () => [{ id: IDS.globalCity }];
  t.after(() => {
    Geography.findAll = originalFindAll;
    sequelize.query = originalQuery;
  });

  const where = await platformService.__private.buildFacilityIncludeScopeWhere({
    query: {},
    user: {
      isSuperAdmin: false,
      tenantId: IDS.tenant,
      scopeLevel: 'facility',
      scopeGeographyIds: [IDS.globalCity],
      scopeFacilityIds: [IDS.legacyFacility],
    },
  });
  const facilities = [
    { id: IDS.legacyFacility, tenant_id: IDS.tenant, geography_id: null },
    { id: IDS.mappedFacility, tenant_id: IDS.tenant, geography_id: IDS.globalCity },
    { id: IDS.otherLegacyFacility, tenant_id: IDS.tenant, geography_id: null },
    { id: IDS.legacyFacility, tenant_id: IDS.otherTenant, geography_id: null },
  ];

  assert.deepEqual(
    facilities.filter((facility) => matchesWhere(facility, where)).map((facility) => facility.id),
    [IDS.legacyFacility],
  );
});

test('legacy units with no block remain readable while deleted units stay excluded by the existing map lifecycle predicate', () => {
  const activeWhere = platformService.__private.activeToiletWhere();
  const units = [
    { id: 'legacy-no-block', toilet_block_id: null, deleted_at: null, status: 'active' },
    { id: 'legacy-inactive', toilet_block_id: null, deleted_at: null, status: 'out_of_service' },
    { id: 'legacy-deleted', toilet_block_id: null, deleted_at: '2026-01-01T00:00:00.000Z', status: 'active' },
  ];

  assert.deepEqual(
    units.filter((unit) => matchesWhere(unit, activeWhere)).map((unit) => unit.id),
    ['legacy-no-block', 'legacy-inactive'],
  );
});

test('field inspection creation preserves both legacy and mapped toilet references', async (t) => {
  const fixtures = [
    {
      label: 'legacy geography-less facility with no toilet block',
      facility: {
        id: IDS.legacyFacility,
        tenant_id: IDS.tenant,
        geography_id: null,
        latitude: 19.997,
        longitude: 73.789,
        status: 'active',
      },
      unit: {
        id: '00000000-0000-0000-0000-000000000301',
        facility_id: IDS.legacyFacility,
        toilet_block_id: null,
        status: 'active',
        deleted_at: null,
      },
    },
    {
      label: 'current geography-mapped facility with a toilet block',
      facility: {
        id: IDS.mappedFacility,
        tenant_id: IDS.tenant,
        geography_id: IDS.globalCity,
        latitude: 20.001,
        longitude: 73.795,
        status: 'active',
      },
      unit: {
        id: '00000000-0000-0000-0000-000000000302',
        facility_id: IDS.mappedFacility,
        toilet_block_id: '00000000-0000-0000-0000-000000000401',
        status: 'active',
        deleted_at: null,
      },
    },
  ];
  const created = [];
  const originals = {
    auditLogCreate: AuditLog.create,
    facilityFindByPk: Facility.findByPk,
    inspectionCreate: Inspection.create,
    inspectionFindAll: Inspection.findAll,
    inspectionEventCreate: InspectionEvent.create,
    inspectionMediaFindAll: InspectionMedia.findAll,
    inspectionSubmissionFindAll: InspectionSubmission.findAll,
    notificationPublishFromAuditLog: notificationService.publishFromAuditLog,
    toiletUnitFindByPk: ToiletUnit.findByPk,
  };

  AuditLog.create = async (values) => values;
  Facility.findByPk = async (id) =>
    fixtures.find((fixture) => fixture.facility.id === id)?.facility || null;
  Inspection.findAll = async () => [];
  InspectionMedia.findAll = async () => [];
  InspectionSubmission.findAll = async () => [];
  InspectionEvent.create = async (values) => values;
  ToiletUnit.findByPk = async (id) =>
    fixtures.find((fixture) => fixture.unit.id === id)?.unit || null;
  Inspection.create = async (values) => {
    created.push(values);
    return {
      id: `00000000-0000-0000-0000-0000000005${created.length}1`,
      ...values,
      InspectionMedia: [],
      inspectionSubmissions: [],
    };
  };
  notificationService.publishFromAuditLog = async () => [];
  t.after(() => {
    AuditLog.create = originals.auditLogCreate;
    Facility.findByPk = originals.facilityFindByPk;
    Inspection.create = originals.inspectionCreate;
    Inspection.findAll = originals.inspectionFindAll;
    InspectionEvent.create = originals.inspectionEventCreate;
    InspectionMedia.findAll = originals.inspectionMediaFindAll;
    InspectionSubmission.findAll = originals.inspectionSubmissionFindAll;
    notificationService.publishFromAuditLog = originals.notificationPublishFromAuditLog;
    ToiletUnit.findByPk = originals.toiletUnitFindByPk;
  });

  for (const fixture of fixtures) {
    const result = await inspectionService.createInspection({
      body: {
        facilityId: fixture.facility.id,
        toiletUnitId: fixture.unit.id,
        inspectionType: 'after',
        displayTimezone: 'Asia/Kolkata',
        capturedAtUtc: '2026-08-03T10:00:00.000Z',
      },
      user: {
        id: '00000000-0000-0000-0000-000000000601',
        tenantId: IDS.tenant,
        isSuperAdmin: false,
        roleCodes: ['field_worker'],
        scopeLevel: 'facility',
        scopeFacilityIds: [],
      },
      headers: {},
    });

    const persisted = created.at(-1);
    assert.equal(persisted.facility_id, fixture.facility.id, fixture.label);
    assert.equal(persisted.toilet_unit_id, fixture.unit.id, fixture.label);
    assert.equal(persisted.tenant_id, IDS.tenant, fixture.label);
    assert.equal(result.facilityId, fixture.facility.id, fixture.label);
    assert.equal(result.toiletUnitId, fixture.unit.id, fixture.label);
  }
});
