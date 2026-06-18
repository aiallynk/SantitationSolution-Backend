const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeScoringPayload,
  normalizeRubricScoringPayload,
  normalizeLegacyScoringPayload,
  applyCriticalPenaltyCaps,
} = require('../src/modules/analysis/openaiAnalysis.service').__testUtils;

test('applyCriticalPenaltyCaps applies strictest applicable cap', () => {
  assert.equal(applyCriticalPenaltyCaps(95, { feces_or_extreme_bio_visible: true }), 25);
  assert.equal(
    applyCriticalPenaltyCaps(95, {
      heavy_bowl_unsafe: true,
      feces_or_extreme_bio_visible: false,
    }),
    45
  );
  assert.equal(applyCriticalPenaltyCaps(50, { moderate_dirt_multiple_areas: true }), 50);
});

test('rubric payload caps hygiene score when feces flag set', () => {
  const out = normalizeScoringPayload({
    bowl_score_30: 25,
    floor_score_20: 18,
    walls_score_15: 12,
    fixtures_score_10: 8,
    trash_risk_score_10: 9,
    usability_score_15: 14,
    hygiene_score_0_100: 88,
    feces_or_extreme_bio_visible: true,
    confidence: 'High',
    confidence_score: 0.9,
    key_issues_detected: ['fecal matter visible'],
    detected_issues: [],
    human_review_required: true,
    reasoning_summary: 'Visible biological contamination.',
    severity_level: 'high',
  });
  assert.equal(out.scoring_rubric, 'hygiene_v1');
  assert.equal(out.overall_cleanliness_score, 25);
  assert.equal(out.star_rating_0_5, 1.3);
  assert.equal(out.hygiene_inspection_result, 'Severe Hygiene Issue');
  assert.equal(out.rating_label, 'Severe Dirty');
});

test('rubric payload derives legacy dimensions and merge issues', () => {
  const out = normalizeRubricScoringPayload({
    bowl_score_30: 27,
    floor_score_20: 16,
    walls_score_15: 12,
    fixtures_score_10: 8,
    trash_risk_score_10: 8,
    usability_score_15: 12,
    hygiene_score_0_100: null,
    feces_or_extreme_bio_visible: false,
    confidence: 'Medium',
    key_issues_detected: ['minor floor marks'],
    detected_issues: ['wet_floor'],
    reasoning_summary: 'Generally acceptable.',
    severity_level: 'low',
    human_review_required: false,
  });
  assert.ok(out.overall_cleanliness_score >= 80 && out.overall_cleanliness_score <= 100);
  assert.ok(out.detected_issues.includes('wet_floor'));
  assert.ok(out.detected_issues.includes('minor_floor_marks') || out.detected_issues.some((x) => x.includes('minor')));
});

test('legacy scoring payload still normalizes', () => {
  const out = normalizeLegacyScoringPayload({
    floor_cleanliness: 70,
    commode_urinal_cleanliness: 72,
    stain_presence: 40,
    water_stagnation: 30,
    garbage_presence: false,
    overall_cleanliness_score: 68,
    confidence_score: 0.75,
    detected_issues: ['test_issue'],
    severity_level: 'medium',
    human_review_required: false,
    explanation_summary: 'ok',
  });
  assert.equal(out.floor_cleanliness, 70);
  assert.equal(out.overall_cleanliness_score, 68);
  assert.equal(out.scoring_rubric, undefined);
});

test('production camelCase scoring payload normalizes to strict sanitation fields', () => {
  const out = normalizeScoringPayload({
    overallScore: 41,
    starRating: 2.1,
    confidence: 0.82,
    imageQuality: {
      usable: true,
      score: 0.91,
      reason: 'clear image',
    },
    severity: 'high',
    dimensions: {
      bowlPan: 35,
      floor: 62,
      walls: 74,
      trash: 88,
      wetness: 40,
      stains: 30,
      visibleWaste: 92,
      usability: 55,
    },
    detectedIssues: ['dirty pan', 'wet floor'],
    positiveFindings: ['walls mostly clean'],
    capApplied: true,
    capReason: 'dirty commode cap',
    reasoningSummary: 'Bowl/pan is stained and the floor is wet.',
  });

  assert.equal(out.scoring_rubric, 'sanitation_strict_v2');
  assert.equal(out.overall_cleanliness_score, 41);
  assert.equal(out.star_rating_0_5, 2.1);
  assert.equal(out.commode_urinal_cleanliness, 35);
  assert.equal(out.floor_cleanliness, 62);
  assert.equal(out.water_stagnation, 60);
  assert.equal(out.stain_presence, 70);
  assert.equal(out.garbage_presence, false);
  assert.equal(out.severity_level, 'high');
  assert.equal(out.cap_applied, true);
  assert.equal(out.cap_reason, 'dirty commode cap');
  assert.ok(out.detected_issues.includes('dirty pan'));
  assert.ok(out.positive_observations.includes('walls mostly clean'));
});
