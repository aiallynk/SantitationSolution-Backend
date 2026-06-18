const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeToiletRiskWeight,
  normalizeComplaintRisk,
  normalizeOverdueRisk,
} = require('../src/modules/platform/toiletMapRisk.helper');

const NOW = new Date('2026-06-05T00:00:00.000Z').getTime();

test('risk weight treats high cleanliness as low risk', () => {
  const clean = computeToiletRiskWeight({
    latestScore: 92,
    activeComplaintsCount: 0,
    lastInspectionAt: '2026-06-04T00:00:00.000Z',
    expectedInspectionDays: 7,
    dirtyFrequency: 0,
    lowPerformanceFrequency: 0,
    priority: 'low',
    now: NOW,
  });

  const dirty = computeToiletRiskWeight({
    latestScore: 28,
    activeComplaintsCount: 3,
    lastInspectionAt: '2026-05-01T00:00:00.000Z',
    expectedInspectionDays: 7,
    dirtyFrequency: 80,
    lowPerformanceFrequency: 60,
    priority: 'high',
    now: NOW,
  });

  assert.ok(clean.riskWeight < dirty.riskWeight);
  assert.ok(clean.riskWeight < 25);
  assert.ok(dirty.riskWeight > 65);
});

test('complaints and overdue inspection normalize to bounded risk', () => {
  assert.equal(normalizeComplaintRisk(0), 0);
  assert.equal(normalizeComplaintRisk(4), 100);
  assert.equal(normalizeOverdueRisk({ lastInspectionAt: null, now: NOW }), 70);
  assert.equal(
    normalizeOverdueRisk({
      lastInspectionAt: '2026-04-01T00:00:00.000Z',
      expectedInspectionDays: 7,
      now: NOW,
    }),
    100
  );
});
