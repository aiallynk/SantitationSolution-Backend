const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const { requireRouteKey } = require('../src/core/middleware/auth');
const { RouteKeys } = require('../src/core/rbac/accessMatrix');
const { buildAccessContextFromUser, applyScopeToQuery } = require('../src/core/rbac/accessContext');

const runMiddleware = (middleware, req = {}) =>
  new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });

test('supervisor dashboard scope is constrained to assigned facility', () => {
  const accessContext = buildAccessContextFromUser({
    role: 'supervisor',
    roleCodes: ['supervisor'],
    tenantId: 'tenant-a',
    scopeLevel: 'facility',
    scopeFacilityIds: ['facility-1'],
  });

  const scoped = applyScopeToQuery({}, accessContext, 'dashboard');
  assert.equal(scoped.tenant_id, 'tenant-a');
  assert.deepEqual(scoped.facility_id, { [Op.in]: ['facility-1'] });
});

test('facility manager cannot query sibling facility data', () => {
  const accessContext = buildAccessContextFromUser({
    role: 'facility_manager',
    roleCodes: ['facility_manager'],
    tenantId: 'tenant-a',
    scopeLevel: 'facility',
    scopeFacilityIds: ['facility-1'],
  });

  const scoped = applyScopeToQuery({ facility_id: 'facility-2' }, accessContext, 'facility');
  assert.equal(scoped.facility_id, 'facility-2');
  assert.equal(Array.isArray(scoped[Op.and]), true);
  assert.deepEqual(scoped[Op.and][0], { facility_id: { [Op.in]: ['facility-1'] } });
});

test('geography admin cannot query sibling geography data', () => {
  const accessContext = buildAccessContextFromUser({
    role: 'city_admin',
    roleCodes: ['city_admin'],
    tenantId: 'tenant-a',
    scopeLevel: 'city',
    scopeGeographyIds: ['geo-city-1'],
  });

  const scoped = applyScopeToQuery({ geography_id: 'geo-city-2' }, accessContext, 'geography');
  assert.equal(scoped.geography_id, 'geo-city-2');
  assert.equal(Array.isArray(scoped[Op.and]), true);
  assert.deepEqual(scoped[Op.and][0], { geography_id: { [Op.in]: ['geo-city-1'] } });
});

test('field worker is denied admin route keys', async () => {
  const guard = requireRouteKey(RouteKeys.OPS_ADMINOPS);
  const error = await runMiddleware(guard, {
    user: {
      routeKeys: [RouteKeys.OPS_TASKS, RouteKeys.OPS_INSPECTIONS],
    },
  });

  assert.ok(error);
  assert.equal(error.code, 'ROUTE_FORBIDDEN');
  assert.equal(error.statusCode, 403);
});

test('supervisor route keys are limited to dedicated supervisor routes', async () => {
  const adminGuard = requireRouteKey(RouteKeys.OPS_OVERVIEW);
  const supervisorGuard = requireRouteKey(RouteKeys.SUPERVISOR_OVERVIEW);
  const workerRosterGuard = requireRouteKey(RouteKeys.SUPERVISOR_WORKERS);
  const req = {
    user: {
      routeKeys: [RouteKeys.SUPERVISOR_OVERVIEW, RouteKeys.SUPERVISOR_WORKERS, RouteKeys.SUPERVISOR_ATTENDANCE],
    },
  };

  const adminError = await runMiddleware(adminGuard, req);
  const supervisorError = await runMiddleware(supervisorGuard, req);
  const workerRosterError = await runMiddleware(workerRosterGuard, req);

  assert.ok(adminError);
  assert.equal(adminError.code, 'ROUTE_FORBIDDEN');
  assert.equal(supervisorError, null);
  assert.equal(workerRosterError, null);
});

test('tenant admin cannot cross tenant boundary in scoped query', () => {
  const accessContext = buildAccessContextFromUser({
    role: 'tenant_admin',
    roleCodes: ['tenant_admin'],
    tenantId: 'tenant-a',
    scopeLevel: 'organization',
  });

  const scoped = applyScopeToQuery({ tenant_id: 'tenant-b' }, accessContext, 'tenant');
  assert.equal(scoped.tenant_id, 'tenant-b');
  assert.equal(Array.isArray(scoped[Op.and]), true);
  assert.deepEqual(scoped[Op.and][0], { tenant_id: 'tenant-a' });
});
