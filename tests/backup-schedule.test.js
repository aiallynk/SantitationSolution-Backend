const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nextDailyRun,
  previousDailyRun,
  normalizeRunTime,
  normalizeScheduleTimezone,
  normalizeTimeFormat,
} = require('../src/modules/backups/backupSchedule');

test('calculates the next backup instant in the selected superadmin timezone', () => {
  const beforeRun = new Date('2026-07-03T07:40:00.000Z'); // 13:10 Asia/Kolkata
  assert.equal(
    nextDailyRun('13:13:00', 'Asia/Kolkata', beforeRun).toISOString(),
    '2026-07-03T07:43:00.000Z',
  );

  const afterRun = new Date('2026-07-03T07:44:00.000Z');
  assert.equal(
    nextDailyRun('13:13:00', 'Asia/Kolkata', afterRun).toISOString(),
    '2026-07-04T07:43:00.000Z',
  );
});

test('daily backup calculation honors daylight saving offsets', () => {
  assert.equal(
    nextDailyRun('09:00', 'Europe/London', '2026-07-03T07:00:00.000Z').toISOString(),
    '2026-07-03T08:00:00.000Z',
  );
  assert.equal(
    nextDailyRun('09:00', 'Europe/London', '2026-12-03T07:00:00.000Z').toISOString(),
    '2026-12-03T09:00:00.000Z',
  );
});

test('calculates the most recent scheduled occurrence for startup reconciliation', () => {
  assert.equal(
    previousDailyRun('13:13', 'Asia/Kolkata', '2026-07-03T07:44:00.000Z').toISOString(),
    '2026-07-03T07:43:00.000Z',
  );
  assert.equal(
    previousDailyRun('13:13', 'Asia/Kolkata', '2026-07-03T07:40:00.000Z').toISOString(),
    '2026-07-02T07:43:00.000Z',
  );
});

test('backup schedule validation rejects invalid times and timezones', () => {
  assert.equal(normalizeRunTime('02:30'), '02:30:00');
  assert.throws(() => normalizeRunTime('25:00'), /valid 24-hour time/);
  assert.throws(
    () => normalizeScheduleTimezone('Mars/Base', { strict: true }),
    /valid IANA timezone/,
  );
  assert.equal(normalizeTimeFormat('12'), '12');
  assert.equal(normalizeTimeFormat('24'), '24');
  assert.throws(() => normalizeTimeFormat('16'), /must be 12 or 24/);
});
