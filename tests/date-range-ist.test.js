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
  assert.equal(range.end.toISOString(), '2026-06-22T18:29:59.999Z');
});
