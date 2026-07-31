const test = require('node:test');
const assert = require('node:assert/strict');

const { requireNotRoles } = require('../src/core/middleware/auth');

const runMiddleware = (middleware, req = {}) =>
  new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });

test('geography write guard blocks tenant admin from protected admin operations', async () => {
  const error = await runMiddleware(requireNotRoles('tenant_admin', 'state_admin'), {
    user: {
      roleCodes: ['tenant_admin'],
      isSuperAdmin: false,
    },
  });

  assert.ok(error);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'ROLE_FORBIDDEN');
});

test('geography write guard blocks state admin from protected admin operations', async () => {
  const error = await runMiddleware(requireNotRoles('tenant_admin', 'state_admin'), {
    user: {
      roleCodes: ['state_admin'],
      isSuperAdmin: false,
    },
  });

  assert.ok(error);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'ROLE_FORBIDDEN');
});

test('geography write guard still allows district admin', async () => {
  const error = await runMiddleware(requireNotRoles('tenant_admin', 'state_admin'), {
    user: {
      roleCodes: ['district_admin'],
      isSuperAdmin: false,
    },
  });

  assert.equal(error, null);
});

test('operational master data guard blocks tenant admin centrally', async () => {
  const error = await runMiddleware(requireNotRoles('tenant_admin', 'state_admin'), {
    user: {
      roleCodes: ['tenant_admin'],
      isSuperAdmin: false,
    },
  });

  assert.ok(error);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'ROLE_FORBIDDEN');
});

test('operational master data guard blocks state admin centrally', async () => {
  const error = await runMiddleware(requireNotRoles('tenant_admin', 'state_admin'), {
    user: {
      roleCodes: ['state_admin'],
      isSuperAdmin: false,
    },
  });

  assert.ok(error);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, 'ROLE_FORBIDDEN');
});

test('operational master data guard still allows super admin', async () => {
  const error = await runMiddleware(requireNotRoles('tenant_admin', 'state_admin'), {
    user: {
      roleCodes: ['super_admin'],
      isSuperAdmin: true,
    },
  });

  assert.equal(error, null);
});
