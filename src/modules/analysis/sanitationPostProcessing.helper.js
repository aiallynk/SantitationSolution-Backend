const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round2 = (value) => Number(Number(value).toFixed(2));

const CLEANLINESS_LEVELS = new Set([
  'extreme_dirty',
  'severe_dirty',
  'dirty',
  'poor',
  'average',
  'good',
  'very_good',
  'excellent',
]);

const HYGIENE_RISKS = new Set(['low', 'medium', 'high', 'severe']);

const CRITICAL_FINDING_KEYS = [
  'visible_feces_or_potty',
  'urine_pooling',
  'dirty_commode_or_pan',
  'heavy_stains',
  'trash_or_waste',
  'waterlogging',
  'insects_or_biohazard',
];

const CRITICAL_ISSUE_KEYWORDS = {
  visible_feces_or_potty: [
    'feces',
    'faeces',
    'potty',
    'stool',
    'human waste',
    'sewage',
    'organic waste',
    'vomit',
    'blood',
    'biohazard',
  ],
  urine_pooling: ['urine', 'urinal splash', 'urine pooling', 'pee pool'],
  dirty_commode_or_pan: [
    'dirty commode',
    'dirty pan',
    'dirty bowl',
    'commode dirty',
    'pan dirty',
    'bowl dirty',
    'toilet bowl',
    'toilet pan',
    'toilet seat dirty',
  ],
  heavy_stains: ['stain', 'brown patch', 'yellow patch', 'sludge', 'black dirt', 'grime'],
  trash_or_waste: ['trash', 'garbage', 'waste', 'overflowing bin', 'sanitary waste', 'wet waste'],
  waterlogging: ['waterlogging', 'water logging', 'dirty water', 'water pool', 'blocked drain'],
  insects_or_biohazard: ['insect', 'maggot', 'fly infestation', 'biohazard', 'blood'],
};

const toScore = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return clamp(Number(fallback) || 0, 0, 100);
  return clamp(parsed, 0, 100);
};

const toConfidence = (value, fallback = null) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed >= 0 && parsed <= 1) return clamp(Number(parsed.toFixed(4)), 0, 1);
  if (parsed > 1 && parsed <= 100) return clamp(Number((parsed / 100).toFixed(4)), 0, 1);
  return fallback;
};

const normalizeArray = (value) => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 40)
    ),
  ];
};

const starRatingFromScore = (score) => {
  const safeScore = toScore(score, 0);
  return Number((safeScore / 20).toFixed(1));
};

const cleanlinessLevelFromScore = (score) => {
  const safe = toScore(score, 0);
  if (safe <= 10) return 'extreme_dirty';
  if (safe <= 25) return 'severe_dirty';
  if (safe <= 40) return 'dirty';
  if (safe <= 55) return 'poor';
  if (safe <= 70) return 'average';
  if (safe <= 85) return 'good';
  if (safe <= 95) return 'very_good';
  return 'excellent';
};

const normalizeCriticalFindings = ({
  criticalFindings = null,
  detectedIssues = [],
}) => {
  const normalized = Object.fromEntries(CRITICAL_FINDING_KEYS.map((key) => [key, false]));
  if (criticalFindings && typeof criticalFindings === 'object' && !Array.isArray(criticalFindings)) {
    for (const key of CRITICAL_FINDING_KEYS) {
      if (criticalFindings[key] === true) {
        normalized[key] = true;
      }
    }
  }

  const issueText = normalizeArray(detectedIssues)
    .join(' | ')
    .toLowerCase();
  if (!issueText) {
    return normalized;
  }

  for (const key of CRITICAL_FINDING_KEYS) {
    if (normalized[key]) continue;
    const keywords = CRITICAL_ISSUE_KEYWORDS[key] || [];
    if (keywords.some((keyword) => issueText.includes(keyword))) {
      normalized[key] = true;
    }
  }

  return normalized;
};

const inferHygieneRisk = ({
  hygieneRisk = null,
  score_0_100 = null,
  criticalFindings = {},
}) => {
  const provided = String(hygieneRisk || '').trim().toLowerCase();
  if (HYGIENE_RISKS.has(provided)) {
    return provided;
  }

  if (criticalFindings.visible_feces_or_potty || criticalFindings.insects_or_biohazard) {
    return 'severe';
  }
  if (
    criticalFindings.heavy_stains ||
    criticalFindings.urine_pooling
  ) {
    return 'high';
  }

  const score = toScore(score_0_100, 0);
  if (score <= 25) return 'severe';
  if (score <= 40) return 'high';
  if (score <= 70) return 'medium';
  return 'low';
};

const applyScoreCaps = ({ score_0_100, criticalFindings, hygieneRisk }) => {
  let score = toScore(score_0_100, 0);
  const capsApplied = [];
  const applyCap = (maxScore, reason) => {
    if (score > maxScore) {
      score = maxScore;
      capsApplied.push(reason);
    }
  };

  if (criticalFindings.visible_feces_or_potty === true) {
    applyCap(25, 'visible_feces_or_potty');
  }
  if (criticalFindings.dirty_commode_or_pan === true) {
    applyCap(45, 'dirty_commode_or_pan');
  }
  if (hygieneRisk === 'severe') {
    applyCap(25, 'hygiene_risk_severe');
  }
  if (hygieneRisk === 'high') {
    applyCap(40, 'hygiene_risk_high');
  }

  return {
    score_0_100: round2(score),
    capsApplied,
  };
};

const resolveRetakeDecision = ({
  requiresRetake = false,
  retakeReason = '',
  confidence = null,
  toiletDetected = true,
  visibilityScore = null,
  imageQualityStatus = null,
}) => {
  const resolvedConfidence = toConfidence(confidence, null);
  let nextRequiresRetake = Boolean(requiresRetake);
  let nextReason = String(retakeReason || '').trim();

  if (resolvedConfidence !== null && resolvedConfidence < 0.5) {
    nextRequiresRetake = true;
    if (!nextReason) {
      nextReason = 'Low confidence image; please retake with clearer framing.';
    }
  }

  if (toiletDetected === false) {
    nextRequiresRetake = true;
    nextReason = 'Toilet/commode is not clearly visible';
  }

  const visibility = toConfidence(visibilityScore, null);
  if (visibility !== null && visibility < 0.4) {
    nextRequiresRetake = true;
    if (!nextReason) {
      nextReason = 'Toilet/commode visibility is too low';
    }
  }

  const quality = String(imageQualityStatus || '').trim().toLowerCase();
  if (quality === 'blurry') {
    nextRequiresRetake = true;
    nextReason = 'Image is blurry; retake with a steady camera.';
  } else if (quality === 'lighting_invalid') {
    nextRequiresRetake = true;
    nextReason = 'Image lighting is too dark or too bright.';
  } else if (quality === 'missing_image') {
    nextRequiresRetake = true;
    nextReason = 'Image source is unavailable; please capture again.';
  }

  return {
    requires_retake: nextRequiresRetake,
    retake_reason: nextRequiresRetake ? nextReason : '',
  };
};

const applySingleImagePostProcessing = ({
  score_0_100,
  star_rating_0_5 = null,
  cleanliness_level = null,
  hygiene_risk = null,
  critical_findings = null,
  detected_issues = [],
  positive_observations = [],
  score_reason = '',
  confidence = null,
  requires_retake = false,
  retake_reason = '',
  toilet_detected = true,
  visibility_score = null,
  image_quality_status = null,
}) => {
  const normalizedIssues = normalizeArray(detected_issues);
  const normalizedPositives = normalizeArray(positive_observations);
  const criticalFindings = normalizeCriticalFindings({
    criticalFindings: critical_findings,
    detectedIssues: normalizedIssues,
  });

  const baselineScore = toScore(score_0_100, 0);
  const risk = inferHygieneRisk({
    hygieneRisk: hygiene_risk,
    score_0_100: baselineScore,
    criticalFindings,
  });
  const capped = applyScoreCaps({
    score_0_100: baselineScore,
    criticalFindings,
    hygieneRisk: risk,
  });
  const resolvedLevel = CLEANLINESS_LEVELS.has(String(cleanliness_level || '').trim().toLowerCase())
    ? String(cleanliness_level || '').trim().toLowerCase()
    : cleanlinessLevelFromScore(capped.score_0_100);
  const resolvedConfidence = toConfidence(confidence, 0.65);
  const retake = resolveRetakeDecision({
    requiresRetake: requires_retake,
    retakeReason: retake_reason,
    confidence: resolvedConfidence,
    toiletDetected: toilet_detected,
    visibilityScore: visibility_score,
    imageQualityStatus: image_quality_status,
  });
  const scoreReasonText = String(score_reason || '').trim().slice(0, 1800);

  return {
    score_0_100: capped.score_0_100,
    star_rating_0_5:
      star_rating_0_5 !== null && Number.isFinite(Number(star_rating_0_5))
        ? Number(Number(star_rating_0_5).toFixed(1))
        : starRatingFromScore(capped.score_0_100),
    cleanliness_level: resolvedLevel,
    hygiene_risk: risk,
    critical_findings: criticalFindings,
    detected_issues: normalizedIssues,
    positive_observations: normalizedPositives,
    score_reason: scoreReasonText || null,
    confidence: Number((resolvedConfidence ?? 0.65).toFixed(4)),
    requires_retake: retake.requires_retake,
    retake_reason: retake.retake_reason || '',
    caps_applied: capped.capsApplied,
  };
};

const mean = (values = []) => {
  const valid = (Array.isArray(values) ? values : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  if (valid.length === 0) return null;
  return valid.reduce((sum, item) => sum + item, 0) / valid.length;
};

const imageAngleSimilarityFromScore = (similarity) => {
  const value = Number(similarity);
  if (!Number.isFinite(value)) return 'low';
  if (value >= 0.85) return 'high';
  if (value >= 0.65) return 'medium';
  return 'low';
};

const improvementLevelFromDelta = (delta) => {
  const value = Number(delta);
  if (!Number.isFinite(value) || value <= 5) return 'none';
  if (value <= 15) return 'minor';
  if (value <= 30) return 'moderate';
  return 'major';
};

const criticalIssuesList = (criticalFindings = {}) =>
  CRITICAL_FINDING_KEYS.filter((key) => criticalFindings[key] === true);

const evaluatePairwiseComparison = ({
  before_score_0_100 = null,
  after_score_0_100 = null,
  before_critical_findings = null,
  after_critical_findings = null,
  similarities = [],
  duplicate_detected = false,
  same_toilet_likely = null,
}) => {
  const beforeScore = toScore(before_score_0_100, 0);
  const afterScore = toScore(after_score_0_100, 0);
  const scoreDelta = round2(afterScore - beforeScore);

  const similarityValues = (Array.isArray(similarities) ? similarities : [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  const maxSimilarity = similarityValues.length > 0 ? Math.max(...similarityValues) : null;
  const avgSimilarity = similarityValues.length > 0 ? mean(similarityValues) : null;
  const angleSimilarity = imageAngleSimilarityFromScore(avgSimilarity ?? maxSimilarity ?? 0);

  const inferredSameToilet =
    same_toilet_likely === true || same_toilet_likely === false
      ? Boolean(same_toilet_likely)
      : maxSimilarity === null
        ? true
        : maxSimilarity >= 0.45;

  const beforeCritical = normalizeCriticalFindings({
    criticalFindings: before_critical_findings,
  });
  const afterCritical = normalizeCriticalFindings({
    criticalFindings: after_critical_findings,
  });

  let adjustedAfterScore = afterScore;
  let shouldAcceptImprovement = scoreDelta > 5;
  let suspicious = false;
  let suspiciousReason = '';
  let comparisonReason = '';

  if (duplicate_detected) {
    suspicious = true;
    suspiciousReason = 'Before and after images appear to be identical or duplicated.';
    adjustedAfterScore = beforeScore;
    shouldAcceptImprovement = false;
    comparisonReason =
      'Before and after appear duplicated; no valid cleanliness improvement detected.';
  }

  if (!inferredSameToilet) {
    suspicious = true;
    suspiciousReason =
      suspiciousReason || 'Before/after images are unlikely to be the same toilet.';
    shouldAcceptImprovement = false;
  }

  if (afterCritical.visible_feces_or_potty) {
    adjustedAfterScore = Math.min(adjustedAfterScore, 25);
    shouldAcceptImprovement = false;
    comparisonReason = 'After image still contains visible feces/potty contamination.';
  }

  if (afterCritical.dirty_commode_or_pan) {
    adjustedAfterScore = Math.min(adjustedAfterScore, 45);
  }

  let adjustedDelta = round2(adjustedAfterScore - beforeScore);
  let improvementLevel = improvementLevelFromDelta(adjustedDelta);
  let cleanlinessDifferenceDetected = Math.abs(adjustedDelta) > 5;

  if (improvementLevel === 'none') {
    adjustedDelta = clamp(adjustedDelta, -5, 5);
    shouldAcceptImprovement = false;
    cleanlinessDifferenceDetected = false;
    if (!comparisonReason) {
      comparisonReason =
        angleSimilarity === 'low'
          ? 'Lighting/angle changed but dirt condition remains similar.'
          : 'No meaningful cleanliness difference detected between before and after.';
    }
  } else if (!comparisonReason) {
    comparisonReason = `Detected ${improvementLevel} improvement in hygiene condition.`;
  }

  const remainingCriticalIssuesAfter = criticalIssuesList(afterCritical);
  if (remainingCriticalIssuesAfter.length > 0) {
    shouldAcceptImprovement = false;
  }

  return {
    same_toilet_likely: inferredSameToilet,
    image_angle_similarity: angleSimilarity,
    before_score_0_100: round2(beforeScore),
    after_score_0_100: round2(adjustedAfterScore),
    before_star_rating_0_5: starRatingFromScore(beforeScore),
    after_star_rating_0_5: starRatingFromScore(adjustedAfterScore),
    score_delta: round2(adjustedDelta),
    cleanliness_difference_detected: cleanlinessDifferenceDetected,
    improvement_level: improvementLevel,
    should_accept_improvement: shouldAcceptImprovement,
    remaining_critical_issues_after: remainingCriticalIssuesAfter,
    suspicious_change_detected: suspicious,
    suspicious_reason: suspiciousReason,
    comparison_reason: comparisonReason,
  };
};

const buildSupervisorReviewFlags = ({
  singleImageResult = null,
  pairwiseComparison = null,
  afterScore = null,
}) => {
  const flags = new Set();
  const single = singleImageResult && typeof singleImageResult === 'object' ? singleImageResult : null;
  const pair = pairwiseComparison && typeof pairwiseComparison === 'object' ? pairwiseComparison : null;

  if (single?.critical_findings?.visible_feces_or_potty) {
    flags.add('SEVERE_HYGIENE_ISSUE');
  }
  if (single?.hygiene_risk === 'severe') {
    flags.add('SEVERE_HYGIENE_ISSUE');
  }
  if (single?.requires_retake) {
    flags.add('RETAKE_REQUIRED');
  }

  const score = toScore(afterScore ?? single?.score_0_100 ?? 0, 0);
  if (score < 40) {
    flags.add('AI_REVIEW_REQUIRED');
  }

  if (pair) {
    if (pair.suspicious_change_detected || pair.same_toilet_likely === false) {
      flags.add('SUSPICIOUS_IMPROVEMENT');
    }
    if (pair.should_accept_improvement === false) {
      flags.add('AI_REVIEW_REQUIRED');
    }
  }

  return Array.from(flags.values());
};

module.exports = {
  CRITICAL_FINDING_KEYS,
  starRatingFromScore,
  cleanlinessLevelFromScore,
  normalizeCriticalFindings,
  inferHygieneRisk,
  applySingleImagePostProcessing,
  evaluatePairwiseComparison,
  buildSupervisorReviewFlags,
};
