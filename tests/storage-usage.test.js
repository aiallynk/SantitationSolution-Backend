'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const models = require('../src/models');
const {
  calculateS3UsageWithClient,
  calculateS3UsageByTenantPrefixWithClient,
} = require('../src/modules/media/s3.service');
const {
  chooseTenantUsageSource,
  formatBytes,
  resolveS3UsageErrorCode,
  summarizeMediaRowsForStorage,
} = require('../src/modules/superAdmin/storageUsage.service');

const S3_ENV_KEYS = [
  'NODE_ENV',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_S3_BUCKET',
  'AWS_S3_BUCKET_NAME',
  'S3_BUCKET',
  'S3_BUCKET_NAME',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_ROLE_ARN',
];

const STORAGE_USAGE_MODULES = [
  '../src/modules/superAdmin/storageUsage.service',
  '../src/modules/media/s3.service',
  '../src/config/runtime',
];

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

const reloadStorageUsageService = ({ patchS3 = null } = {}) => {
  for (const modulePath of STORAGE_USAGE_MODULES) {
    delete require.cache[require.resolve(modulePath)];
  }

  const s3Service = require('../src/modules/media/s3.service');
  if (patchS3) {
    Object.assign(s3Service, patchS3);
  }

  return require('../src/modules/superAdmin/storageUsage.service');
};

const withFreshStorageUsageService = async ({ env = {}, patchS3 = null } = {}, fn) => {
  const previousEnv = new Map(S3_ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of S3_ENV_KEYS) {
      process.env[key] = Object.prototype.hasOwnProperty.call(env, key) ? env[key] : '';
    }
    const service = reloadStorageUsageService({ patchS3 });
    return await fn(service);
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const modulePath of STORAGE_USAGE_MODULES) {
      delete require.cache[require.resolve(modulePath)];
    }
  }
};

test('calculateS3UsageWithClient handles paginated S3 listings', async () => {
  const pages = [
    {
      Contents: Array.from({ length: 1000 }, (_, index) => ({
        Key: `sanitation/t1/${index}.jpg`,
        Size: 10,
      })),
      NextContinuationToken: 'page-2',
      IsTruncated: true,
    },
    {
      Contents: [
        { Key: 'sanitation/t1/1000.jpg', Size: 25 },
        { Key: 'sanitation/t1/1001.jpg', Size: 35 },
      ],
      IsTruncated: false,
    },
  ];
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command);
      return pages.shift();
    },
  };

  const usage = await calculateS3UsageWithClient({
    client,
    bucketName: 'bucket',
    prefix: 'sanitation/t1/',
    commandFactory: (params) => params,
  });

  assert.equal(usage.objectCount, 1002);
  assert.equal(usage.totalBytes, 10060);
  assert.equal(usage.pageCount, 2);
  assert.equal(commands[0].ContinuationToken, undefined);
  assert.equal(commands[1].ContinuationToken, 'page-2');
});

test('calculateS3UsageWithClient returns zero for an empty bucket prefix', async () => {
  const client = {
    send: async () => ({ Contents: [], IsTruncated: false }),
  };

  const usage = await calculateS3UsageWithClient({
    client,
    bucketName: 'bucket',
    prefix: 'empty/',
    commandFactory: (params) => params,
  });

  assert.equal(usage.objectCount, 0);
  assert.equal(usage.totalBytes, 0);
});

test('calculateS3UsageByTenantPrefixWithClient groups known tenant prefixes only', async () => {
  const client = {
    send: async () => ({
      Contents: [
        { Key: 'sanitation/t1/one.jpg', Size: 100 },
        { Key: 'sanitation/t1/two.jpg', Size: 200 },
        { Key: 'sanitation/t2/one.jpg', Size: 300 },
        { Key: 'sanitation/backups/db.zip', Size: 999 },
      ],
      IsTruncated: false,
    }),
  };

  const usage = await calculateS3UsageByTenantPrefixWithClient({
    client,
    bucketName: 'bucket',
    basePrefix: 'sanitation/',
    knownTenantIds: ['t1', 't2'],
    commandFactory: (params) => params,
  });

  assert.equal(usage.objectCount, 3);
  assert.equal(usage.totalBytes, 600);
  assert.deepEqual(
    usage.tenants
      .map((tenant) => [tenant.tenantId, tenant.totalBytes, tenant.objectCount])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['t1', 300, 2],
      ['t2', 300, 1],
    ]
  );
});

test('storage usage helpers format bytes and map S3 permission errors', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(128394823), '122 MB');
  assert.equal(resolveS3UsageErrorCode({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'list'), 'S3_LIST_PERMISSION_DENIED');
  assert.equal(resolveS3UsageErrorCode({ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'head'), 'S3_HEAD_PERMISSION_DENIED');
  assert.equal(resolveS3UsageErrorCode({ name: 'CredentialsProviderError', message: 'Could not load credentials' }), 'S3_CREDENTIALS_MISSING');
});

test('tenant DB summary uses content_length or metadata bytes and deduplicates object keys', () => {
  const rows = [
    {
      tenant_id: 't1',
      storage_key: 'sanitation/t1/a.jpg',
      content_length: 100,
      metadata: {},
      uploaded_at: '2026-07-02T00:00:00.000Z',
    },
    {
      tenant_id: 't1',
      storage_key: 'sanitation/t1/b.jpg',
      content_length: null,
      metadata: { bytes: 250 },
    },
    {
      tenant_id: 't1',
      storage_key: 'sanitation/t1/b.jpg',
      content_length: 250,
      metadata: {},
    },
    {
      tenant_id: 't1',
      storage_key: 'sanitation/t1/c.jpg',
      content_length: null,
      metadata: {},
    },
    {
      tenant_id: 't1',
      storage_key: 'uploads/local-only.jpg',
      content_length: 999,
      metadata: { provider: 'local' },
    },
  ];

  const [summary] = summarizeMediaRowsForStorage(rows);

  assert.equal(summary.totalBytes, 350);
  assert.equal(summary.objectCount, 3);
  assert.equal(summary.missingSizeCount, 1);
});

test('tenant usage source falls back to S3 prefix when DB sizes are incomplete', () => {
  const chosen = chooseTenantUsageSource({
    tenantId: 't1',
    dbUsage: {
      tenantId: 't1',
      totalBytes: 0,
      objectCount: 2,
      missingSizeCount: 2,
      source: 'db_media_records',
    },
    prefixUsage: {
      tenantId: 't1',
      prefix: 'sanitation/t1/',
      totalBytes: 4096,
      objectCount: 2,
    },
  });

  assert.equal(chosen.source, 's3_prefix');
  assert.equal(chosen.totalBytes, 4096);
  assert.equal(chosen.formattedSize, '4.00 KB');
});

test('platform storage usage returns DB media totals when S3 config is missing', async () => {
  await withFreshStorageUsageService({}, async (storageUsageService) => {
    await withStubs(
      [
        [
          models.Tenant,
          'findAll',
          async () => [
            {
              id: 'tenant-1',
              name: 'Tenant One',
              code: 'T1',
            },
          ],
        ],
        [
          models.InspectionMedia,
          'findAll',
          async () => [
            {
              tenant_id: 'tenant-1',
              storage_key: 'sanitation/tenant-1/a.jpg',
              content_length: 1024,
              metadata: {},
              uploaded_at: '2026-07-01T00:00:00.000Z',
              Inspection: { tenant_id: 'tenant-1' },
            },
            {
              tenant_id: 'tenant-1',
              storage_key: 'sanitation/tenant-1/b.jpg',
              content_length: null,
              metadata: { bytes: 2048 },
              uploaded_at: '2026-07-02T00:00:00.000Z',
              Inspection: { tenant_id: 'tenant-1' },
            },
          ],
        ],
      ],
      async () => {
        const result = await storageUsageService.getPlatformStorageUsage({
          user: { isSuperAdmin: true },
        });

        assert.equal(result.success, true);
        assert.equal(result.source, 'db_media_records');
        assert.equal(result.totalBytes, 3072);
        assert.equal(result.usedBytes, 3072);
        assert.equal(result.objectCount, 2);
        assert.equal(result.storageWarning.code, 'S3_USAGE_CONFIG_MISSING');
        assert.equal(result.tenants.length, 1);
        assert.equal(result.tenants[0].tenantId, 'tenant-1');
        assert.equal(result.tenants[0].source, 'db_media_records');
        assert.equal(result.tenants[0].usedBytes, 3072);
      }
    );
  });
});

test('platform storage usage falls back to DB media totals when S3 listing is denied', async () => {
  const accessDenied = Object.assign(new Error('Access Denied'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });

  await withFreshStorageUsageService(
    {
      env: {
        NODE_ENV: 'test',
        AWS_REGION: 'ap-south-1',
        AWS_S3_BUCKET: 'sanitation-media',
        AWS_ACCESS_KEY_ID: 'test-access-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      },
      patchS3: {
        calculateS3Usage: async () => {
          throw accessDenied;
        },
        calculateS3UsageByTenantPrefix: async () => {
          throw accessDenied;
        },
      },
    },
    async (storageUsageService) => {
      await withStubs(
        [
          [
            models.Tenant,
            'findAll',
            async () => [
              {
                id: 'tenant-1',
                name: 'Tenant One',
                code: 'T1',
              },
            ],
          ],
          [
            models.InspectionMedia,
            'findAll',
            async () => [
              {
                tenant_id: 'tenant-1',
                storage_key: 'sanitation/tenant-1/a.jpg',
                content_length: 4096,
                metadata: {},
                uploaded_at: '2026-07-03T00:00:00.000Z',
                Inspection: { tenant_id: 'tenant-1' },
              },
            ],
          ],
        ],
        async () => {
          const result = await storageUsageService.getPlatformStorageUsage({
            user: { isSuperAdmin: true },
          });

          assert.equal(result.success, true);
          assert.equal(result.source, 'db_media_records');
          assert.equal(result.bucket, 'sanitation-media');
          assert.equal(result.totalBytes, 4096);
          assert.equal(result.objectCount, 1);
          assert.equal(result.storageWarning.code, 'S3_LIST_PERMISSION_DENIED');
          assert.equal(result.storageWarning.awsStatusCode, 403);
          assert.equal(result.tenants[0].source, 'db_media_records');
        }
      );
    }
  );
});
