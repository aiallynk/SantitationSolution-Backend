const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ACTIVE_TASK_STATUSES,
  getCriticalComplaintValueSet,
  haversineDistanceKm,
  isValidLatitude,
  isValidLongitude,
  normalizeToken,
} = require('../src/modules/automation/automation.constants');

test('critical complaint values are normalized for matching', () => {
  const values = getCriticalComplaintValueSet();
  assert.equal(values.has('critical'), true);
  assert.equal(values.has('very_bad'), true);
  assert.equal(normalizeToken('Very Bad'), 'very_bad');
});

test('active automation statuses include assignment lifecycle states', () => {
  assert.equal(ACTIVE_TASK_STATUSES.includes('unassigned'), true);
  assert.equal(ACTIVE_TASK_STATUSES.includes('assigned'), true);
  assert.equal(ACTIVE_TASK_STATUSES.includes('accepted'), true);
  assert.equal(ACTIVE_TASK_STATUSES.includes('completed'), false);
});

test('haversine distance and location validators handle worker assignment inputs', () => {
  const distance = haversineDistanceKm(
    { latitude: 28.6139, longitude: 77.209 },
    { latitude: 28.7041, longitude: 77.1025 },
  );
  assert.equal(isValidLatitude(28.6139), true);
  assert.equal(isValidLongitude(77.209), true);
  assert.equal(isValidLatitude(123), false);
  assert.equal(isValidLongitude(200), false);
  assert.equal(distance > 10 && distance < 20, true);
});
