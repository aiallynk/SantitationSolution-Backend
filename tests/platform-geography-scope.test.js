const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const platformService = require('../src/modules/platform/platform.service');
const { Geography, Tenant, sequelize } = require('../src/models');

after(async () => {
  await sequelize.close();
});

const IDS = {
  globalDistrict1: '00000000-0000-0000-0000-000000000101',
  globalDistrict2: '00000000-0000-0000-0000-000000000102',
  globalState1: '00000000-0000-0000-0000-000000000201',
  globalStateUs1: '00000000-0000-0000-0000-000000000202',
  globalCountryIndia: '00000000-0000-0000-0000-000000000301',
  globalCountryUsa: '00000000-0000-0000-0000-000000000302',
  globalStateGujarat: '00000000-0000-0000-0000-000000000401',
  tenantDistrict1: '10000000-0000-0000-0000-000000000101',
  tenantState1: '10000000-0000-0000-0000-000000000201',
  tenantStateUs1: '10000000-0000-0000-0000-000000000202',
  bareState1: '20000000-0000-0000-0000-000000000001',
};

test('district-scoped actor can access child global city options through canonical geography mapping', async (t) => {
  const originalFindByPk = Geography.findByPk;

  const rowsById = new Map([
    [IDS.globalDistrict1, {
      id: IDS.globalDistrict1,
      parent_id: IDS.globalState1,
      tenant_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
    [IDS.globalState1, {
      id: IDS.globalState1,
      parent_id: null,
      tenant_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
    [IDS.tenantDistrict1, {
      id: IDS.tenantDistrict1,
      parent_id: IDS.tenantState1,
      tenant_id: 'tenant-1',
      is_active: true,
      global_geography_id: IDS.globalDistrict1,
      master_geography_id: IDS.globalDistrict1,
    }],
    [IDS.tenantState1, {
      id: IDS.tenantState1,
      parent_id: null,
      tenant_id: 'tenant-1',
      is_active: true,
      global_geography_id: IDS.globalState1,
      master_geography_id: IDS.globalState1,
    }],
  ]);

  Geography.findByPk = async (id) => rowsById.get(String(id)) || null;
  t.after(() => {
    Geography.findByPk = originalFindByPk;
  });

  const allowed = await platformService.__private.isGeographyInLiveScope(
    {
      user: {
        isSuperAdmin: false,
        scopeGeographyIds: [IDS.tenantDistrict1],
      },
    },
    IDS.globalDistrict1,
    { tenantId: 'tenant-1' }
  );

  assert.equal(allowed, true);
});

test('district-scoped actor cannot access sibling global district through canonical geography mapping', async (t) => {
  const originalFindByPk = Geography.findByPk;

  const rowsById = new Map([
    [IDS.globalDistrict2, {
      id: IDS.globalDistrict2,
      parent_id: IDS.globalState1,
      tenant_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
    [IDS.tenantDistrict1, {
      id: IDS.tenantDistrict1,
      parent_id: IDS.tenantState1,
      tenant_id: 'tenant-1',
      is_active: true,
      global_geography_id: IDS.globalDistrict1,
      master_geography_id: IDS.globalDistrict1,
    }],
    [IDS.tenantState1, {
      id: IDS.tenantState1,
      parent_id: null,
      tenant_id: 'tenant-1',
      is_active: true,
      global_geography_id: IDS.globalState1,
      master_geography_id: IDS.globalState1,
    }],
    [IDS.globalState1, {
      id: IDS.globalState1,
      parent_id: null,
      tenant_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
  ]);

  Geography.findByPk = async (id) => rowsById.get(String(id)) || null;
  t.after(() => {
    Geography.findByPk = originalFindByPk;
  });

  const allowed = await platformService.__private.isGeographyInLiveScope(
    {
      user: {
        isSuperAdmin: false,
        scopeGeographyIds: [IDS.tenantDistrict1],
      },
    },
    IDS.globalDistrict2,
    { tenantId: 'tenant-1' }
  );

  assert.equal(allowed, false);
});

test('canonical platform parent resolution maps tenant copies back to platform geography ids', async (t) => {
  const originalFindByPk = Geography.findByPk;
  const originalFindOne = Geography.findOne;

  const rowsById = new Map([
    [IDS.tenantState1, {
      id: IDS.tenantState1,
      parent_id: null,
      tenant_id: 'tenant-1',
      level: 'state',
      normalized_name: 'karnataka',
      global_geography_id: IDS.globalState1,
      master_geography_id: IDS.globalState1,
    }],
    [IDS.tenantDistrict1, {
      id: IDS.tenantDistrict1,
      parent_id: IDS.tenantState1,
      tenant_id: 'tenant-1',
      level: 'district',
      normalized_name: 'belagavi',
      global_geography_id: null,
      master_geography_id: null,
    }],
    [IDS.globalState1, {
      id: IDS.globalState1,
      parent_id: null,
      tenant_id: null,
      level: 'state',
      normalized_name: 'karnataka',
      global_geography_id: null,
      master_geography_id: null,
    }],
  ]);

  Geography.findByPk = async (id) => rowsById.get(String(id)) || null;
  Geography.findOne = async ({ where }) => {
    if (
      where?.tenant_id === null &&
      where?.level === 'district' &&
      where?.normalized_name === 'belagavi' &&
      where?.parent_id === IDS.globalState1
    ) {
      return { id: IDS.globalDistrict1 };
    }
    return null;
  };

  t.after(() => {
    Geography.findByPk = originalFindByPk;
    Geography.findOne = originalFindOne;
  });

  const resolved = await platformService.__private.resolveCanonicalPlatformParentId(IDS.tenantDistrict1);
  assert.equal(resolved, IDS.globalDistrict1);
});

test('live scope seed resolution falls back to geographyId and scopeId when scopeGeographyIds are absent', async (t) => {
  const originalFindByPk = Geography.findByPk;
  const originalTenantFindByPk = require('../src/models').Tenant.findByPk;
  const { Tenant } = require('../src/models');

  Geography.findByPk = async (id) => ({
    id: String(id),
    parent_id: null,
    tenant_id: null,
    is_active: true,
    global_geography_id: null,
    master_geography_id: null,
  });
  Tenant.findByPk = async () => null;

  t.after(() => {
    Geography.findByPk = originalFindByPk;
    Tenant.findByPk = originalTenantFindByPk;
  });

  const seeds = await platformService.__private.resolveLiveScopeSeedIds({
    req: {
      user: {
        isSuperAdmin: false,
        geographyId: IDS.bareState1,
        scopeId: IDS.bareState1,
      },
    },
    tenantId: 'tenant-1',
  });

  assert.deepEqual(seeds, [IDS.bareState1]);
});

test('country options include canonical India for scoped tenant copies', async (t) => {
  const originalFindByPk = Geography.findByPk;
  const originalFindAndCountAll = Geography.findAndCountAll;

  const rowsById = new Map([
    [IDS.tenantState1, {
      id: IDS.tenantState1,
      parent_id: null,
      is_active: true,
      global_geography_id: IDS.globalState1,
      master_geography_id: IDS.globalState1,
    }],
    [IDS.globalState1, {
      id: IDS.globalState1,
      parent_id: IDS.globalCountryIndia,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
    [IDS.globalCountryIndia, {
      id: IDS.globalCountryIndia,
      parent_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
  ]);

  Geography.findByPk = async (id) => rowsById.get(String(id)) || null;
  Geography.findAndCountAll = async ({ where }) => {
    assert.equal(where.level, 'country');
    assert.deepEqual(where.id, { [Op.in]: [IDS.tenantState1, IDS.globalState1, IDS.globalCountryIndia] });
    return {
      rows: [{
        id: IDS.globalCountryIndia,
        parent_id: null,
        tenant_id: null,
        level: 'country',
        name: 'India',
        code: 'IN',
        country_code: 'IN',
        location_status: 'mapped',
        is_active: true,
        is_platform_managed: true,
      }],
      count: 1,
    };
  };

  t.after(() => {
    Geography.findByPk = originalFindByPk;
    Geography.findAndCountAll = originalFindAndCountAll;
  });

  const result = await platformService.listGlobalGeographyOptions({
    query: { level: 'country', activeOnly: 'true' },
    user: {
      isSuperAdmin: false,
      tenantId: 'tenant-1',
      scopeGeographyIds: [IDS.tenantState1],
    },
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].name, 'India');
  assert.equal(result.items[0].countryIso2, 'IN');
});

test('state options load only active direct children for the selected country', async (t) => {
  const originalFindByPk = Geography.findByPk;
  const originalFindAndCountAll = Geography.findAndCountAll;

  const rowsById = new Map([
    [IDS.tenantState1, {
      id: IDS.tenantState1,
      parent_id: null,
      tenant_id: 'tenant-1',
      is_active: true,
      global_geography_id: IDS.globalStateGujarat,
      master_geography_id: IDS.globalStateGujarat,
    }],
    [IDS.globalStateGujarat, {
      id: IDS.globalStateGujarat,
      parent_id: IDS.globalCountryIndia,
      tenant_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
    [IDS.globalCountryIndia, {
      id: IDS.globalCountryIndia,
      parent_id: null,
      tenant_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
  ]);

  Geography.findByPk = async (id) => rowsById.get(String(id)) || null;
  Geography.findAndCountAll = async ({ where }) => {
    assert.equal(where.level, 'state');
    assert.equal(where.parent_id, IDS.globalCountryIndia);
    assert.equal(where.is_active, true);
    return {
      rows: [{
        id: IDS.globalStateGujarat,
        parent_id: IDS.globalCountryIndia,
        tenant_id: null,
        level: 'state',
        name: 'Gujarat',
        code: 'GJ',
        country_code: 'IN',
        location_status: 'mapped',
        is_active: true,
        is_platform_managed: true,
      }],
      count: 1,
    };
  };

  t.after(() => {
    Geography.findByPk = originalFindByPk;
    Geography.findAndCountAll = originalFindAndCountAll;
  });

  const result = await platformService.listGlobalGeographyOptions({
    query: {
      level: 'state',
      parentId: IDS.globalCountryIndia,
      activeOnly: 'true',
      countryIso2: 'IN',
    },
    user: {
      isSuperAdmin: false,
      tenantId: 'tenant-1',
      scopeGeographyIds: [IDS.tenantState1],
    },
  });

  assert.deepEqual(result.items.map((item) => item.name), ['Gujarat']);
  assert.equal(result.items[0].parentId, IDS.globalCountryIndia);
});

test('country options still enforce scope restrictions for sibling countries', async (t) => {
  const originalFindByPk = Geography.findByPk;
  const originalFindAndCountAll = Geography.findAndCountAll;

  const rowsById = new Map([
    [IDS.tenantStateUs1, {
      id: IDS.tenantStateUs1,
      parent_id: null,
      is_active: true,
      global_geography_id: IDS.globalStateUs1,
      master_geography_id: IDS.globalStateUs1,
    }],
    [IDS.globalStateUs1, {
      id: IDS.globalStateUs1,
      parent_id: IDS.globalCountryUsa,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
    [IDS.globalCountryUsa, {
      id: IDS.globalCountryUsa,
      parent_id: null,
      is_active: true,
      global_geography_id: null,
      master_geography_id: null,
    }],
  ]);

  Geography.findByPk = async (id) => rowsById.get(String(id)) || null;
  Geography.findAndCountAll = async ({ where }) => {
    assert.deepEqual(where.id, { [Op.in]: [IDS.tenantStateUs1, IDS.globalStateUs1, IDS.globalCountryUsa] });
    return {
      rows: [{
        id: IDS.globalCountryUsa,
        parent_id: null,
        tenant_id: null,
        level: 'country',
        name: 'United States',
        code: 'US',
        country_code: 'US',
        location_status: 'mapped',
        is_active: true,
        is_platform_managed: true,
      }],
      count: 1,
    };
  };

  t.after(() => {
    Geography.findByPk = originalFindByPk;
    Geography.findAndCountAll = originalFindAndCountAll;
  });

  const result = await platformService.listGlobalGeographyOptions({
    query: { level: 'country', activeOnly: 'true' },
    user: {
      isSuperAdmin: false,
      tenantId: 'tenant-us',
      scopeGeographyIds: [IDS.tenantStateUs1],
    },
  });

  assert.deepEqual(result.items.map((item) => item.name), ['United States']);
});

test('country options fall back to tenant and actor location names when root geography is missing', async (t) => {
  const originalTenantFindByPk = Tenant.findByPk;
  const originalGeographyFindByPk = Geography.findByPk;
  const originalGeographyFindOne = Geography.findOne;
  const originalGeographyFindAndCountAll = Geography.findAndCountAll;

  const rowsById = new Map([
    [IDS.globalCountryIndia, { id: IDS.globalCountryIndia, parent_id: null, is_active: true, global_geography_id: null, master_geography_id: null }],
    [IDS.globalState1, { id: IDS.globalState1, parent_id: IDS.globalCountryIndia, is_active: true, global_geography_id: null, master_geography_id: null }],
    [IDS.globalDistrict1, { id: IDS.globalDistrict1, parent_id: IDS.globalState1, is_active: true, global_geography_id: null, master_geography_id: null }],
    [IDS.globalStateGujarat, { id: IDS.globalStateGujarat, parent_id: IDS.globalDistrict1, is_active: true, global_geography_id: null, master_geography_id: null }],
  ]);

  Tenant.findByPk = async () => ({
    root_geography_id: null,
    country_name: 'India',
    state_name: 'Maharashtra',
    district_name: 'Nashik',
    city_name: 'Nashik',
  });
  Geography.findByPk = async (id) => rowsById.get(String(id)) || null;

  Geography.findOne = async ({ where }) => {
    if (where?.level === 'country' && where?.normalized_name === 'india' && where?.parent_id === null) {
      return { id: IDS.globalCountryIndia, parent_id: null, level: 'country', name: 'India' };
    }
    if (where?.level === 'state' && where?.normalized_name === 'maharashtra' && where?.parent_id === IDS.globalCountryIndia) {
      return { id: IDS.globalState1, parent_id: IDS.globalCountryIndia, level: 'state', name: 'Maharashtra' };
    }
    if (where?.level === 'district' && where?.normalized_name === 'nashik' && where?.parent_id === IDS.globalState1) {
      return { id: IDS.globalDistrict1, parent_id: IDS.globalState1, level: 'district', name: 'Nashik' };
    }
    if (where?.level === 'city' && where?.normalized_name === 'nashik' && where?.parent_id === IDS.globalDistrict1) {
      return { id: IDS.globalStateGujarat, parent_id: IDS.globalDistrict1, level: 'city', name: 'Nashik' };
    }
    return null;
  };

  Geography.findAndCountAll = async ({ where }) => {
    assert.equal(where.level, 'country');
    assert.deepEqual(where.id, { [Op.in]: [IDS.globalStateGujarat, IDS.globalDistrict1, IDS.globalState1, IDS.globalCountryIndia] });
    return {
      rows: [{
        id: IDS.globalCountryIndia,
        parent_id: null,
        tenant_id: null,
        level: 'country',
        name: 'India',
        code: 'IN',
        country_code: 'IN',
        location_status: 'mapped',
        is_active: true,
        is_platform_managed: true,
      }],
      count: 1,
    };
  };

  t.after(() => {
    Tenant.findByPk = originalTenantFindByPk;
    Geography.findByPk = originalGeographyFindByPk;
    Geography.findOne = originalGeographyFindOne;
    Geography.findAndCountAll = originalGeographyFindAndCountAll;
  });

  const result = await platformService.listGlobalGeographyOptions({
    query: { level: 'country', activeOnly: 'true' },
    user: {
      isSuperAdmin: false,
      tenantId: 'tenant-legacy',
      scopeGeographyIds: [],
      geographyId: null,
      scopeId: null,
      countryName: 'India',
      stateName: 'Maharashtra',
      districtName: 'Nashik',
      cityName: 'Nashik',
    },
  });

  assert.deepEqual(result.items.map((item) => item.name), ['India']);
});
