const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  HARD_BOUNDS,
  generateSyntheticSensorSnapshot,
  pickBand,
  resolveInspectionTime,
} = require('../src/modules/sensors/syntheticSensorBackfill.generator');
const { resolveIstDateRange } = require('../scripts/backfill-inspection-sensor-snapshots');
const { toSensorMetrics } = require('../src/modules/sensors/sensorMetrics');

const GENERATOR_PATH = path.join(__dirname, '..', 'src', 'modules', 'sensors', 'syntheticSensorBackfill.generator.js');

const baseInput = {
  inspectionId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  toiletUnitId: '33333333-3333-4333-8333-333333333333',
  capturedAt: '2026-05-10T04:30:00.000Z',
  submittedAt: '2026-05-10T04:36:00.000Z',
  scoreSourceField: 'avg_after_score',
  batchId: 'sensor-history-20260501-20260620-v1',
  generatedAt: '2026-06-20T07:00:00.000Z',
  avgBeforeScore: 30,
  avgAfterScore: 85,
};

const scores = [0, 1, 29, 30, 49, 50, 69, 70, 84, 85, 99, 100];

test('score bands match historical backfill boundaries', () => {
  assert.equal(pickBand(0).label, 'critical');
  assert.equal(pickBand(29).label, 'critical');
  assert.equal(pickBand(30).label, 'poor');
  assert.equal(pickBand(49).label, 'poor');
  assert.equal(pickBand(50).label, 'average');
  assert.equal(pickBand(69).label, 'average');
  assert.equal(pickBand(70).label, 'good');
  assert.equal(pickBand(84).label, 'good');
  assert.equal(pickBand(85).label, 'excellent');
  assert.equal(pickBand(100).label, 'excellent');
});

test('generated snapshots stay within hard bounds for boundary scores', () => {
  for (const score of scores) {
    const snapshot = generateSyntheticSensorSnapshot({ ...baseInput, selectedScore: score });
    assert.ok(snapshot.score >= HARD_BOUNDS.sensorScore[0] && snapshot.score <= HARD_BOUNDS.sensorScore[1]);
    assert.ok(snapshot.field1 >= HARD_BOUNDS.sensorScore[0] && snapshot.field1 <= HARD_BOUNDS.sensorScore[1]);
    assert.ok(snapshot.temperature >= HARD_BOUNDS.temperature[0] && snapshot.temperature <= HARD_BOUNDS.temperature[1]);
    assert.ok(snapshot.humidity >= HARD_BOUNDS.humidity[0] && snapshot.humidity <= HARD_BOUNDS.humidity[1]);
    assert.ok(snapshot.mq135 >= HARD_BOUNDS.mq135[0] && snapshot.mq135 <= HARD_BOUNDS.mq135[1]);
    assert.ok(snapshot.mq137 >= HARD_BOUNDS.mq137[0] && snapshot.mq137 <= HARD_BOUNDS.mq137[1]);
    assert.ok(snapshot.batteryLevel >= HARD_BOUNDS.batteryLevel[0] && snapshot.batteryLevel <= HARD_BOUNDS.batteryLevel[1]);
    assert.ok(snapshot.rssi >= HARD_BOUNDS.rssi[0] && snapshot.rssi <= HARD_BOUNDS.rssi[1]);
  }
});

test('generated raw payload is synchronized with top-level fields', () => {
  const snapshot = generateSyntheticSensorSnapshot({ ...baseInput, selectedScore: 85 });
  assert.equal(
    snapshot.rawPayload,
    [
      snapshot.score.toFixed(1),
      snapshot.mq135.toFixed(2),
      snapshot.mq137.toFixed(2),
      snapshot.temperature.toFixed(1),
      snapshot.humidity.toFixed(1),
    ].join(',')
  );
  assert.deepEqual(snapshot.fields, {
    field_1: snapshot.score,
    field_2: snapshot.mq135,
    field_3: snapshot.mq137,
    field_4: snapshot.temperature,
    field_5: snapshot.humidity,
  });
});

test('generator is deterministic for the same input and varies by inspection id', () => {
  const first = generateSyntheticSensorSnapshot({ ...baseInput, selectedScore: 70 });
  const second = generateSyntheticSensorSnapshot({ ...baseInput, selectedScore: 70 });
  const third = generateSyntheticSensorSnapshot({
    ...baseInput,
    inspectionId: '44444444-4444-4444-8444-444444444444',
    selectedScore: 70,
  });
  assert.deepEqual(first, second);
  assert.notEqual(first.rawPayload, third.rawPayload);
});

test('inspection time prefers actual image capture time over UTC-midnight placeholders', () => {
  const resolved = resolveInspectionTime({
    capturedAt: '2026-05-10T00:00:00.000Z',
    submittedAt: '2026-05-10T12:20:00.000Z',
    mediaCapturedAt: '2026-05-10T09:42:00.000Z',
  });
  assert.equal(resolved.toISOString(), '2026-05-10T09:42:00.000Z');

  const snapshot = generateSyntheticSensorSnapshot({
    ...baseInput,
    capturedAt: '2026-05-10T00:00:00.000Z',
    submittedAt: '2026-05-10T12:20:00.000Z',
    mediaCapturedAt: '2026-05-10T09:42:00.000Z',
    selectedScore: 85,
  });
  assert.equal(snapshot.readingTime, '2026-05-10T09:42:00.000Z');
});

test('IST date range conversion uses explicit UTC boundaries', () => {
  const range = resolveIstDateRange({ fromIst: '2026-05-01', toIst: '2026-06-20' });
  assert.equal(range.startUtcIso, '2026-04-30T18:30:00.000Z');
  assert.equal(range.endExclusiveUtcIso, '2026-06-20T18:30:00.000Z');
});

test('generator is fully local: no AI/API/network/key usage', () => {
  const src = fs.readFileSync(GENERATOR_PATH, 'utf8');
  // Only Node built-in crypto may be required.
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['crypto'], `unexpected requires: ${requires.join(', ')}`);
  // No AI provider / network / secret usage of any kind.
  const forbidden = [
    /openai/i,
    /anthropic/i,
    /\bclaude\b/i,
    /\bgpt\b/i,
    /\bllm\b/i,
    /api[_-]?key/i,
    /apiKey/,
    /axios/i,
    /node-fetch/i,
    /\bfetch\s*\(/,
    /require\(\s*['"]https?['"]\s*\)/,
    /cloudinary/i,
    /aws-sdk|s3/i,
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(src), false, `generator must not reference ${pattern}`);
  }
});

test('synthetic snapshot (sensorReadingId: null) still yields chartable metrics with markers', () => {
  // This is exactly what the dashboard inspection-snapshot-trend endpoint extracts
  // from inspections.sensor_snapshot via toSensorMetrics — it must work even though
  // synthetic backfill rows have no durable telemetry id.
  const snapshot = generateSyntheticSensorSnapshot({
    inspectionId: '55555555-5555-4555-8555-555555555555',
    tenantId: '66666666-6666-4666-8666-666666666666',
    toiletUnitId: '77777777-7777-4777-8777-777777777777',
    capturedAt: '2026-06-01T05:00:00.000Z',
    submittedAt: '2026-06-01T05:05:00.000Z',
    scoreSourceField: 'avg_after_score',
    batchId: 'sensor-history-20260501-20260620-v1',
    generatedAt: '2026-06-20T07:00:00.000Z',
    selectedScore: 72,
  });

  // Backfill provenance + no durable telemetry id.
  assert.equal(snapshot.sensorReadingId, null);
  assert.equal(snapshot.isSynthetic, true);
  assert.equal(snapshot.isBackfilled, true);
  assert.equal(snapshot.sensorDataSource, 'synthetic_historical_backfill');
  assert.equal(snapshot.backfillBatchId, 'sensor-history-20260501-20260620-v1');

  // The dashboard endpoint reads metrics through toSensorMetrics — all chartable
  // values must be finite numbers despite sensorReadingId being null.
  const metrics = toSensorMetrics(snapshot);
  for (const key of ['score', 'temperature', 'humidity', 'mq135', 'mq137']) {
    assert.ok(Number.isFinite(Number(metrics[key])), `${key} should be a finite number, got ${metrics[key]}`);
  }
});

test('generated values are score-correlated: cleaner scores -> lower gases/humidity', () => {
  const base = {
    inspectionId: '99999999-9999-4999-8999-999999999999',
    tenantId: '88888888-8888-4888-8888-888888888888',
    toiletUnitId: '77777777-7777-4777-8777-777777777777',
    capturedAt: '2026-05-10T04:30:00.000Z',
    submittedAt: '2026-05-10T04:36:00.000Z',
    scoreSourceField: 'avg_after_score',
    batchId: 'sensor-history-20260501-20260620-v1',
    generatedAt: '2026-06-20T07:00:00.000Z',
  };
  const clean = generateSyntheticSensorSnapshot({ ...base, selectedScore: 95 });
  const dirty = generateSyntheticSensorSnapshot({ ...base, selectedScore: 10 });
  assert.ok(clean.mq135 < dirty.mq135, 'clean MQ135 should be lower than dirty');
  assert.ok(clean.mq137 < dirty.mq137, 'clean MQ137 should be lower than dirty');
  assert.ok(clean.humidity < dirty.humidity, 'clean humidity should be lower than dirty');
  assert.ok(clean.score > dirty.score, 'clean sensor score should be higher than dirty');
  // Raw analog ranges (not ppm): bounded by HARD_BOUNDS.
  assert.ok(dirty.mq135 <= HARD_BOUNDS.mq135[1] && clean.mq135 >= HARD_BOUNDS.mq135[0]);
});
