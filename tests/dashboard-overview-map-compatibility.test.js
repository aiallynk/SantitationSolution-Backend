const test = require('node:test');
const assert = require('node:assert/strict');

const dashboardService = require('../src/modules/dashboard/dashboard.service');
const { Facility, Geography, ToiletUnit, sequelize } = require('../src/models');

const {
  isFacilityVisibleOnOverviewMap,
  isPointInsideOverviewScope,
  resolveToiletMarkerCoordinates,
} = dashboardService.__private;

const IDS = {
  tenant: '00000000-0000-0000-0000-000000000001',
  otherTenant: '00000000-0000-0000-0000-000000000002',
  mappedGeography: '00000000-0000-0000-0000-000000000101',
  otherGeography: '00000000-0000-0000-0000-000000000102',
  legacyFacility: '00000000-0000-0000-0000-000000000201',
  mappedFacility: '00000000-0000-0000-0000-000000000202',
};

const tenantWideAccess = {
  isSuperAdmin: false,
  tenantId: IDS.tenant,
  scopeLevel: 'organization',
  geographyIds: [],
  facilityIds: [],
};

test('tenant overview map includes same-tenant legacy and geography-mapped facilities', () => {
  const scopedGeographyIds = new Set([IDS.mappedGeography]);
  const legacyFacility = {
    id: IDS.legacyFacility,
    tenant_id: IDS.tenant,
    geography_id: null,
    zone_geography_id: null,
    ward_geography_id: null,
  };
  const mappedFacility = {
    id: IDS.mappedFacility,
    tenant_id: IDS.tenant,
    geography_id: IDS.mappedGeography,
  };

  assert.equal(isFacilityVisibleOnOverviewMap({ facility: legacyFacility, scopedGeographyIds, accessContext: tenantWideAccess, tenantId: IDS.tenant }), true);
  assert.equal(isFacilityVisibleOnOverviewMap({ facility: mappedFacility, scopedGeographyIds, accessContext: tenantWideAccess, tenantId: IDS.tenant }), true);
  assert.equal(isFacilityVisibleOnOverviewMap({ facility: { ...legacyFacility, tenant_id: IDS.otherTenant }, scopedGeographyIds, accessContext: tenantWideAccess, tenantId: IDS.tenant }), false);
});

test('geography-scoped overview map excludes unassigned legacy facilities but keeps mapped facilities in scope', () => {
  const accessContext = {
    ...tenantWideAccess,
    scopeLevel: 'city',
    geographyIds: [IDS.mappedGeography],
  };
  const scopedGeographyIds = new Set([IDS.mappedGeography]);

  assert.equal(isFacilityVisibleOnOverviewMap({
    facility: { id: IDS.legacyFacility, tenant_id: IDS.tenant, geography_id: null },
    scopedGeographyIds,
    accessContext,
    tenantId: IDS.tenant,
  }), false);
  assert.equal(isFacilityVisibleOnOverviewMap({
    facility: { id: IDS.mappedFacility, tenant_id: IDS.tenant, geography_id: IDS.mappedGeography },
    scopedGeographyIds,
    accessContext,
    tenantId: IDS.tenant,
  }), true);
  assert.equal(isFacilityVisibleOnOverviewMap({
    facility: { id: IDS.mappedFacility, tenant_id: IDS.tenant, geography_id: IDS.otherGeography },
    scopedGeographyIds,
    accessContext,
    tenantId: IDS.tenant,
  }), false);
});

test('geography-scoped overview map includes a legacy facility only inside its assigned location radius', () => {
  const accessContext = {
    ...tenantWideAccess,
    scopeLevel: 'city',
    geographyIds: [IDS.mappedGeography],
  };
  const scope = {
    boundaryCenterLatitude: 28.6139,
    boundaryCenterLongitude: 77.209,
    boundaryRadiusMeters: 1_000,
  };
  const insideLegacyFacility = {
    id: IDS.legacyFacility,
    tenant_id: IDS.tenant,
    geography_id: null,
    latitude: 28.618,
    longitude: 77.209,
  };
  const outsideLegacyFacility = {
    ...insideLegacyFacility,
    id: 'outside-legacy-facility',
    latitude: 28.64,
  };

  assert.equal(isPointInsideOverviewScope({ latitude: insideLegacyFacility.latitude, longitude: insideLegacyFacility.longitude, scope }), true);
  assert.equal(isPointInsideOverviewScope({ latitude: outsideLegacyFacility.latitude, longitude: outsideLegacyFacility.longitude, scope }), false);
  assert.equal(isFacilityVisibleOnOverviewMap({
    facility: insideLegacyFacility,
    scopedGeographyIds: new Set([IDS.mappedGeography]),
    accessContext,
    tenantId: IDS.tenant,
    scope,
  }), true);
  assert.equal(isFacilityVisibleOnOverviewMap({
    facility: outsideLegacyFacility,
    scopedGeographyIds: new Set([IDS.mappedGeography]),
    accessContext,
    tenantId: IDS.tenant,
    scope,
  }), false);
});

test('explicit facility scope retains only its assigned legacy facility', () => {
  const accessContext = {
    ...tenantWideAccess,
    scopeLevel: 'facility',
    facilityIds: [IDS.legacyFacility],
  };

  assert.equal(isFacilityVisibleOnOverviewMap({
    facility: { id: IDS.legacyFacility, tenant_id: IDS.tenant, geography_id: null },
    scopedGeographyIds: new Set(),
    accessContext,
    tenantId: IDS.tenant,
  }), true);
  assert.equal(isFacilityVisibleOnOverviewMap({
    facility: { id: IDS.mappedFacility, tenant_id: IDS.tenant, geography_id: IDS.otherGeography },
    scopedGeographyIds: new Set(),
    accessContext,
    tenantId: IDS.tenant,
  }), false);
});

test('overview map uses legacy facility GPS only when toilet-unit GPS is absent', () => {
  assert.deepEqual(resolveToiletMarkerCoordinates({
    latitude: null,
    longitude: null,
    Facility: { latitude: 28.6139, longitude: 77.209 },
  }), { latitude: 28.6139, longitude: 77.209, source: 'facility' });
  assert.deepEqual(resolveToiletMarkerCoordinates({
    latitude: 28.614,
    longitude: 77.21,
    Facility: { latitude: 28.6139, longitude: 77.209 },
  }), { latitude: 28.614, longitude: 77.21, source: 'toilet' });
  assert.equal(resolveToiletMarkerCoordinates({ latitude: null, longitude: null, Facility: {} }), null);
});

test('overview map endpoint emits both legacy facility-coordinate and current toilet-coordinate markers', async (t) => {
  const originalGeographyFindOne = Geography.findOne;
  const originalGeographyFindAll = Geography.findAll;
  const originalFacilityFindAll = Facility.findAll;
  const originalToiletFindAll = ToiletUnit.findAll;
  const originalQuery = sequelize.query;
  let capturedScopeSql = '';

  const scope = {
    id: IDS.mappedGeography,
    tenant_id: IDS.tenant,
    parent_id: null,
    level: 'city',
    name: 'Tenant city',
    latitude: 28.61,
    longitude: 77.2,
    boundary_center_latitude: null,
    boundary_center_longitude: null,
    boundary_radius_meters: null,
    global_geography_id: null,
    master_geography_id: null,
  };
  const legacyFacility = {
    id: IDS.legacyFacility,
    tenant_id: IDS.tenant,
    name: 'Legacy facility',
    latitude: 28.62,
    longitude: 77.21,
    geography_id: null,
    zone_geography_id: null,
    ward_geography_id: null,
  };
  const mappedFacility = {
    id: IDS.mappedFacility,
    tenant_id: IDS.tenant,
    name: 'Mapped facility',
    latitude: 28.63,
    longitude: 77.22,
    geography_id: IDS.mappedGeography,
    zone_geography_id: null,
    ward_geography_id: null,
  };

  Geography.findOne = async () => scope;
  Geography.findAll = async () => [scope];
  Facility.findAll = async () => [
    legacyFacility,
    mappedFacility,
    { ...legacyFacility, id: 'foreign-facility', tenant_id: IDS.otherTenant },
  ];
  ToiletUnit.findAll = async () => [
    {
      id: 'legacy-toilet',
      facility_id: IDS.legacyFacility,
      code: 'LEGACY-01',
      latitude: null,
      longitude: null,
      latest_score: 28,
      Facility: legacyFacility,
    },
    {
      id: 'mapped-toilet',
      facility_id: IDS.mappedFacility,
      code: 'MAPPED-01',
      latitude: 28.631,
      longitude: 77.221,
      latest_score: 92,
      Facility: mappedFacility,
    },
  ];
  sequelize.query = async (sql) => {
    capturedScopeSql = sql;
    return [{ id: IDS.mappedGeography }];
  };
  t.after(() => {
    Geography.findOne = originalGeographyFindOne;
    Geography.findAll = originalGeographyFindAll;
    Facility.findAll = originalFacilityFindAll;
    ToiletUnit.findAll = originalToiletFindAll;
    sequelize.query = originalQuery;
  });

  const result = await dashboardService.getOverviewMapScope({
    query: {},
    user: {
      isSuperAdmin: false,
      tenantId: IDS.tenant,
      geographyId: IDS.mappedGeography,
      scopeLevel: 'organization',
      roleCodes: ['ops_admin'],
      permissionCodes: ['dashboard.read'],
    },
  });

  const toiletMarkers = result.markers.filter((marker) => marker.type === 'toilet');
  assert.deepEqual(toiletMarkers.map((marker) => marker.id), ['legacy-toilet', 'mapped-toilet']);
  assert.deepEqual(toiletMarkers.find((marker) => marker.id === 'legacy-toilet'), {
    id: 'legacy-toilet',
    type: 'toilet',
    level: 'toilet',
    name: 'LEGACY-01',
    code: 'LEGACY-01',
    latitude: 28.62,
    longitude: 77.21,
    coordinateSource: 'facility',
    facilityId: IDS.legacyFacility,
    geographyId: null,
    zoneGeographyId: null,
    wardGeographyId: null,
    displayAddress: null,
    status: null,
    latestScore: 28,
  });
  assert.equal(toiletMarkers.find((marker) => marker.id === 'mapped-toilet').latestScore, 92);
  assert.match(capturedScopeSql, /child\.global_geography_id = parent\.id/);
  assert.match(capturedScopeSql, /child\.id = parent\.global_geography_id/);
});
