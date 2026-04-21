const test = require('node:test');
const assert = require('node:assert/strict');

const {
  __testUtils: { normalizeScoringPayload, inferPercentScaleMultiplier, toConfidence },
} = require('../src/modules/analysis/openaiAnalysis.service');

test('normalizeScoringPayload rescales 0-1 cleanliness outputs to 0-100', () => {
  const normalized = normalizeScoringPayload({
    floor_cleanliness: 0.92,
    commode_urinal_cleanliness: 0.88,
    stain_presence: 0.14,
    water_stagnation: 0.1,
    garbage_presence: false,
    overall_cleanliness_score: 0.9,
    confidence_score: 87,
    detected_issues: [],
    severity_level: 'low',
    human_review_required: false,
    explanation_summary: 'Looks clean',
  });

  assert.equal(normalized.floor_cleanliness, 92);
  assert.equal(normalized.commode_urinal_cleanliness, 88);
  assert.equal(normalized.stain_presence, 14);
  assert.equal(normalized.water_stagnation, 10);
  assert.equal(normalized.overall_cleanliness_score, 90);
  assert.equal(normalized.confidence_score, 0.87);
});

test('normalizeScoringPayload keeps 0-100 outputs unchanged', () => {
  const normalized = normalizeScoringPayload({
    floor_cleanliness: 82,
    commode_urinal_cleanliness: 78,
    stain_presence: 24,
    water_stagnation: 18,
    garbage_presence: false,
    overall_cleanliness_score: 79,
    confidence_score: 0.74,
    detected_issues: ['minor_stain'],
    severity_level: 'medium',
    human_review_required: false,
    explanation_summary: 'Minor issues',
  });

  assert.equal(normalized.floor_cleanliness, 82);
  assert.equal(normalized.commode_urinal_cleanliness, 78);
  assert.equal(normalized.stain_presence, 24);
  assert.equal(normalized.water_stagnation, 18);
  assert.equal(normalized.overall_cleanliness_score, 79);
  assert.equal(normalized.confidence_score, 0.74);
});

test('confidence normalization supports both 0-1 and 0-100 style values', () => {
  assert.equal(toConfidence(0.63), 0.63);
  assert.equal(toConfidence(91), 0.91);
  assert.equal(toConfidence(150, null), null);
});

test('percent scale detection only activates for consistently normalized anchors', () => {
  assert.equal(
    inferPercentScaleMultiplier({
      floorRaw: 0.9,
      commodeRaw: 0.82,
      overallRaw: 0.88,
    }),
    100
  );

  assert.equal(
    inferPercentScaleMultiplier({
      floorRaw: 0.9,
      commodeRaw: 78,
      overallRaw: 75,
    }),
    1
  );
});
