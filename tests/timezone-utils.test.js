const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatInTimezone,
  getTimezoneOffsetMinutes,
  isValidIanaTimezone,
  normalizeTimezone,
  resolveCaptureTimestamp,
} = require('../src/utils/timezone');

test('formats one UTC instant in supported display timezones', () => {
  const utc = '2026-06-30T05:00:00.000Z';

  assert.match(formatInTimezone(utc, 'Asia/Kolkata'), /10:30.*GMT\+5:30|10:30.*IST/i);
  assert.match(formatInTimezone(utc, 'Asia/Manila'), /01:00.*GMT\+8|01:00.*PHT|01:00.*PST/i);
  assert.match(formatInTimezone(utc, 'Australia/Sydney'), /03:00.*GMT\+10|03:00.*AEST/i);
  assert.match(formatInTimezone(utc, 'Australia/Perth'), /01:00.*GMT\+8|01:00.*AWST/i);
  assert.match(formatInTimezone(utc, 'Europe/London'), /06:00.*GMT\+1|06:00.*BST/i);
  assert.match(formatInTimezone(utc, 'Europe/Berlin'), /07:00.*GMT\+2|07:00.*CEST/i);
});

test('calculates daylight-saving-aware offsets', () => {
  assert.equal(getTimezoneOffsetMinutes('2026-06-30T05:00:00.000Z', 'Europe/London'), 60);
  assert.equal(getTimezoneOffsetMinutes('2026-12-30T05:00:00.000Z', 'Europe/London'), 0);
  assert.equal(getTimezoneOffsetMinutes('2026-06-30T05:00:00.000Z', 'Australia/Sydney'), 600);
  assert.equal(getTimezoneOffsetMinutes('2026-12-30T05:00:00.000Z', 'Australia/Sydney'), 660);
});

test('normalizes invalid and missing timezones to India fallback', () => {
  assert.equal(isValidIanaTimezone('Mars/Base'), false);
  assert.equal(normalizeTimezone('Mars/Base'), 'Asia/Kolkata');
  assert.equal(normalizeTimezone(''), 'Asia/Kolkata');
});

test('capture payload prefers capturedAtUtc and preserves source metadata', () => {
  const payload = resolveCaptureTimestamp({
    capturedAtLocal: '2026-06-30T10:30:00',
    capturedAtUtc: '2026-06-30T05:00:00.000Z',
    captureTimezone: 'Asia/Kolkata',
    captureOffsetMinutes: 330,
  });

  assert.equal(payload.capturedAtUtc.toISOString(), '2026-06-30T05:00:00.000Z');
  assert.equal(payload.captureTimezone, 'Asia/Kolkata');
  assert.equal(payload.captureOffsetMinutes, 330);
  assert.equal(payload.captureTimeSource, 'client_captured_at_utc');
});
