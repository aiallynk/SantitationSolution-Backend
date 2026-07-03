'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
