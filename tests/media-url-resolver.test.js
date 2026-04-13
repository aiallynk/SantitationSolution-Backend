const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeMediaUrl,
  deriveObjectKeyFromUrl,
} = require('../src/modules/media/mediaUrl.service');

test('normalizeMediaUrl rewrites legacy /static/uploads path', () => {
  const normalized = normalizeMediaUrl('/static/uploads/sanitation/tenant/a.jpg');
  assert.equal(normalized, '/static/sanitation/tenant/a.jpg');
});

test('deriveObjectKeyFromUrl supports s3 locator URLs', () => {
  const objectKey = deriveObjectKeyFromUrl('s3://sanitation-s3/sanitation/tenant-1/image-1.jpg');
  assert.equal(objectKey, 'sanitation/tenant-1/image-1.jpg');
});

test('deriveObjectKeyFromUrl decodes escaped paths in s3 locator URLs', () => {
  const objectKey = deriveObjectKeyFromUrl(
    's3://sanitation-s3/sanitation/tenant-1/floor%20before/image-1.jpg'
  );
  assert.equal(objectKey, 'sanitation/tenant-1/floor before/image-1.jpg');
});

test('deriveObjectKeyFromUrl supports classic S3 https URLs', () => {
  const objectKey = deriveObjectKeyFromUrl(
    'https://sanitation-s3.s3.ap-south-1.amazonaws.com/sanitation/tenant-1/image-2.jpg'
  );
  assert.equal(objectKey, 'sanitation/tenant-1/image-2.jpg');
});

test('deriveObjectKeyFromUrl ignores already signed S3 URLs', () => {
  const objectKey = deriveObjectKeyFromUrl(
    'https://sanitation-s3.s3.ap-south-1.amazonaws.com/sanitation/tenant-1/image-2.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc'
  );
  assert.equal(objectKey, null);
});

