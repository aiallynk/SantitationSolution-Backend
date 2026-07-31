const test = require('node:test');
const assert = require('node:assert/strict');

const platformService = require('../src/modules/platform/platform.service');
const AppError = require('../src/core/errors/AppError');
const { Geography, SuperAdminApproval } = require('../src/models');

test('district admin cannot directly create official city geography records', async () => {
  await assert.rejects(
    () =>
      platformService.createGeography({
        user: {
          id: 'user-1',
          tenantId: 'tenant-1',
          isSuperAdmin: false,
        },
        body: {
          tenantId: 'tenant-1',
          level: 'city',
          parentId: 'district-1',
          name: 'Rau',
        },
      }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'OFFICIAL_GEOGRAPHY_CREATE_FORBIDDEN');
      return true;
    },
  );
});

test('missing-city requests are accepted for super admin review workflow', async (t) => {
  const originalFindOne = Geography.findOne;
  const originalCreate = SuperAdminApproval.create;

  Geography.findOne = async () => null;
  SuperAdminApproval.create = async (payload) => ({
    id: 'approval-1',
    status: 'pending',
    category: payload.category,
  });

  t.after(() => {
    Geography.findOne = originalFindOne;
    SuperAdminApproval.create = originalCreate;
  });

  const result = await platformService.requestMissingArea({
    user: {
      id: 'user-1',
      tenantId: 'tenant-1',
      isSuperAdmin: false,
    },
    body: {
      level: 'city',
      name: 'Rau',
      parentId: 'district-1',
      countryCode: 'IN',
      officialReference: 'Collector notification',
      remarks: 'District admin requested city onboarding',
    },
  });

  assert.deepEqual(result, {
    id: 'approval-1',
    status: 'pending',
    category: 'geography_missing_area_request',
  });
});
