const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSensorPayload } = require('../src/modules/sensors/sensorPayload.parser');
const {
  validateIngestion,
  validateAttachSensor,
} = require('../src/modules/sensors/sensor.validator');
const { ROLE_PERMISSION_BUNDLES } = require('../src/core/rbac/defaultRoleBundles');

/* --------------------------- payload parser ------------------------------- */

test('parser maps V3 3-field payload (field_1=ppm, field_2=temp, field_3=humidity)', () => {
  const result = parseSensorPayload('10.0,32.4,59.4');
  assert.equal(result.version, 'v3');
  assert.equal(result.fieldCount, 3);
  assert.equal(result.parsed.ppm, 10.0);
  assert.equal(result.parsed.temperature, 32.4);
  assert.equal(result.parsed.humidity, 59.4);
  assert.deepEqual(result.fields, {
    field_1: 10,
    field_2: 32.4,
    field_3: 59.4,
  });
});

test('parser always preserves the verbatim raw payload', () => {
  const raw = '10.0,32.4,59.4';
  assert.equal(parseSensorPayload(raw).raw, raw);
});

test('parser accepts array input and unknown shapes without throwing', () => {
  const arr = parseSensorPayload([10, 21.5, 40]);
  assert.equal(arr.version, 'v3');
  assert.equal(arr.parsed.ppm, 10);
  assert.equal(arr.parsed.temperature, 21.5);
  assert.equal(arr.parsed.humidity, 40);

  const unknown = parseSensorPayload('x,y');
  assert.equal(unknown.version, 'unknown');
  assert.deepEqual(unknown.fields, { field_1: null, field_2: null });

  const empty = parseSensorPayload('');
  assert.equal(empty.version, 'empty');
  assert.equal(empty.fieldCount, 0);
});

test('parser extracts raw string from object envelopes', () => {
  const result = parseSensorPayload({ raw: '10.0,32.4,59.4' });
  assert.equal(result.raw, '10.0,32.4,59.4');
  assert.equal(result.parsed.humidity, 59.4);
});

/* ------------------------------ validators -------------------------------- */

test('validateAttachSensor requires deviceId and a valid toiletUnitId', () => {
  assert.deepEqual(validateAttachSensor({ body: {} }), [
    'deviceId is required',
    'toiletUnitId is required',
  ]);
  assert.deepEqual(
    validateAttachSensor({ body: { deviceId: 'Wand_1234', toiletUnitId: 'not-a-uuid' } }),
    ['toiletUnitId must be a valid id']
  );
  assert.deepEqual(
    validateAttachSensor({
      body: { deviceId: 'Wand_1234', toiletUnitId: '11111111-1111-4111-8111-111111111111' },
    }),
    []
  );
});

test('validateIngestion rejects an invalid toiletUnitId when provided', () => {
  assert.deepEqual(
    validateIngestion({ body: { deviceId: 'Wand_1234', toiletUnitId: 'bad' } }),
    ['toiletUnitId must be a valid id']
  );
  assert.deepEqual(
    validateIngestion({
      body: { deviceId: 'Wand_1234', toiletUnitId: '11111111-1111-4111-8111-111111111111' },
    }),
    []
  );
});

/* ------------------------------ RBAC bundles ------------------------------ */

test('field worker bundle grants sensor manage/ingest/read for mobile commissioning', () => {
  const fieldWorker = ROLE_PERMISSION_BUNDLES.field_worker || [];
  assert.ok(fieldWorker.includes('sensor.manage'), 'sensor.manage missing for field_worker');
  assert.ok(fieldWorker.includes('sensor.ingest'), 'sensor.ingest missing for field_worker');
  assert.ok(fieldWorker.includes('sensor.read'), 'sensor.read missing for field_worker');
});

test('management roles can manage sensors from the web', () => {
  assert.ok((ROLE_PERMISSION_BUNDLES.tenant_admin || []).includes('sensor.manage'));
  assert.ok((ROLE_PERMISSION_BUNDLES.facility_manager || []).includes('sensor.manage'));
});
