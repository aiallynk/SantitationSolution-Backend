const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateRegisterSensor,
} = require('../src/modules/sensors/sensor.validator');
const {
  validateInspectionSensorReading,
} = require('../src/modules/inspections/inspection.validator');

/* --------------------- sensor registration validator ---------------------- */

test('validateRegisterSensor requires only deviceId (no toilet needed)', () => {
  assert.deepEqual(validateRegisterSensor({ body: {} }), ['deviceId is required']);
  // A discovered device with just an id is enough to register (pre-commissioning).
  assert.deepEqual(
    validateRegisterSensor({ body: { deviceId: 'Wand_1234' } }),
    []
  );
});

test('validateRegisterSensor rejects an invalid tenantId when provided', () => {
  assert.deepEqual(
    validateRegisterSensor({ body: { deviceId: 'Wand_1234', tenantId: 'bad' } }),
    ['tenantId must be a valid id']
  );
  assert.deepEqual(
    validateRegisterSensor({
      body: {
        deviceId: 'Wand_1234',
        tenantId: '11111111-1111-4111-8111-111111111111',
      },
    }),
    []
  );
});

test('validateRegisterSensor rejects a non-numeric batteryLevel', () => {
  assert.deepEqual(
    validateRegisterSensor({ body: { deviceId: 'Wand_1234', batteryLevel: 'full' } }),
    ['batteryLevel must be a number']
  );
  assert.deepEqual(
    validateRegisterSensor({ body: { deviceId: 'Wand_1234', batteryLevel: 87 } }),
    []
  );
});

/* ------------------ inspection sensor-snapshot link validator -------------- */

test('validateInspectionSensorReading needs an id plus a reading or snapshot', () => {
  // Missing both reading id and snapshot.
  assert.deepEqual(
    validateInspectionSensorReading({ params: { id: 'abc' }, body: {} }),
    ['sensorReadingId or sensorSnapshot is required']
  );
  // A snapshot alone is sufficient (offline-captured, no server reading id yet).
  assert.deepEqual(
    validateInspectionSensorReading({
      params: { id: 'abc' },
      body: { sensorSnapshot: { temperature: 32.4, humidity: 59.4 } },
    }),
    []
  );
  // A persisted reading id alone is sufficient.
  assert.deepEqual(
    validateInspectionSensorReading({
      params: { id: 'abc' },
      body: { sensorReadingId: 'reading-1' },
    }),
    []
  );
});

test('validateInspectionSensorReading requires the inspection id param', () => {
  const errors = validateInspectionSensorReading({
    params: {},
    body: { sensorSnapshot: { temperature: 1 } },
  });
  assert.ok(errors.includes('inspection id is required'));
});
