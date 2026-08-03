const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __testUtils: { computeSensorImpact },
} = require('../src/modules/analysis/analysis.service');

const sensorContext = (ppm, overrides = {}) => ({
  ppm,
  temperature: null,
  humidity: null,
  readingAgeMinutes: null,
  sensorStatus: 'ONLINE',
  readingTime: null,
  ...overrides,
});

test('analysis applies the documented PPM tier effect rather than the retired >400 bracket', () => {
  const fresh = computeSensorImpact(sensorContext(15));
  const buffered = computeSensorImpact(sensorContext(41));
  const bad = computeSensorImpact(sensorContext(76));
  const critical = computeSensorImpact(sensorContext(121));

  assert.equal(fresh.sensorImpact, 10);
  assert.equal(buffered.sensorImpact, -1);
  assert.equal(bad.sensorImpact, -5);
  assert.equal(critical.sensorImpact, -20);
  assert.equal(buffered.ppmOdorTier?.key, 'moderate');
  assert.equal(critical.ppmOdorTier?.key, 'critical');
});

test('PPM adjustment remains bounded when another environmental signal is present', () => {
  const result = computeSensorImpact(sensorContext(121, { humidity: 90 }));
  assert.equal(result.nonPpmSensorImpact, -7);
  assert.equal(result.ppmImpact, -20);
  assert.equal(result.sensorImpact, -25);
  assert.equal(result.environmentalScore, 75);
});
