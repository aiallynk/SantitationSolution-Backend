const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_SCORING_POLICY_VERSION,
  resolveAiScoringMode,
  scoreInspectionFindings,
} = require('../src/modules/analysis/aiInspectionScoring.service');

const moderateFindings = [
  { area: 'floor', category: 'cleanliness', issue: 'visible staining', severity: 'moderate', confidence: 0.92 },
  { area: 'toilet_bowl', category: 'hygiene', issue: 'dirty bowl', severity: 'major', confidence: 0.9 },
  { area: 'wall', category: 'maintenance', issue: 'minor water mark', severity: 'minor', confidence: 0.8 },
];

test('tenant scoring modes preserve light >= medium >= high for identical findings', () => {
  const light = scoreInspectionFindings({ mode: 'light', baseScore: 42, findings: moderateFindings });
  const medium = scoreInspectionFindings({ mode: 'medium', baseScore: 42, findings: moderateFindings });
  const high = scoreInspectionFindings({ mode: 'high', baseScore: 42, findings: moderateFindings });
  assert.ok(light.finalScore >= medium.finalScore);
  assert.ok(medium.finalScore >= high.finalScore);
  assert.equal(medium.baseScore, medium.finalScore);
  assert.equal(light.policyVersion, AI_SCORING_POLICY_VERSION);
});

test('invalid and null modes safely fall back to medium', () => {
  assert.equal(resolveAiScoringMode('invalid'), 'medium');
  assert.equal(resolveAiScoringMode(null), 'medium');
  assert.equal(scoreInspectionFindings({ mode: 'invalid', baseScore: 70, findings: moderateFindings }).mode, 'medium');
});

test('deduplicates repeated evidence and confidence reduces unverified penalty', () => {
  const once = scoreInspectionFindings({ mode: 'high', baseScore: 80, findings: [moderateFindings[0]] });
  const duplicate = scoreInspectionFindings({ mode: 'high', baseScore: 80, findings: [moderateFindings[0], moderateFindings[0]] });
  const lowConfidence = scoreInspectionFindings({ mode: 'high', baseScore: 80, findings: [{ ...moderateFindings[0], confidence: 0.1 }] });
  assert.equal(duplicate.finalScore, once.finalScore);
  assert.ok(lowConfidence.totalPenalty < once.totalPenalty);
});

test('critical biohazards remain low even in light mode', () => {
  const findings = [{ area: 'floor', category: 'safety', issue: 'human waste and blood visible', severity: 'critical', confidence: 1, safetyCritical: true }];
  const light = scoreInspectionFindings({ mode: 'light', baseScore: 92, findings });
  const medium = scoreInspectionFindings({ mode: 'medium', baseScore: 92, findings });
  const high = scoreInspectionFindings({ mode: 'high', baseScore: 92, findings });
  assert.equal(light.finalScore, 35);
  assert.equal(medium.finalScore, 25);
  assert.equal(high.finalScore, 15);
  assert.ok(light.finalScore >= medium.finalScore && medium.finalScore >= high.finalScore);
});

test('scores clamp to the valid range and are deterministic', () => {
  const input = { mode: 'high', baseScore: 200, findings: moderateFindings };
  const first = scoreInspectionFindings(input);
  const second = scoreInspectionFindings(input);
  assert.deepEqual(first, second);
  assert.ok(first.finalScore >= 0 && first.finalScore <= 100);
});
