const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PPM_ALERT_THRESHOLDS,
  resolvePpmOdorTier,
} = require('../src/modules/sensors/ppmOdorTier.service');
const { evaluateSensorMetrics, STATUS } = require('../src/modules/sensors/sensorThreshold.service');

test('PPM odor policy uses the approved 0-120+ boundaries', () => {
  assert.equal(resolvePpmOdorTier(0)?.key, 'excellent');
  assert.equal(resolvePpmOdorTier(15)?.key, 'excellent');
  assert.equal(resolvePpmOdorTier(16)?.key, 'good');
  assert.equal(resolvePpmOdorTier(40)?.key, 'good');
  assert.equal(resolvePpmOdorTier(41)?.key, 'moderate');
  assert.equal(resolvePpmOdorTier(75)?.key, 'moderate');
  assert.equal(resolvePpmOdorTier(76)?.key, 'bad');
  assert.equal(resolvePpmOdorTier(120)?.key, 'bad');
  assert.equal(resolvePpmOdorTier(120.01)?.key, 'critical');
  assert.equal(resolvePpmOdorTier(-1), null);
  assert.equal(resolvePpmOdorTier('not-a-number'), null);
});

test('PPM score adjustment is bounded and keeps the 41-75 band light', () => {
  assert.equal(resolvePpmOdorTier(0)?.scoreAdjustment, 20);
  assert.equal(resolvePpmOdorTier(15)?.scoreAdjustment, 10);
  assert.equal(resolvePpmOdorTier(16)?.scoreAdjustment, 10);
  assert.equal(resolvePpmOdorTier(40)?.scoreAdjustment, 1);
  assert.equal(resolvePpmOdorTier(41)?.scoreAdjustment, -1);
  assert.equal(resolvePpmOdorTier(75)?.scoreAdjustment, -5);
  assert.equal(resolvePpmOdorTier(76)?.scoreAdjustment, -5);
  assert.equal(resolvePpmOdorTier(120)?.scoreAdjustment, -10);
  assert.equal(resolvePpmOdorTier(121)?.scoreAdjustment, -20);
});

test('live alerts start at Bad and become critical only above 120 PPM', () => {
  assert.deepEqual(PPM_ALERT_THRESHOLDS, { warning: 76, critical: 121 });
  const overrides = { ppm: PPM_ALERT_THRESHOLDS };

  assert.equal(evaluateSensorMetrics({ ppm: 75 }, overrides).metrics.ppm.status, STATUS.NORMAL);
  assert.equal(evaluateSensorMetrics({ ppm: 76 }, overrides).metrics.ppm.status, STATUS.WARNING);
  assert.equal(evaluateSensorMetrics({ ppm: 120 }, overrides).metrics.ppm.status, STATUS.WARNING);
  assert.equal(evaluateSensorMetrics({ ppm: 121 }, overrides).metrics.ppm.status, STATUS.CRITICAL);
});
