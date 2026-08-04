const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SensorConfidence,
  SensorValidity,
  classifySensorEvidence,
  toInspectionMediaSensorEvidenceFields,
} = require('../src/modules/sensors/sensorEvidenceV2.service');
const {
  scoreExplainableInspection,
} = require('../src/modules/analysis/explainableScoringV2.service');

const calibratedEvidence = (ppm = 58.7) => ({
  evidenceId: 'evidence-1',
  captureProtocolVersion: 'sensor-evidence-v2',
  calibrationVerified: true,
  warmupComplete: true,
  syncDeltaMs: 180,
  sensorTimestampSource: 'PHONE_RECEIVE_TIME',
  nearestSample: {
    ppm,
    temperature: 24.2,
    humidity: 55,
    parseStatus: 'PARSED',
    connectionState: 'CONNECTED',
    rssi: -60,
  },
  captureWindow: { sampleCount: 7, medianPpm: ppm, minPpm: ppm - 2, maxPpm: ppm + 2, spreadPpm: 4 },
});

const severeFindings = [
  { issue: 'Dirty toilet pan with heavy staining', severity: 'severe', confidence: 0.95 },
  { issue: 'Heavy floor staining and muddy footprints', severity: 'severe', confidence: 0.92 },
  { issue: 'Garbage and waste around the toilet', severity: 'severe', confidence: 0.9 },
];

test('zero without a verified calibrated profile is never fresh', () => {
  const result = classifySensorEvidence({
    ...calibratedEvidence(0),
    calibrationVerified: false,
  });
  assert.equal(result.validity, SensorValidity.DEFAULT_OR_ZERO_SUSPECT);
  assert.equal(result.confidence, SensorConfidence.INVALID);
  assert.notEqual(result.classification, 'LOW_CONCENTRATION');
});

test('same evidence is monotonic across Light, Medium and Strict', () => {
  const light = scoreExplainableInspection({ mode: 'light', findings: severeFindings, sensorEvidence: calibratedEvidence() });
  const medium = scoreExplainableInspection({ mode: 'medium', findings: severeFindings, sensorEvidence: calibratedEvidence() });
  const strict = scoreExplainableInspection({ mode: 'strict', findings: severeFindings, sensorEvidence: calibratedEvidence() });
  assert.ok(light.score >= medium.score);
  assert.ok(medium.score >= strict.score);
  assert.ok(light.score <= 50, 'multiple severe hygiene findings remain low in Light mode');
});

test('invalid sensor evidence cannot improve a visibly dirty inspection', () => {
  const invalidSensor = scoreExplainableInspection({ mode: 'medium', findings: severeFindings, sensorEvidence: null });
  const elevatedSensor = scoreExplainableInspection({ mode: 'medium', findings: severeFindings, sensorEvidence: calibratedEvidence(90) });
  assert.ok(invalidSensor.score <= 50);
  assert.ok(elevatedSensor.score <= invalidSensor.score);
  assert.equal(invalidSensor.components.environmental.weight, 0);
});

test('uncalibrated or warming-up V2 evidence has zero scoring weight', () => {
  const unverified = {
    ...calibratedEvidence(8),
    calibrationVerified: false,
    warmupComplete: false,
  };
  const baseline = scoreExplainableInspection({ mode: 'medium', findings: [], sensorEvidence: null });
  const result = scoreExplainableInspection({ mode: 'medium', findings: [], sensorEvidence: unverified });
  assert.equal(result.components.environmental.weight, 0);
  assert.equal(result.score, baseline.score);
});

test('clean and severe cases use distinct portions of the 0-100 scale', () => {
  const clean = scoreExplainableInspection({ mode: 'medium', findings: [], sensorEvidence: calibratedEvidence(20) });
  const severe = scoreExplainableInspection({ mode: 'medium', findings: severeFindings, sensorEvidence: calibratedEvidence(90) });
  assert.ok(clean.score >= 70);
  assert.ok(severe.score <= 45);
  assert.ok(clean.score - severe.score >= 25);
  assert.equal(clean.components.checklist.weight, 0, 'an absent checklist is not treated as a zero score');
});

test('phone capture payload stores an image-specific window and remains unclassified without device calibration', () => {
  const fields = toInspectionMediaSensorEvidenceFields({
    protocolVersion: 'sensor-evidence-v2',
    evidenceId: 'mobile-window-1',
    cameraOpenedAt: '2026-08-04T10:00:00.000Z',
    shutterRequestedAt: '2026-08-04T10:00:04.000Z',
    imageReturnedAt: '2026-08-04T10:00:04.180Z',
    imagePersistedAt: '2026-08-04T10:00:04.300Z',
    cameraTimestampSource: 'FLUTTER_SHUTTER_REQUEST',
    sensorTimestampSource: 'PHONE_RECEIVE_TIME',
    calibrationVerified: false,
    warmupComplete: false,
    syncDeltaMs: 120,
    nearestSample: {
      ppm: 8.9,
      sensorReceivedAt: '2026-08-04T10:00:04.120Z',
      phoneMonotonicReceivedMs: 4120,
      parseStatus: 'PARSED',
      connectionState: 'CONNECTED',
    },
    captureWindow: { sampleCount: 4, medianPpm: 9, minPpm: 8, maxPpm: 10, spreadPpm: 2 },
  });
  assert.equal(fields.evidence_id, 'mobile-window-1');
  assert.equal(fields.shutter_requested_at, '2026-08-04T10:00:04.000Z');
  assert.equal(fields.sensor_sample_count, 4);
  assert.equal(fields.sensor_window_median_ppm, 9);
  assert.equal(fields.sensor_sync_quality, SensorValidity.WARMING_UP);
  assert.notEqual(fields.sensor_evidence.validation.classification, 'LOW_CONCENTRATION');
});
