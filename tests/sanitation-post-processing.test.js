const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applySingleImagePostProcessing,
  evaluatePairwiseComparison,
  starRatingFromScore,
} = require('../src/modules/analysis/sanitationPostProcessing.helper');

test('visible feces caps final score at 25', () => {
  const out = applySingleImagePostProcessing({
    score_0_100: 55,
    hygiene_risk: 'medium',
    critical_findings: {
      visible_feces_or_potty: true,
    },
    detected_issues: ['visible feces inside pan'],
    confidence: 0.84,
  });
  assert.equal(out.score_0_100, 25);
});

test('dirty commode caps final score at 45', () => {
  const out = applySingleImagePostProcessing({
    score_0_100: 70,
    critical_findings: {
      dirty_commode_or_pan: true,
    },
    confidence: 0.82,
  });
  assert.equal(out.score_0_100, 45);
});

test('severe hygiene risk caps final score at 25', () => {
  const out = applySingleImagePostProcessing({
    score_0_100: 60,
    hygiene_risk: 'severe',
    confidence: 0.74,
  });
  assert.equal(out.score_0_100, 25);
});

test('low confidence image requires retake', () => {
  const out = applySingleImagePostProcessing({
    score_0_100: 78,
    confidence: 0.41,
  });
  assert.equal(out.requires_retake, true);
  assert.ok(String(out.retake_reason || '').length > 0);
});

test('same before/after duplicate marks suspicious and rejects improvement', () => {
  const out = evaluatePairwiseComparison({
    before_score_0_100: 43,
    after_score_0_100: 51,
    similarities: [0.98],
    duplicate_detected: true,
    before_critical_findings: {},
    after_critical_findings: {},
  });
  assert.equal(out.suspicious_change_detected, true);
  assert.equal(out.should_accept_improvement, false);
  assert.ok(Math.abs(Number(out.score_delta || 0)) <= 5);
});

test('after image with feces remains low and improvement rejected', () => {
  const out = evaluatePairwiseComparison({
    before_score_0_100: 18,
    after_score_0_100: 52,
    similarities: [0.7],
    duplicate_detected: false,
    before_critical_findings: { visible_feces_or_potty: true },
    after_critical_findings: { visible_feces_or_potty: true },
  });
  assert.ok(Number(out.after_score_0_100) <= 25);
  assert.equal(out.should_accept_improvement, false);
});

test('clean after image can produce major improvement', () => {
  const out = evaluatePairwiseComparison({
    before_score_0_100: 20,
    after_score_0_100: 82,
    similarities: [0.78],
    duplicate_detected: false,
    before_critical_findings: { dirty_commode_or_pan: true },
    after_critical_findings: {},
  });
  assert.equal(out.should_accept_improvement, true);
  assert.equal(out.improvement_level, 'major');
  assert.ok(Number(out.score_delta) > 30);
});

test('star rating mapping follows 0-100 to 0-5 scale', () => {
  assert.equal(starRatingFromScore(75), 3.8);
  assert.equal(starRatingFromScore(100), 5.0);
  assert.equal(starRatingFromScore(0), 0.0);
});

