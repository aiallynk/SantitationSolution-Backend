const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../src/models');
const auditService = require('../src/modules/audit/audit.service');
const { validateTenantPatch } = require('../src/modules/superAdmin/superAdmin.validator');

const SUPER_ADMIN_REQ = {
  user: { id: '11111111-1111-4111-8111-111111111111', isSuperAdmin: true },
  params: { id: '22222222-2222-4222-8222-222222222222' },
  body: {},
  headers: {},
};

const withStubs = async (stubs, fn) => {
  const originals = [];
  for (const [target, key, value] of stubs) {
    originals.push([target, key, target[key]]);
    target[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [target, key, value] of originals.reverse()) {
      target[key] = value;
    }
  }
};

const makeRow = (fields) => {
  const row = { ...fields };
  row.update = async (updates) => {
    Object.assign(row, updates);
    return row;
  };
  return row;
};

const loadSuperAdminService = () => {
  delete require.cache[require.resolve('../src/modules/superAdmin/superAdmin.service')];
  return require('../src/modules/superAdmin/superAdmin.service');
};

test('validateTenantPatch accepts public API sharing toggles', () => {
  assert.deepEqual(validateTenantPatch({ body: { externalApiSharingEnabled: true } }), []);
  assert.deepEqual(validateTenantPatch({ body: { external_api_sharing_enabled: false } }), []);
  assert.deepEqual(validateTenantPatch({ body: { externalApiSharingEnabled: 'yes' } }), [
    'externalApiSharingEnabled must be boolean when provided',
  ]);
});

test('patchTenant persists external API sharing on the tenant record', async () => {
  const tenantRow = makeRow({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Nashik Zone A',
    code: 'NZA',
    status: 'active',
    external_api_sharing_enabled: false,
    country_code: 'IN',
    scope_level: 'city',
    country_name: 'India',
    state_name: 'Maharashtra',
    district_name: null,
    city_name: 'Nashik',
    zone_name: null,
    address_line: null,
    root_geography_id: null,
    metadata: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  });
  let capturedUpdates = null;
  const originalCreateAuditLog = auditService.createAuditLog;
  auditService.createAuditLog = async () => {};

  try {
    const superAdminService = loadSuperAdminService();
    await withStubs(
      [
        [
          models.sequelize,
          'transaction',
          async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }),
        ],
        [
          models.Tenant,
          'findByPk',
          async () => tenantRow,
        ],
        [
          models.Facility,
          'count',
          async () => 0,
        ],
        [
          models.PlatformUser,
          'count',
          async () => 0,
        ],
        [
          models.Alert,
          'count',
          async () => 0,
        ],
        [
          models.Inspection,
          'count',
          async () => 0,
        ],
        [
          models.Geography,
          'count',
          async () => 0,
        ],
      ],
      async () => {
        tenantRow.update = async (updates) => {
          capturedUpdates = updates;
          Object.assign(tenantRow, updates);
          return tenantRow;
        };

        const result = await superAdminService.patchTenant({
          ...SUPER_ADMIN_REQ,
          body: { externalApiSharingEnabled: true },
        });

        assert.equal(capturedUpdates.external_api_sharing_enabled, true);
        assert.equal(result.externalApiSharingEnabled, true);
        assert.equal(result.status, 'active');
      }
    );
  } finally {
    auditService.createAuditLog = originalCreateAuditLog;
  }
});
