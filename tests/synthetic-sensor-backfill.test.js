const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HARD_BOUNDS,
  generateSyntheticSensorSnapshot,
  pickBand,
} = require('../src/modules/sensors/syntheticSensorBackfill.generator');
const { resolveIstDateRange } = require('../scripts/backfill-inspection-sensor-snapshots');

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

test('IST date range conversion uses explicit UTC boundaries', () => {
  const range = resolveIstDateRange({ fromIst: '2026-05-01', toIst: '2026-06-20' });
  assert.equal(range.startUtcIso, '2026-04-30T18:30:00.000Z');
  assert.equal(range.endExclusiveUtcIso, '2026-06-20T18:30:00.000Z');
});
