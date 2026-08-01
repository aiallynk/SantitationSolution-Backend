const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDateRange } = require('../src/utils/dateRange');

test('today resolves to Asia/Kolkata day boundaries converted to UTC', () => {
  const range = resolveDateRange(
    { range: 'today' },
    { now: new Date('2026-06-22T12:00:00.000Z'), maxDays: 90 },
  );

  assert.equal(range.start.toISOString(), '2026-06-21T18:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-06-22T12:00:00.000Z');
});

test('date-only custom filters are interpreted as Asia/Kolkata dates', () => {
  const range = resolveDateRange({ from: '2026-06-22', to: '2026-06-22' });

  assert.equal(range.start.toISOString(), '2026-06-21T18:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-06-22T18:30:00.000Z');
});

test('startDate and endDate aliases are interpreted as inclusive Asia/Kolkata day boundaries', () => {
  const range = resolveDateRange({ startDate: '2026-07-01', endDate: '2026-07-15' });

  assert.equal(range.start.toISOString(), '2026-06-30T18:30:00.000Z');
  assert.equal(range.end.toISOString(), '2026-07-15T18:30:00.000Z');
  assert.equal(range.range, 'custom');
});

test('reversed custom ranges are rejected with a 400 validation error', () => {
  assert.throws(
    () => resolveDateRange({ startDate: '2026-07-29', endDate: '2026-07-28' }),
    (error) => error?.statusCode === 400 && error?.code === 'INVALID_DATE_RANGE',
  );
});

test('partial custom ranges are rejected with a 400 validation error', () => {
  assert.throws(
    () => resolveDateRange({ startDate: '2026-07-29' }),
    (error) => error?.statusCode === 400 && error?.code === 'INVALID_DATE_RANGE',
  );
});
