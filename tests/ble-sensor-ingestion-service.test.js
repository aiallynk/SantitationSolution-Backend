const test = require('node:test');
const assert = require('node:assert/strict');

const auditPath = require.resolve('../src/modules/audit/audit.service');
const originalAuditModule = require.cache[auditPath];
require.cache[auditPath] = {
  id: auditPath,
  filename: auditPath,
  loaded: true,
  exports: {
    createAuditLog: async () => null,
  },
};

const models = require('../src/models');
const sensorService = require('../src/modules/sensors/sensor.service');

if (originalAuditModule) {
  require.cache[auditPath] = originalAuditModule;
}

const ORIGINALS = {
  SensorDeviceFindOne: models.SensorDevice.findOne,
  SensorDeviceFindAll: models.SensorDevice.findAll,
  SensorReadingFindOne: models.SensorReading.findOne,
  SensorReadingCreate: models.SensorReading.create,
  AlertFindOne: models.Alert.findOne,
};

const DEVICE_UUID = '11111111-1111-4111-8111-111111111111';
const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const FACILITY_A = '44444444-4444-4444-8444-444444444444';
const FACILITY_B = '55555555-5555-4555-8555-555555555555';
const TOILET_A = '66666666-6666-4666-8666-666666666666';
const TOILET_B = '77777777-7777-4777-8777-777777777777';

const reqFor = (body, overrides = {}) => ({
  body,
  user: {
    id: 'user-1',
    tenantId: TENANT_A,
    isSuperAdmin: false,
    scopeLevel: 'organization',
    scopeFacilityIds: [],
    ...overrides,
  },
});

const makeDevice = (overrides = {}) => ({
  id: DEVICE_UUID,
  tenant_id: TENANT_A,
  facility_id: FACILITY_A,
  toilet_unit_id: TOILET_A,
  device_id: 'Wand_1234',
  status: 'active',
  last_seen_at: null,
  update: async function update(values) {
    Object.assign(this, values);
    return this;
  },
  ...overrides,
});

const makeReading = (overrides = {}) => ({
  id: 'reading-1',
  device_id: DEVICE_UUID,
  client_reading_id: 'client-1',
  timestamp: new Date('2026-06-11T10:00:00.000Z'),
  odor_ppm: null,
  ammonia_ppm: null,
  h2s_ppm: null,
  methane_ppm: null,
  humidity: 59.4,
  temperature: 32.4,
  occupancy_count: null,
  footfall_count: null,
  tank_fill_level: null,
  battery_level: null,
  signal_strength: -62,
  raw_payload: { raw: '10,0.00,1.28,32.4,59.4' },
  ...overrides,
});

const resetStubs = () => {
  models.SensorDevice.findOne = ORIGINALS.SensorDeviceFindOne;
  models.SensorDevice.findAll = ORIGINALS.SensorDeviceFindAll;
  models.SensorReading.findOne = ORIGINALS.SensorReadingFindOne;
  models.SensorReading.create = ORIGINALS.SensorReadingCreate;
  models.Alert.findOne = ORIGINALS.AlertFindOne;
};

test.afterEach(resetStubs);

const installHappyPathStubs = ({ device = makeDevice(), existingReading = null } = {}) => {
  models.SensorDevice.findOne = async () => device;
  models.SensorReading.findOne = async () => existingReading;
  models.SensorReading.create = async (payload) => makeReading(payload);
  models.Alert.findOne = async () => null;
};

test('ingestion stores parsed BLE reading for the backend-attached toilet', async () => {
  installHappyPathStubs();

  const result = await sensorService.ingestSensorReading(
    reqFor({
      deviceId: 'Wand_1234',
      toiletUnitId: TOILET_A,
      clientReadingId: 'client-1',
      rawPayload: '10,0.00,1.28,32.4,59.4',
      rssi: -62,
      source: 'mobile_ble',
    })
  );

  assert.equal(result.duplicate, false);
  assert.equal(Number(result.reading.temperature), 32.4);
  assert.equal(Number(result.reading.humidity), 59.4);
  assert.equal(Number(result.reading.signalStrength), -62);
  assert.equal(result.reading.rawPayload.raw, '10,0.00,1.28,32.4,59.4');
  assert.equal(result.reading.rawPayload.fields.field_1, 10);
});

test('ingestion is idempotent by device and clientReadingId', async () => {
  installHappyPathStubs({ existingReading: makeReading({ id: 'existing-reading' }) });

  const result = await sensorService.ingestSensorReading(
    reqFor({
      deviceId: 'Wand_1234',
      toiletUnitId: TOILET_A,
      clientReadingId: 'client-1',
      rawPayload: '10,0.00,1.28,32.4,59.4',
    })
  );

  assert.equal(result.duplicate, true);
  assert.equal(result.reading.id, 'existing-reading');
});

test('ingestion rejects a claimed toilet that differs from backend mapping', async () => {
  installHappyPathStubs();

  await assert.rejects(
    sensorService.ingestSensorReading(
      reqFor({
        deviceId: 'Wand_1234',
        toiletUnitId: TOILET_B,
        clientReadingId: 'client-2',
        rawPayload: '10,0.00,1.28,32.4,59.4',
      })
    ),
    (error) => error.statusCode === 409 && error.code === 'SENSOR_TOILET_MISMATCH'
  );
});

test('ingestion rejects a claimed toilet when the device is not attached', async () => {
  installHappyPathStubs({ device: makeDevice({ toilet_unit_id: null }) });

  await assert.rejects(
    sensorService.ingestSensorReading(
      reqFor({
        deviceId: 'Wand_1234',
        toiletUnitId: TOILET_A,
        clientReadingId: 'client-3',
        rawPayload: '10,0.00,1.28,32.4,59.4',
      })
    ),
    (error) => error.statusCode === 409 && error.code === 'SENSOR_TOILET_MISMATCH'
  );
});

test('ingestion blocks cross-tenant sensor access', async () => {
  installHappyPathStubs({ device: makeDevice({ tenant_id: TENANT_B }) });

  await assert.rejects(
    sensorService.ingestSensorReading(
      reqFor({
        deviceId: 'Wand_1234',
        clientReadingId: 'client-4',
        rawPayload: '10,0.00,1.28,32.4,59.4',
      })
    ),
    (error) => error.statusCode === 403 && error.code === 'SCOPE_FORBIDDEN'
  );
});

test('ingestion blocks facility-scoped supervisors outside their scope', async () => {
  installHappyPathStubs({ device: makeDevice({ facility_id: FACILITY_B }) });

  await assert.rejects(
    sensorService.ingestSensorReading(
      reqFor(
        {
          deviceId: 'Wand_1234',
          clientReadingId: 'client-5',
          rawPayload: '10,0.00,1.28,32.4,59.4',
        },
        {
          scopeLevel: 'facility',
          scopeFacilityIds: [FACILITY_A],
        }
      )
    ),
    (error) => error.statusCode === 403 && error.code === 'SCOPE_FORBIDDEN'
  );
});

test('ingestion allows field workers in the same tenant outside facility scope', async () => {
  installHappyPathStubs({ device: makeDevice({ facility_id: FACILITY_B }) });

  const result = await sensorService.ingestSensorReading(
    reqFor(
      {
        deviceId: 'Wand_1234',
        clientReadingId: 'client-6',
        rawPayload: '10,0.00,1.28,32.4,59.4',
      },
      {
        scopeLevel: 'facility',
        scopeFacilityIds: [FACILITY_A],
        roleCodes: ['field_worker'],
      }
    )
  );

  assert.equal(result.duplicate, false);
  assert.equal(Number(result.reading.temperature), 32.4);
});

test('ingestion allows unattached devices for tenant field workers', async () => {
  installHappyPathStubs({
    device: makeDevice({ facility_id: null, toilet_unit_id: null, status: 'inactive' }),
  });

  const result = await sensorService.ingestSensorReading(
    reqFor(
      {
        deviceId: 'Wand_1234',
        clientReadingId: 'client-7',
        rawPayload: '10,0.00,1.28,32.4,59.4',
      },
      {
        scopeLevel: 'facility',
        scopeFacilityIds: [FACILITY_A],
        roleCodes: ['field_worker'],
      }
    )
  );

  assert.equal(result.duplicate, false);
  assert.equal(Number(result.reading.humidity), 59.4);
});
