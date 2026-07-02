const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveInspectionDisplayTime,
} = require('../src/modules/inspections/inspectionEvidence.service');

test('resolves legacy image local-as-UTC capture time before submitted time', () => {
  const inspection = {
    id: '82f0818f-2ad8-4287-8328-49d66ddbefb0',
    captured_at: '2026-06-29T11:56:32.369Z',
    captured_at_utc: '2026-06-29T11:56:32.369Z',
    capture_timezone: 'Asia/Kolkata',
    capture_offset_minutes: 330,
    capture_time_source: 'legacy_captured_at',
    submitted_at: '2026-06-29T12:10:59.362Z',
    created_at: '2026-06-29T06:26:32.338Z',
  };
  const mediaRows = [
    {
      capture_stage: 'before',
      captured_at: '2026-06-29T11:56:32.786Z',
      captured_at_utc: '2026-06-29T11:56:32.786Z',
      capture_timezone: 'Asia/Kolkata',
      capture_offset_minutes: 330,
      capture_time_source: 'legacy_captured_at',
      created_at: '2026-06-29T06:26:32.734Z',
    },
  ];

  const resolved = resolveInspectionDisplayTime(inspection, {
    mediaRows,
    displayTimezone: 'Asia/Kolkata',
  });

  assert.equal(resolved.capturedAtUtc, '2026-06-29T06:26:32.786Z');
  assert.equal(resolved.submittedAtUtc, '2026-06-29T12:10:59.362Z');
  assert.equal(resolved.displaySource, 'before_image_capture');
  assert.equal(resolved.correctedLegacyLocalAsUtc, true);
  assert.match(resolved.warning, /Legacy capture timestamp/);
});
