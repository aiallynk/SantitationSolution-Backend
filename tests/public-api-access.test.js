const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');

const models = require('../src/models');
const { runtimeConfig } = require('../src/config/runtime');
const apiAccessService = require('../src/modules/superAdmin/apiAccess.service');
const {
  generateRawApiKey,
  getKeyPrefix,
  hashApiKey,
} = require('../src/modules/publicApi/apiKeyCrypto');
const {
  authenticatePublicApiKey,
  endpointAllowed,
} = require('../src/modules/publicApi/publicApiAuth.middleware');
const publicToiletService = require('../src/modules/publicApi/publicToilet.service');
const { createUsageLog } = require('../src/modules/publicApi/apiUsage.service');

const SUPER_ADMIN_REQ = {
  user: { id: '11111111-1111-4111-8111-111111111111', isSuperAdmin: true },
  body: {},
  params: {},
  query: {},
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

const runMiddleware = (middleware, req) =>
  new Promise((resolve) => {
    middleware(req, {}, (error) => resolve(error || null));
  });

test('Super Admin can create an API project', async () => {
  let createdPayload = null;
  await withStubs(
    [
      [
        models.ApiProject,
        'create',
        async (payload) => {
          createdPayload = payload;
          return makeRow({
            id: 'project-1',
            ...payload,
            created_at: new Date(),
            updated_at: new Date(),
          });
        },
      ],
    ],
    async () => {
      const result = await apiAccessService.createProject({
        ...SUPER_ADMIN_REQ,
        body: {
          projectName: 'Transit App',
          clientName: 'Civic Labs',
          usageBy: 'Transit Fare App',
          environment: 'production',
          allowedTenantIds: ['22222222-2222-4222-8222-222222222222'],
        },
      });

      assert.equal(result.projectName, 'Transit App');
      assert.equal(result.usageBy, 'Transit Fare App');
      assert.equal(result.environment, 'production');
      assert.deepEqual(result.allowedTenantIds, ['22222222-2222-4222-8222-222222222222']);
      assert.equal(createdPayload.usage_by, 'Transit Fare App');
      assert.equal(createdPayload.created_by_super_admin_id, SUPER_ADMIN_REQ.user.id);
    }
  );
});

test('Super Admin can generate API key and raw value is returned only in create response', async () => {
  const project = makeRow({
    id: 'project-1',
    project_name: 'Transit App',
    environment: 'sandbox',
    status: 'active',
    allowed_tenant_ids: ['22222222-2222-4222-8222-222222222222'],
  });
  let persistedPayload = null;

  await withStubs(
    [
      [models.ApiProject, 'findByPk', async () => project],
      [
        models.ApiKey,
        'create',
        async (payload) => {
          persistedPayload = payload;
          return makeRow({
            id: 'key-1',
            ...payload,
            created_at: new Date(),
            updated_at: new Date(),
          });
        },
      ],
      [models.ApiKeyEvent, 'create', async (payload) => makeRow({ id: 'event-1', ...payload })],
    ],
    async () => {
      const created = await apiAccessService.createKey({
        ...SUPER_ADMIN_REQ,
        params: { projectId: project.id },
        body: { keyName: 'Nearby API' },
      });

      assert.match(created.rawApiKey, /^san_test_/);
      assert.equal(created.apiKey, created.rawApiKey);
      assert.equal(persistedPayload.api_key_hash, hashApiKey(created.rawApiKey));
      assert.equal(persistedPayload.key_prefix, getKeyPrefix(created.rawApiKey));
      assert.equal(Object.prototype.hasOwnProperty.call(persistedPayload, 'rawApiKey'), false);

      const listed = apiAccessService.mapKey(makeRow({ id: 'key-1', ...persistedPayload }));
      assert.equal(listed.rawApiKey, undefined);
      assert.equal(listed.apiKey, undefined);
    }
  );
});

test('API key hash validation works without storing raw key', () => {
  const raw = generateRawApiKey('production');
  const hash = hashApiKey(raw);
  assert.match(raw, /^san_live_/);
  assert.equal(hash, hashApiKey(raw));
  assert.notEqual(hash, raw);
});

test('missing API key returns 401', async () => {
  const error = await runMiddleware(authenticatePublicApiKey, {
    headers: {},
    originalUrl: '/api/public/v1/toilets/nearby',
  });
  assert.equal(error.statusCode, 401);
  assert.equal(error.code, 'API_KEY_MISSING');
});

test('invalid API key returns 401', async () => {
  await withStubs(
    [[models.ApiKey, 'findAll', async () => []]],
    async () => {
      const error = await runMiddleware(authenticatePublicApiKey, {
        headers: { 'x-api-key': 'san_test_invalid' },
        originalUrl: '/api/public/v1/toilets/nearby',
      });
      assert.equal(error.statusCode, 401);
      assert.equal(error.code, 'API_KEY_INVALID');
    }
  );
});

test('revoked key returns 403 and records revoked-key use event', async () => {
  const raw = generateRawApiKey('sandbox');
  let eventType = null;
  await withStubs(
    [
      [
        models.ApiKey,
        'findAll',
        async () => [
          makeRow({
            id: 'key-1',
            api_project_id: 'project-1',
            api_key_hash: hashApiKey(raw),
            status: 'revoked',
            allowed_endpoints: ['/toilets/nearby'],
            project: { id: 'project-1', status: 'active' },
          }),
        ],
      ],
      [models.ApiKeyEvent, 'create', async (payload) => { eventType = payload.event_type; return makeRow(payload); }],
      [models.NotificationEvent, 'create', async (payload) => makeRow(payload)],
    ],
    async () => {
      const error = await runMiddleware(authenticatePublicApiKey, {
        headers: { 'x-api-key': raw },
        originalUrl: '/api/public/v1/toilets/nearby',
      });
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'API_KEY_REVOKED');
      assert.equal(eventType, 'REVOKED_KEY_USED');
    }
  );
});

test('expired key returns 403', async () => {
  const raw = generateRawApiKey('sandbox');
  await withStubs(
    [
      [
        models.ApiKey,
        'findAll',
        async () => [
          makeRow({
            id: 'key-1',
            api_project_id: 'project-1',
            api_key_hash: hashApiKey(raw),
            status: 'active',
            expires_at: new Date(Date.now() - 1000),
            allowed_endpoints: ['/toilets/nearby'],
            project: { id: 'project-1', status: 'active' },
          }),
        ],
      ],
      [models.ApiKeyEvent, 'create', async (payload) => makeRow(payload)],
      [models.NotificationEvent, 'create', async (payload) => makeRow(payload)],
    ],
    async () => {
      const error = await runMiddleware(authenticatePublicApiKey, {
        headers: { 'x-api-key': raw },
        originalUrl: '/api/public/v1/toilets/nearby',
      });
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'API_KEY_EXPIRED');
    }
  );
});

test('endpoint scope is enforced', async () => {
  const raw = generateRawApiKey('sandbox');
  await withStubs(
    [
      [
        models.ApiKey,
        'findAll',
        async () => [
          makeRow({
            id: 'key-1',
            api_project_id: 'project-1',
            api_key_hash: hashApiKey(raw),
            status: 'active',
            allowed_endpoints: ['/other'],
            project: { id: 'project-1', status: 'active' },
          }),
        ],
      ],
    ],
    async () => {
      const error = await runMiddleware(authenticatePublicApiKey, {
        headers: { 'x-api-key': raw },
        originalUrl: '/api/public/v1/toilets/nearby',
      });
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'ENDPOINT_NOT_ALLOWED');
      assert.equal(endpointAllowed('/toilets/nearby', ['/toilets/nearby']), true);
    }
  );
});

test('rate limit returns 429', async () => {
  const raw = generateRawApiKey('sandbox');
  const counts = [1, 0, 0];
  await withStubs(
    [
      [
        models.ApiKey,
        'findAll',
        async () => [
          makeRow({
            id: 'key-1',
            api_project_id: 'project-1',
            api_key_hash: hashApiKey(raw),
            status: 'active',
            permissions: ['toilets:nearby:read'],
            allowed_endpoints: ['/toilets/nearby'],
            rate_limit_per_minute: 1,
            rate_limit_per_day: 100,
            monthly_quota: 1000,
            project: { id: 'project-1', status: 'active' },
          }),
        ],
      ],
      [models.ApiUsageLog, 'count', async () => counts.shift() ?? 0],
      [models.ApiKeyEvent, 'create', async (payload) => makeRow(payload)],
    ],
    async () => {
      const previousRedisEnabled = runtimeConfig.redis.enabled;
      let error;
      try {
        runtimeConfig.redis.enabled = false;
        error = await runMiddleware(authenticatePublicApiKey, {
          headers: { 'x-api-key': raw },
          originalUrl: '/api/public/v1/toilets/nearby',
        });
      } finally {
        runtimeConfig.redis.enabled = previousRedisEnabled;
      }
      assert.equal(error.statusCode, 429);
      assert.equal(error.code, 'API_RATE_LIMIT_EXCEEDED');
    }
  );
});

test('valid key returns nearby toilets and public DTO does not expose private fields', async () => {
  let toiletWhere = null;
  let facilityWhere = null;
  await withStubs(
    [
      [
        models.Tenant,
        'findAll',
        async () => [
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Nashik Zone A',
            code: 'NZ-A',
            status: 'active',
            external_api_sharing_enabled: true,
          },
        ],
      ],
      [
        models.ToiletUnit,
        'findAll',
        async (options) => {
          toiletWhere = options.where;
          facilityWhere = options.include[0].where;
          return [
            {
              id: 'toilet-private-db-id',
              code: 'T-1',
              unit_type: 'male',
              status: 'clean',
              is_public_visible: true,
              location_label: 'Gate 1',
              latitude: '12.9717000',
              longitude: '77.5947000',
              latest_score: 91,
              updated_at: new Date(),
              Facility: {
                id: 'facility-db-id',
                tenant_id: '22222222-2222-4222-8222-222222222222',
                name: 'Central Station',
                address_line: 'MG Road',
                latitude: '12.9717000',
                longitude: '77.5947000',
                status: 'active',
                metadata: { publicFacilities: { waterAvailable: true } },
              },
              ToiletBlock: { name: 'Block A', gender_type: 'male' },
            },
          ];
        },
      ],
      [
        models.Inspection,
        'findAll',
        async () => [
          {
            id: 'inspection-1',
            toilet_unit_id: 'toilet-private-db-id',
            avg_after_score: 92,
            captured_at: new Date(),
          },
        ],
      ],
      [models.AiAnalysisResult, 'findAll', async () => [{ inspection_id: 'inspection-1', cleanliness_score: 90, processed_at: new Date() }]],
      [models.SensorDevice, 'findAll', async () => []],
      [models.Complaint, 'findAll', async () => []],
    ],
    async () => {
      const result = await publicToiletService.getNearbyToilets({
        query: {
          lat: '12.9716',
          lng: '77.5946',
          radius: '500',
          tenant_id: '22222222-2222-4222-8222-222222222222',
        },
        publicApi: {
          key: {
            permissions: ['toilets:nearby:read'],
            allowed_tenant_ids: ['22222222-2222-4222-8222-222222222222'],
          },
          project: { allowed_tenant_ids: ['22222222-2222-4222-8222-222222222222'] },
        },
      });

      assert.equal(toiletWhere.is_public_visible, true);
      assert.deepEqual(facilityWhere.tenant_id[Op.in], ['22222222-2222-4222-8222-222222222222']);
      assert.equal(result.items.length, 1);
      assert.match(result.items[0].public_toilet_id, /^san_toilet_/);
      assert.equal(result.items[0].id, undefined);
      assert.equal(result.items[0].worker, undefined);
      assert.equal(result.items[0].tenant_id, undefined);
      assert.equal(result.items[0].public_facilities.water_available, true);
    }
  );
});

test('nearby toilets resolves share-enabled tenants when tenant_id is omitted', async () => {
  let tenantWhere = null;
  let facilityWhere = null;
  await withStubs(
    [
      [
        models.Tenant,
        'findAll',
        async (options) => {
          tenantWhere = options.where;
          return [
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Nashik Zone A',
              status: 'active',
              external_api_sharing_enabled: true,
            },
          ];
        },
      ],
      [
        models.ToiletUnit,
        'findAll',
        async (options) => {
          facilityWhere = options.include[0].where;
          return [
            {
              id: 'aakash-toilet-id',
              code: 'A-1',
              unit_type: 'male',
              status: 'clean',
              is_public_visible: true,
              location_label: 'Aakash Petrol Pump',
              latitude: '20.0389977',
              longitude: '73.8048501',
              updated_at: new Date(),
              Facility: {
                tenant_id: '22222222-2222-4222-8222-222222222222',
                name: 'Aakash Petrol Pump',
                address_line: 'Nashik',
                status: 'active',
                metadata: {},
              },
              ToiletBlock: { name: 'Block A', gender_type: 'male' },
            },
          ];
        },
      ],
      [models.Inspection, 'findAll', async () => []],
      [models.AiAnalysisResult, 'findAll', async () => []],
      [models.SensorDevice, 'findAll', async () => []],
      [models.Complaint, 'findAll', async () => []],
    ],
    async () => {
      const result = await publicToiletService.getNearbyToilets({
        query: {
          lat: '20.0389977',
          lng: '73.8048501',
          radius: '10000',
          cleanliness_min: '0',
          include_closed: 'false',
        },
        publicApi: {
          key: {
            permissions: ['toilets:nearby:read'],
            allowed_tenant_ids: [],
          },
          project: { allowed_tenant_ids: [] },
        },
      });

      assert.equal(tenantWhere.status, 'active');
      assert.equal(tenantWhere.external_api_sharing_enabled, true);
      assert.deepEqual(facilityWhere.tenant_id[Op.in], ['22222222-2222-4222-8222-222222222222']);
      assert.equal(result.items.length, 1);
      assert.equal(result.meta.tenantScoped, false);
      assert.equal(result.items[0].cleanliness_status, 'Status Unknown');
    }
  );
});

test('include_closed requires explicit API key permission', async () => {
  await assert.rejects(
    () =>
      publicToiletService.getNearbyToilets({
        query: {
          lat: '20.0389977',
          lng: '73.8048501',
          include_closed: 'true',
        },
        publicApi: {
          key: { permissions: ['toilets:nearby:read'] },
          project: {},
        },
      }),
    (error) => error.code === 'INCLUDE_CLOSED_FORBIDDEN' && error.statusCode === 403
  );
});

test('toilet coordinate normalization supports columns geojson strings and invalid values', () => {
  assert.deepEqual(
    publicToiletService.normalizeToiletCoordinates({ latitude: 20.1, longitude: 73.9 }),
    { lat: 20.1, lng: 73.9, source: 'lat_lng_columns', valid: true, reason: null }
  );
  assert.deepEqual(
    publicToiletService.normalizeToiletCoordinates({ location: { type: 'Point', coordinates: [73.9, 20.1] } }),
    { lat: 20.1, lng: 73.9, source: 'geojson', valid: true, reason: null }
  );
  assert.equal(
    publicToiletService.normalizeToiletCoordinates({ latitude: 120, longitude: 20 }).reason,
    'INVALID_COORDINATES'
  );
  assert.equal(publicToiletService.normalizeToiletCoordinates({}).reason, 'MISSING_COORDINATES');
  assert.deepEqual(
    publicToiletService.normalizeToiletCoordinates({ latitude: '20.1', longitude: '73.9' }),
    { lat: 20.1, lng: 73.9, source: 'parsed_string', valid: true, reason: null }
  );
});

test('tenant scope is enforced on nearby toilets endpoint', async () => {
  await assert.rejects(
    () =>
      publicToiletService.getNearbyToilets({
        query: {
          lat: '12',
          lng: '77',
          tenant_id: '33333333-3333-4333-8333-333333333333',
        },
        publicApi: {
          key: {
            permissions: ['toilets:nearby:read'],
            allowed_tenant_ids: ['22222222-2222-4222-8222-222222222222'],
          },
          project: { allowed_tenant_ids: ['22222222-2222-4222-8222-222222222222'] },
        },
      }),
    (error) => error.code === 'TENANT_SCOPE_FORBIDDEN' && error.statusCode === 403
  );
});

test('debug nearby funnel reports exact public visibility drop-off', async () => {
  await withStubs(
    [
      [
        models.Tenant,
        'findAll',
        async () => [
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Nashik Zone A',
            status: 'active',
            external_api_sharing_enabled: true,
          },
        ],
      ],
      [
        models.ToiletUnit,
        'findAll',
        async () => [
          {
            id: 'hidden-toilet-id',
            code: 'A-1',
            unit_type: 'male',
            status: 'clean',
            is_public_visible: false,
            location_label: 'Aakash Petrol Pump',
            latitude: '20.0389977',
            longitude: '73.8048501',
            updated_at: new Date(),
            Facility: {
              tenant_id: '22222222-2222-4222-8222-222222222222',
              name: 'Aakash Petrol Pump',
              status: 'active',
              Tenant: {
                id: '22222222-2222-4222-8222-222222222222',
                name: 'Nashik Zone A',
                external_api_sharing_enabled: true,
              },
            },
            ToiletBlock: { name: 'Block A', gender_type: 'male', status: 'active' },
          },
        ],
      ],
      [models.Inspection, 'findAll', async () => []],
      [models.AiAnalysisResult, 'findAll', async () => []],
      [models.SensorDevice, 'findAll', async () => []],
      [models.Complaint, 'findAll', async () => []],
    ],
    async () => {
      const result = await publicToiletService.getDebugNearbyToilets({
        lat: '20.0389977',
        lng: '73.8048501',
        radius: '10000',
        cleanlinessMin: '0',
      });

      assert.equal(result.funnel.withinRadius, 1);
      assert.equal(result.funnel.afterPublicVisible, 0);
      assert.equal(result.excludedSamples[0].reason, 'IS_PUBLIC_VISIBLE_FALSE');
    }
  );
});

test('debug nearby funnel does not recommend coordinate fixes for non-public toilets', async () => {
  await withStubs(
    [
      [
        models.Tenant,
        'findAll',
        async () => [
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Nashik Zone A',
            status: 'active',
            external_api_sharing_enabled: true,
          },
          {
            id: '33333333-3333-4333-8333-333333333333',
            name: 'Nashik Zone B',
            status: 'active',
            external_api_sharing_enabled: false,
          },
        ],
      ],
      [
        models.ToiletUnit,
        'findAll',
        async () => [
          {
            id: 'public-enabled-toilet-id',
            code: 'A-1',
            unit_type: 'male',
            status: 'clean',
            is_public_visible: true,
            location_label: 'Public Toilet',
            latitude: '20.0389977',
            longitude: '73.8048501',
            updated_at: new Date(),
            Facility: {
              tenant_id: '22222222-2222-4222-8222-222222222222',
              name: 'Public Toilet',
              status: 'active',
              Tenant: {
                id: '22222222-2222-4222-8222-222222222222',
                name: 'Nashik Zone A',
                external_api_sharing_enabled: true,
              },
            },
            ToiletBlock: { name: 'Block A', gender_type: 'male', status: 'active' },
          },
          {
            id: 'private-missing-coords-id',
            code: 'A-2',
            unit_type: 'male',
            status: 'clean',
            is_public_visible: false,
            location_label: 'Private Toilet',
            latitude: null,
            longitude: null,
            updated_at: new Date(),
            Facility: {
              tenant_id: '22222222-2222-4222-8222-222222222222',
              name: 'Private Toilet',
              status: 'active',
              Tenant: {
                id: '22222222-2222-4222-8222-222222222222',
                name: 'Nashik Zone A',
                external_api_sharing_enabled: true,
              },
            },
            ToiletBlock: { name: 'Block B', gender_type: 'male', status: 'active' },
          },
          {
            id: 'share-disabled-toilet-id',
            code: 'B-1',
            unit_type: 'male',
            status: 'clean',
            is_public_visible: true,
            location_label: 'Shared Toilet',
            latitude: '20.0389977',
            longitude: '73.8048501',
            updated_at: new Date(),
            Facility: {
              tenant_id: '33333333-3333-4333-8333-333333333333',
              name: 'Shared Toilet',
              status: 'active',
              Tenant: {
                id: '33333333-3333-4333-8333-333333333333',
                name: 'Nashik Zone B',
                external_api_sharing_enabled: false,
              },
            },
            ToiletBlock: { name: 'Block C', gender_type: 'male', status: 'active' },
          },
        ],
      ],
      [models.Inspection, 'findAll', async () => []],
      [models.AiAnalysisResult, 'findAll', async () => []],
      [models.SensorDevice, 'findAll', async () => []],
      [models.Complaint, 'findAll', async () => []],
    ],
    async () => {
      const result = await publicToiletService.getDebugNearbyToilets({
        lat: '20.0389977',
        lng: '73.8048501',
        radius: '10000',
        cleanlinessMin: '0',
      });

      assert.equal(result.funnel.withinRadius, 2);
      assert.equal(result.funnel.afterTenantSharing, 1);
      assert.ok(result.recommendedFixes.includes('Enable external API sharing for tenants that should publish toilets.'));
      assert.equal(result.recommendedFixes.includes('Fix missing or invalid toilet coordinates.'), false);
    }
  );
});

test('invalid lat/lng returns 400', () => {
  assert.throws(
    () => publicToiletService.validateNearbyQuery({ lat: '91', lng: '77' }),
    (error) => error.statusCode === 400 && error.errors.includes('lat must be between -90 and 90')
  );
  assert.throws(
    () => publicToiletService.validateNearbyQuery({ lat: '12', lng: '-181' }),
    (error) => error.statusCode === 400 && error.errors.includes('lng must be between -180 and 180')
  );
});

test('radius above max returns 400', () => {
  assert.throws(
    () => publicToiletService.validateNearbyQuery({ lat: '12', lng: '77', radius: '10001' }),
    (error) => error.statusCode === 400 && error.errors.some((item) => item.includes('radius must be'))
  );
});

test('API usage is logged with rounded coordinates and daily summary is updated', async () => {
  let logPayload = null;
  let summaryUpdate = null;
  await withStubs(
    [
      [
        models.ApiUsageLog,
        'create',
        async (payload) => {
          logPayload = payload;
          return makeRow({ id: 'log-1', ...payload });
        },
      ],
      [
        models.ApiUsageLog,
        'findAll',
        async () => [
          { status_code: 200, response_time_ms: 10, response_count: 2, request_ip: '10.0.0.1' },
          { status_code: 429, response_time_ms: 20, response_count: 0, request_ip: '10.0.0.2' },
        ],
      ],
      [
        models.ApiUsageDailySummary,
        'findOrCreate',
        async ({ defaults }) => {
          const summary = makeRow({
            id: 'summary-1',
            api_project_id: 'project-1',
            api_key_id: 'key-1',
            date: '2026-07-01',
            ...defaults,
          });
          summary.update = async (payload) => {
            summaryUpdate = payload;
            Object.assign(summary, payload);
            return summary;
          };
          return [summary];
        },
      ],
    ],
    async () => {
      await createUsageLog({
        req: {
          method: 'GET',
          originalUrl: '/api/public/v1/toilets/nearby?lat=12.345678&lng=77.123456',
          ip: '10.0.0.1',
          headers: { 'user-agent': 'test-agent' },
          query: { lat: '12.345678', lng: '77.123456', radius: '2000' },
          publicApi: { apiProjectId: 'project-1', apiKeyId: 'key-1' },
        },
        res: {
          statusCode: 200,
          locals: { publicResponseCount: 2 },
        },
        startedAt: Date.now() - 5,
      });

      assert.equal(logPayload.lat_rounded, 12.346);
      assert.equal(logPayload.lng_rounded, 77.123);
      assert.equal(logPayload.response_count, 2);
      assert.equal(summaryUpdate.total_requests, 2);
      assert.equal(summaryUpdate.successful_requests, 1);
      assert.equal(summaryUpdate.rate_limited_requests, 1);
    }
  );
});
