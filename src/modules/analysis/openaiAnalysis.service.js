const { resolveMediaUrlForVision } = require('./analysisMediaResolver.service');
const { runtimeConfig } = require('../../config/runtime');
const {
  applyCriticalPenaltyCaps,
  ratingLabelFromScore,
  hygieneInspectionResultFromScore,
  starRatingFromScore,
  severityFromRubricScore,
} = require('./hygieneRubric.helper');

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const ANALYSIS_SCHEMA_VERSION = 'analysis.v5';
const PROMPT_VERSION = 'sanitation-detection-v5-ppm-odor';
const SCORING_VERSION = 'sanitation-rubric-v2-ppm-odor';
const SENSOR_CONTEXT_VERSION = 'sensor-context-v1';

const DETECTION_PROMPT = `
You are a sanitation inspection AI.
Analyze this image and return ONLY JSON with these exact keys:
- toilet_detected (boolean)
- urinal_detected (boolean)
- scene_type (string: "toilet" | "urinal" | "other" | "unclear")
- visibility_score (number 0 to 1)
- toilet_visibility (string: "full" | "partial" | "not_visible")
- reason (short string)

Rules:
- If toilet/urinal is not clearly visible, set toilet_detected=false.
- Ignore overlay text/watermarks (GPS/time/worker/toilet/stage/score) while detecting scene contents.
- Do not hallucinate.
- Return valid JSON only.
`.trim();

const SCORING_PROMPT = `
You are an expert public sanitation inspection AI.

Your job is to evaluate toilet cleanliness from inspection images. Score strictly based on real hygiene risk, not on image brightness, camera quality, tile color, or general appearance.

The commode/pan is the most important object. A clean floor or clean wall cannot compensate for a dirty commode/pan.

Critical sanitation issues:
- visible feces/potty/human waste
- brown/yellow stains inside toilet pan or commode
- urine pooling
- sludge
- vomit
- dirty water accumulation
- blocked drain
- insects/maggots
- overflowing garbage
- used sanitary waste
- wet waste near toilet
- strong dirt patches

Hard scoring rules:
- If visible feces/potty/human waste is present, score must be 0-25.
- If large or central feces/potty is visible inside the commode/pan, score must usually be 0-15.
- If commode/pan is dirty or stained, score must not exceed 45.
- If hygiene risk is severe, score must not exceed 25.
- If hygiene risk is high, score must not exceed 40.
- Never give 70+ unless commode/pan, floor, walls, and surrounding area are visibly clean.
- Do not increase score because of better lighting only.
- If image is unclear, blurry, too dark, too bright, or toilet is not visible, mark requires_retake true.

Return JSON only.

Return this production schema first:
{
  "overallScore": 0,
  "starRating": 0.0,
  "confidence": 0.0,
  "toiletDetected": true,
  "sceneType": "toilet | urinal | other | unclear",
  "visibilityScore": 0.0,
  "imageQuality": {
    "usable": true,
    "score": 0.0,
    "reason": ""
  },
  "severity": "low | medium | high | critical",
  "dimensions": {
    "bowlPan": 0,
    "floor": 0,
    "walls": 0,
    "trash": 0,
    "wetness": 0,
    "stains": 0,
    "visibleWaste": 0,
    "usability": 0
  },
  "detectedIssues": [],
  "findings": [{
    "area": "toilet_bowl | floor | wall | fixture | general",
    "category": "cleanliness | hygiene | maintenance | safety | usability",
    "issue": "short factual issue",
    "severity": "minor | moderate | major | critical",
    "confidence": 0.0,
    "safetyCritical": false,
    "evidence": "short visible evidence"
  }],
  "positiveFindings": [],
  "capApplied": false,
  "capReason": "",
  "reasoningSummary": ""
}

Dimension numbers are 0-100 cleanliness/safety scores where 100 is best. For wetness, stains, trash, and visibleWaste, 100 means dry, unstained, no trash, and no visible waste.
Findings must be factual and evidence-based. Report critical hygiene and safety risks regardless of any tenant scoring preference; do not duplicate the same defect from one image.

For internal compatibility also include this strict schema when possible:
{
  "score_0_100": 0,
  "star_rating_0_5": 0.0,
  "cleanliness_level": "extreme_dirty | severe_dirty | dirty | poor | average | good | very_good | excellent",
  "hygiene_risk": "low | medium | high | severe",
  "critical_findings": {
    "visible_feces_or_potty": false,
    "urine_pooling": false,
    "dirty_commode_or_pan": false,
    "heavy_stains": false,
    "trash_or_waste": false,
    "waterlogging": false,
    "insects_or_biohazard": false
  },
  "detected_issues": [],
  "positive_observations": [],
  "score_reason": "",
  "confidence": 0.0,
  "requires_retake": false,
  "retake_reason": ""
}

For backward compatibility also include legacy fields when possible:
- floor_cleanliness
- commode_urinal_cleanliness
- stain_presence
- water_stagnation
- garbage_presence
- overall_cleanliness_score
- confidence_score
- severity_level
- human_review_required
- explanation_summary

Sensor-context addendum:
- You may receive optional "Sensor context" metadata (temperature, humidity, gas concentration in ppm, sensor status, reading age minutes).
- Visual evidence remains PRIMARY. Sensor values are SECONDARY supporting evidence.
- Never replace visual score with sensor score.
- If sensor context indicates abnormal environment (very high humidity, stale/offline reading), reduce confidence and apply a moderate score penalty.
- Do not include gas concentration (ppm) in sensorImpact or environmentalScore. The backend applies the approved PPM odor tier deterministically after visual scoring.
- If image and sensor context disagree, explicitly mention this disagreement in reasoning.
- Return "sensorImpact" as an integer in range [-25, 0] indicating score reduction from sensor context (0 if no impact).
- Return "environmentalScore" in range [0,100] when sensor context is present, otherwise null.
`.trim();

const DETECTION_SCENE_TYPES = new Set(['toilet', 'urinal', 'other', 'unclear']);
const DETECTION_VISIBILITY_TYPES = new Set(['full', 'partial', 'not_visible']);
const SCORING_SEVERITY_TYPES = new Set(['low', 'medium', 'high']);
const STRICT_CLEANLINESS_LEVEL_TYPES = new Set([
  'extreme_dirty',
  'severe_dirty',
  'dirty',
  'poor',
  'average',
  'good',
  'very_good',
  'excellent',
]);
const STRICT_HYGIENE_RISK_TYPES = new Set(['low', 'medium', 'high', 'severe']);
const STRICT_CRITICAL_FINDING_KEYS = [
  'visible_feces_or_potty',
  'urine_pooling',
  'dirty_commode_or_pan',
  'heavy_stains',
  'trash_or_waste',
  'waterlogging',
  'insects_or_biohazard',
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round2 = (value) => Number(Number(value).toFixed(2));
const toFiniteOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const schemaError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

const deriveStatus = (score) => {
  if (score >= 80) return 'clean';
  if (score >= 60) return 'moderate';
  if (score >= 40) return 'poor';
  return 'critical';
};

const normalizeMessageContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return String(part.text || '');
      return '';
    })
    .join('\n')
    .trim();
};

const tryParseJson = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (_) {
    // continue
  }

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const snippet = value.slice(start, end + 1);
  try {
    return JSON.parse(snippet);
  } catch (_) {
    return null;
  }
};

const inferPercentScaleMultiplier = ({
  floorRaw,
  commodeRaw,
  overallRaw,
}) => {
  const anchors = [floorRaw, commodeRaw, overallRaw]
    .map((item) => toFiniteOrNull(item))
    .filter((item) => item !== null);
  if (anchors.length < 2) return 1;
  const normalized01 = anchors.every((item) => item >= 0 && item <= 1.0001);
  return normalized01 ? 100 : 1;
};

const toScore = (value, fallback = 0, { multiplier = 1 } = {}) => {
  if (value === null || value === undefined || String(value).trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const adjusted =
    multiplier > 1 && parsed >= 0 && parsed <= 1.0001 ? parsed * multiplier : parsed;
  return round2(clamp(adjusted, 0, 100));
};

const toConfidence = (value, fallback = null) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed >= 0 && parsed <= 1) {
    return clamp(Number(parsed.toFixed(4)), 0, 1);
  }
  if (parsed > 1 && parsed <= 100) {
    return clamp(Number((parsed / 100).toFixed(4)), 0, 1);
  }
  return fallback;
};

const normalizeArray = (value) => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 20)
    ),
  ];
};

const weightedOverallFromStrict = ({
  floorCleanliness,
  commodeCleanliness,
  stainPresence,
  waterStagnation,
  garbagePresence,
}) => {
  const stainCleanliness = 100 - clamp(stainPresence, 0, 100);
  const waterCleanliness = 100 - clamp(waterStagnation, 0, 100);
  const garbageCleanliness = garbagePresence ? 0 : 100;

  return round2(
    clamp(
      floorCleanliness * 0.3 +
        commodeCleanliness * 0.3 +
        stainCleanliness * 0.2 +
        waterCleanliness * 0.1 +
        garbageCleanliness * 0.1,
      0,
      100
    )
  );
};

const normalizeDetectionPayload = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection pass did not return a JSON object');
  }
  const raw = parsed;

  if (typeof raw.toilet_detected !== 'boolean') {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "toilet_detected" must be boolean');
  }
  if (typeof raw.urinal_detected !== 'boolean') {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "urinal_detected" must be boolean');
  }
  if (typeof raw.scene_type !== 'string') {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "scene_type" must be string');
  }
  if (!Number.isFinite(Number(raw.visibility_score))) {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "visibility_score" must be number');
  }
  if (typeof raw.toilet_visibility !== 'string') {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "toilet_visibility" must be string');
  }

  const sceneType = String(raw.scene_type).trim().toLowerCase();
  if (!DETECTION_SCENE_TYPES.has(sceneType)) {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "scene_type" has invalid value');
  }

  const toiletVisibility = String(raw.toilet_visibility).trim().toLowerCase();
  if (!DETECTION_VISIBILITY_TYPES.has(toiletVisibility)) {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "toilet_visibility" has invalid value');
  }

  const visibilityScore = toConfidence(raw.visibility_score, null);
  if (visibilityScore === null) {
    throw schemaError('OPENAI_DETECTION_PARSE_FAILED', 'Detection key "visibility_score" has invalid value');
  }

  const toiletDetected =
    Boolean(raw.toilet_detected) &&
    sceneType !== 'other' &&
    toiletVisibility !== 'not_visible';

  return {
    toilet_detected: toiletDetected,
    urinal_detected: Boolean(raw.urinal_detected),
    scene_type: sceneType,
    visibility_score: visibilityScore,
    toilet_visibility: toiletVisibility,
    reason: String(raw.reason || '').trim().slice(0, 500) || null,
  };
};

const readFirstKey = (source, keys = []) => {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return undefined;
};

const toBooleanOrNull = (value) => {
  if (value === true || value === false) return value;
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === '1') return true;
  if (normalized === 'false' || normalized === 'no' || normalized === '0') return false;
  return null;
};

const isRubricPayload = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (Number.isFinite(Number(raw.hygiene_score_0_100))) return true;
  if (Number.isFinite(Number(raw.bowl_score_30))) return true;
  if (Number.isFinite(Number(raw.floor_score_20))) return true;
  return false;
};

const confidenceFromRubricRaw = (raw) => {
  const band = readFirstKey(raw, ['confidence']);
  let score = toConfidence(readFirstKey(raw, ['confidence_score']), null);
  if (score === null && typeof band === 'string') {
    const c = band.trim().toLowerCase();
    if (c === 'low') score = 0.35;
    else if (c === 'medium') score = 0.65;
    else if (c === 'high') score = 0.9;
  }
  if (score === null) score = 0.65;
  return score;
};

const strictCleanlinessLevelFromScore = (score) => {
  const value = clamp(Number(score) || 0, 0, 100);
  if (value <= 10) return 'extreme_dirty';
  if (value <= 25) return 'severe_dirty';
  if (value <= 40) return 'dirty';
  if (value <= 55) return 'poor';
  if (value <= 70) return 'average';
  if (value <= 85) return 'good';
  if (value <= 95) return 'very_good';
  return 'excellent';
};

const strictHygieneRiskFromScore = (score) => {
  const value = clamp(Number(score) || 0, 0, 100);
  if (value <= 25) return 'severe';
  if (value <= 40) return 'high';
  if (value <= 70) return 'medium';
  return 'low';
};

const normalizeStrictCriticalFindings = (value, detectedIssues = []) => {
  const normalized = Object.fromEntries(STRICT_CRITICAL_FINDING_KEYS.map((key) => [key, false]));
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of STRICT_CRITICAL_FINDING_KEYS) {
      if (value[key] === true) normalized[key] = true;
    }
  }

  const normalizedIssues = normalizeArray(detectedIssues)
    .join(' | ')
    .toLowerCase();
  if (!normalizedIssues) return normalized;

  if (
    !normalized.visible_feces_or_potty &&
    ['feces', 'faeces', 'potty', 'stool', 'human waste', 'sewage', 'vomit', 'blood'].some(
      (key) => normalizedIssues.includes(key)
    )
  ) {
    normalized.visible_feces_or_potty = true;
  }
  if (
    !normalized.dirty_commode_or_pan &&
    ['dirty commode', 'dirty pan', 'dirty bowl', 'commode stain', 'pan stain', 'bowl stain'].some(
      (key) => normalizedIssues.includes(key)
    )
  ) {
    normalized.dirty_commode_or_pan = true;
  }
  if (
    !normalized.heavy_stains &&
    ['stain', 'brown patch', 'yellow patch', 'sludge', 'grime', 'dirt patch'].some((key) =>
      normalizedIssues.includes(key)
    )
  ) {
    normalized.heavy_stains = true;
  }
  if (
    !normalized.urine_pooling &&
    ['urine', 'urine pooling', 'pee pool'].some((key) => normalizedIssues.includes(key))
  ) {
    normalized.urine_pooling = true;
  }
  if (
    !normalized.waterlogging &&
    ['waterlogging', 'dirty water', 'blocked drain', 'water pool'].some((key) =>
      normalizedIssues.includes(key)
    )
  ) {
    normalized.waterlogging = true;
  }
  if (
    !normalized.trash_or_waste &&
    ['trash', 'garbage', 'waste', 'overflowing bin', 'sanitary waste', 'wet waste'].some((key) =>
      normalizedIssues.includes(key)
    )
  ) {
    normalized.trash_or_waste = true;
  }
  if (
    !normalized.insects_or_biohazard &&
    ['insect', 'maggot', 'fly', 'biohazard', 'blood'].some((key) => normalizedIssues.includes(key))
  ) {
    normalized.insects_or_biohazard = true;
  }

  return normalized;
};

const isStrictSanitationPayload = (raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (Number.isFinite(Number(raw.score_0_100))) return true;
  if (Number.isFinite(Number(raw.overallScore))) return true;
  if (Number.isFinite(Number(raw.starRating)) && raw.dimensions && typeof raw.dimensions === 'object') return true;
  if (raw.critical_findings && typeof raw.critical_findings === 'object') return true;
  if (raw.detectedIssues && Array.isArray(raw.detectedIssues)) return true;
  if (typeof raw.cleanliness_level === 'string' && typeof raw.hygiene_risk === 'string') return true;
  return false;
};

const normalizeStrictSanitationPayload = (raw) => {
  const readFirst = readFirstKey;
  const dimensions =
    raw.dimensions && typeof raw.dimensions === 'object' && !Array.isArray(raw.dimensions)
      ? raw.dimensions
      : {};
  const imageQuality =
    raw.imageQuality && typeof raw.imageQuality === 'object' && !Array.isArray(raw.imageQuality)
      ? raw.imageQuality
      : {};
  const scoreRaw = readFirst(raw, [
    'score_0_100',
    'overallScore',
    'overall_cleanliness_score',
    'hygiene_score_0_100',
  ]);
  if (!Number.isFinite(Number(scoreRaw))) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Strict scoring key "score_0_100" must be numeric');
  }
  const score = toScore(scoreRaw, 0);

  const starRaw = readFirst(raw, ['star_rating_0_5', 'starRating']);
  const starRating =
    Number.isFinite(Number(starRaw)) && Number(starRaw) >= 0 && Number(starRaw) <= 5
      ? Number(Number(starRaw).toFixed(1))
      : starRatingFromScore(score);

  const cleanlinessLevelRaw = String(readFirst(raw, ['cleanliness_level', 'cleanlinessLevel']) || '')
    .trim()
    .toLowerCase();
  const cleanlinessLevel = STRICT_CLEANLINESS_LEVEL_TYPES.has(cleanlinessLevelRaw)
    ? cleanlinessLevelRaw
    : strictCleanlinessLevelFromScore(score);

  const hygieneRiskRaw = String(readFirst(raw, ['hygiene_risk', 'hygieneRisk']) || '')
    .trim()
    .toLowerCase();
  const hygieneRisk = STRICT_HYGIENE_RISK_TYPES.has(hygieneRiskRaw)
    ? hygieneRiskRaw
    : strictHygieneRiskFromScore(score);

  const issues = normalizeArray(
    readFirst(raw, ['detected_issues', 'detectedIssues', 'issues', 'issue_tags']) || []
  );
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .filter((finding) => finding && typeof finding === 'object')
        .slice(0, 20)
        .map((finding) => ({
          area: String(finding.area || 'general').trim().slice(0, 80),
          category: String(finding.category || 'cleanliness').trim().slice(0, 80),
          issue: String(finding.issue || finding.evidence || '').trim().slice(0, 300),
          severity: String(finding.severity || 'moderate').trim().toLowerCase(),
          confidence: toConfidence(finding.confidence, null),
          safetyCritical: Boolean(finding.safetyCritical || finding.safety_critical),
          evidence: String(finding.evidence || '').trim().slice(0, 500),
        }))
        .filter((finding) => finding.issue)
    : [];
  const criticalFindings = normalizeStrictCriticalFindings(
    readFirst(raw, ['critical_findings', 'criticalFindings']),
    issues
  );
  const positiveObservations = normalizeArray(
    readFirst(raw, ['positive_observations', 'positiveFindings', 'positiveObservations']) || []
  );
  const scoreReason = String(
    readFirst(raw, ['score_reason', 'reasoningSummary', 'reasoning_summary', 'explanation_summary']) ||
      ''
  )
    .trim()
    .slice(0, 1800);
  const confidenceScore = toConfidence(
    readFirst(raw, ['confidence', 'confidence_score']) ?? imageQuality.confidence,
    0.65
  );
  const requiresRetake = Boolean(
    toBooleanOrNull(readFirst(raw, ['requires_retake', 'requiresRetake'])) ||
      readFirst(raw, ['requires_retake', 'requiresRetake']) === true ||
      imageQuality.usable === false
  );
  const retakeReason = String(readFirst(raw, ['retake_reason', 'retakeReason']) || imageQuality.reason || '')
    .trim()
    .slice(0, 500);

  const floorCleanliness = toScore(
    readFirst(raw, ['floor_cleanliness', 'floor_score']) ?? dimensions.floor,
    score
  );
  const commodeCleanliness = toScore(
    readFirst(raw, ['commode_urinal_cleanliness', 'commode_score']) ??
      dimensions.bowlPan ??
      dimensions.commode ??
      dimensions.pan,
    score
  );
  const stainDimension = dimensions.stains;
  const wetnessDimension = dimensions.wetness;
  const stainPresence = toScore(
    readFirst(raw, ['stain_presence']) ??
      (Number.isFinite(Number(stainDimension)) ? 100 - Number(stainDimension) : undefined),
    criticalFindings.heavy_stains ? 70 : 22
  );
  const waterStagnation = toScore(
    readFirst(raw, ['water_stagnation']) ??
      (Number.isFinite(Number(wetnessDimension)) ? 100 - Number(wetnessDimension) : undefined),
    criticalFindings.waterlogging ? 72 : 18
  );
  const garbagePresenceRaw = readFirst(raw, ['garbage_presence']);
  const trashCleanliness = Number.isFinite(Number(dimensions.trash)) ? Number(dimensions.trash) : null;
  const visibleWasteCleanliness = Number.isFinite(Number(dimensions.visibleWaste))
    ? Number(dimensions.visibleWaste)
    : null;
  const garbagePresence =
    toBooleanOrNull(garbagePresenceRaw) ??
    Boolean(
      criticalFindings.trash_or_waste ||
        (trashCleanliness !== null && trashCleanliness < 50) ||
        (visibleWasteCleanliness !== null && visibleWasteCleanliness < 50) ||
        issues.some((issue) => issue.includes('waste'))
    );

  const severityRaw = String(readFirst(raw, ['severity', 'severity_level']) || '')
    .trim()
    .toLowerCase();

  let severityLevel = 'low';
  if (severityRaw === 'critical') {
    severityLevel = 'high';
  } else if (SCORING_SEVERITY_TYPES.has(severityRaw)) {
    severityLevel = severityRaw;
  } else if (hygieneRisk === 'severe' || hygieneRisk === 'high') {
    severityLevel = 'high';
  } else if (hygieneRisk === 'medium') {
    severityLevel = 'medium';
  }

  const reviewRequiredRaw = toBooleanOrNull(readFirst(raw, ['human_review_required', 'review_required']));
  const humanReviewRequired =
    reviewRequiredRaw !== null
      ? reviewRequiredRaw
      : requiresRetake ||
        hygieneRisk === 'high' ||
        hygieneRisk === 'severe' ||
        criticalFindings.visible_feces_or_potty;

  return {
    scoring_rubric: 'sanitation_strict_v2',
    score_0_100: score,
    star_rating_0_5: starRating,
    cleanliness_level: cleanlinessLevel,
    hygiene_risk: hygieneRisk,
    critical_findings: criticalFindings,
    detected_issues: issues,
    findings,
    positive_observations: positiveObservations,
    score_reason: scoreReason || null,
    confidence: confidenceScore,
    requires_retake: requiresRetake,
    retake_reason: retakeReason || '',
    cap_applied: Boolean(toBooleanOrNull(readFirst(raw, ['capApplied', 'cap_applied']))),
    cap_reason: String(readFirst(raw, ['capReason', 'cap_reason']) || '').trim().slice(0, 500),
    image_quality: imageQuality,
    dimensions: {
      bowlPan: dimensions.bowlPan !== undefined ? toScore(dimensions.bowlPan, commodeCleanliness) : commodeCleanliness,
      floor: dimensions.floor !== undefined ? toScore(dimensions.floor, floorCleanliness) : floorCleanliness,
      walls: dimensions.walls !== undefined ? toScore(dimensions.walls, score) : score,
      trash:
        trashCleanliness !== null
          ? toScore(trashCleanliness, garbagePresence ? 0 : 100)
          : garbagePresence
            ? 0
            : 100,
      wetness:
        wetnessDimension !== undefined
          ? toScore(wetnessDimension, 100 - waterStagnation)
          : 100 - waterStagnation,
      stains:
        stainDimension !== undefined
          ? toScore(stainDimension, 100 - stainPresence)
          : 100 - stainPresence,
      visibleWaste:
        visibleWasteCleanliness !== null
          ? toScore(visibleWasteCleanliness, garbagePresence ? 0 : 100)
          : garbagePresence
            ? 0
            : 100,
      usability: dimensions.usability !== undefined ? toScore(dimensions.usability, score) : score,
    },

    floor_cleanliness: floorCleanliness,
    commode_urinal_cleanliness: commodeCleanliness,
    stain_presence: stainPresence,
    water_stagnation: waterStagnation,
    garbage_presence: garbagePresence,
    overall_cleanliness_score: score,
    confidence_score: confidenceScore,
    severity_level: severityLevel,
    human_review_required: humanReviewRequired,
    explanation_summary: scoreReason || null,
    hygiene_score_0_100: score,
    rating_label: ratingLabelFromScore(score),
    hygiene_inspection_result: hygieneInspectionResultFromScore(score),
  };
};

const normalizeRubricScoringPayload = (raw) => {
  const readFirst = readFirstKey;

  const bowl = clamp(Number(readFirst(raw, ['bowl_score_30', 'bowl_score']) ?? 0), 0, 30);
  const floor = clamp(Number(readFirst(raw, ['floor_score_20', 'floor_score']) ?? 0), 0, 20);
  const walls = clamp(Number(readFirst(raw, ['walls_score_15', 'walls_score']) ?? 0), 0, 15);
  const fixtures = clamp(Number(readFirst(raw, ['fixtures_score_10', 'fixtures_score']) ?? 0), 0, 10);
  const trash = clamp(Number(readFirst(raw, ['trash_risk_score_10', 'trash_score']) ?? 0), 0, 10);
  const usability = clamp(Number(readFirst(raw, ['usability_score_15', 'usability_score']) ?? 0), 0, 15);

  const sumParts = round2(bowl + floor + walls + fixtures + trash + usability);
  const hygieneModel = readFirst(raw, ['hygiene_score_0_100', 'overall_cleanliness_score']);
  let preCap = Number.isFinite(Number(hygieneModel)) ? Number(hygieneModel) : sumParts;
  preCap = clamp(preCap, 0, 100);

  const penaltyFlags = {
    feces_or_extreme_bio_visible: Boolean(readFirst(raw, ['feces_or_extreme_bio_visible', 'feces_visible'])),
    heavy_bowl_unsafe: Boolean(readFirst(raw, ['heavy_bowl_unsafe', 'heavy_bowl_stain'])),
    floor_and_walls_heavy_dirty: Boolean(readFirst(raw, ['floor_and_walls_heavy_dirty'])),
    very_dirty_usable: Boolean(readFirst(raw, ['very_dirty_usable'])),
    moderate_dirt_multiple_areas: Boolean(readFirst(raw, ['moderate_dirt_multiple_areas'])),
    generally_clean_minor_only: Boolean(readFirst(raw, ['generally_clean_minor_only'])),
  };

  const serverCapped = applyCriticalPenaltyCaps(preCap, penaltyFlags);
  const finalScore = clamp(serverCapped, 0, 100);

  const floorCleanliness = round2((floor / 20) * 100);
  const commodeCleanliness = round2((bowl / 30) * 100);
  const stainPresence = round2(clamp(100 - (walls / 15) * 100, 0, 100));
  const waterStagnation = round2(clamp(100 - (floor / 20) * 100, 0, 100));
  const garbagePresence = clamp(trash, 0, 10) < 4;

  const confidenceScore = confidenceFromRubricRaw(raw);

  const keyIssues = Array.isArray(raw.key_issues_detected) ? raw.key_issues_detected : [];
  const legacyIssues = Array.isArray(raw.detected_issues) ? raw.detected_issues : [];
  const mergedIssues = normalizeArray([...keyIssues, ...legacyIssues]);

  const reasoning =
    String(readFirst(raw, ['reasoning_summary', 'explanation_summary', 'summary']) || '')
      .trim()
      .slice(0, 1800);
  const explanationSummary = reasoning || null;

  const severityLevel = severityFromRubricScore(finalScore, penaltyFlags);
  const reviewRaw = toBooleanOrNull(readFirst(raw, ['human_review_required', 'review_required']));
  const humanReviewRequired =
    reviewRaw !== null
      ? reviewRaw
      : Boolean(
          finalScore < 40 ||
            confidenceScore < 0.45 ||
            penaltyFlags.feces_or_extreme_bio_visible ||
            mergedIssues.length >= 4
        );

  const positiveObservations = Array.isArray(raw.positive_observations)
    ? normalizeArray(raw.positive_observations)
    : [];

  return {
    scoring_rubric: 'hygiene_v1',
    bowl_score_30: bowl,
    floor_score_20: floor,
    walls_score_15: walls,
    fixtures_score_10: fixtures,
    trash_risk_score_10: trash,
    usability_score_15: usability,
    hygiene_score_0_100: finalScore,
    penalty_cap_applied: (() => {
      const v = readFirst(raw, ['penalty_cap_applied']);
      if (v === undefined || v === null) return null;
      return String(v).slice(0, 200);
    })(),
    star_rating_0_5: starRatingFromScore(finalScore),
    rating_label: ratingLabelFromScore(finalScore),
    hygiene_inspection_result: hygieneInspectionResultFromScore(finalScore),
    key_issues_detected: normalizeArray(keyIssues),
    positive_observations: positiveObservations,
    reasoning_summary: reasoning || null,

    floor_cleanliness: floorCleanliness,
    commode_urinal_cleanliness: commodeCleanliness,
    stain_presence: stainPresence,
    water_stagnation: waterStagnation,
    garbage_presence: garbagePresence,
    overall_cleanliness_score: finalScore,
    confidence_score: confidenceScore,
    detected_issues: mergedIssues,
    severity_level: severityLevel,
    human_review_required: humanReviewRequired,
    explanation_summary: explanationSummary,
  };
};

const normalizeLegacyScoringPayload = (parsed) => {
  const raw = parsed;

  const readFirst = readFirstKey;

  const floorRaw = readFirst(raw, [
    'floor_cleanliness',
    'floor_cleanliness_score',
    'floor_score',
  ]);
  const commodeRaw = readFirst(raw, [
    'commode_urinal_cleanliness',
    'commode_cleanliness',
    'urinal_cleanliness',
    'commode_score',
  ]);
  const stainRaw = readFirst(raw, [
    'stain_presence',
    'stain_severity',
    'stain_score',
    'stains',
  ]);
  const waterRaw = readFirst(raw, [
    'water_stagnation',
    'water_stagnation_score',
    'water_score',
  ]);
  const overallRaw = readFirst(raw, [
    'overall_cleanliness_score',
    'cleanliness_score',
    'overall_score',
  ]);
  const confidenceRaw = readFirst(raw, ['confidence_score', 'confidence']);

  const requiredNumericValues = [
    ['floor_cleanliness', floorRaw],
    ['commode_urinal_cleanliness', commodeRaw],
    ['stain_presence', stainRaw],
    ['water_stagnation', waterRaw],
    ['overall_cleanliness_score', overallRaw],
    ['confidence_score', confidenceRaw],
  ];
  for (const [key, value] of requiredNumericValues) {
    if (!Number.isFinite(Number(value))) {
      throw schemaError('OPENAI_SCORING_PARSE_FAILED', `Scoring key "${key}" must be numeric`);
    }
  }

  const garbagePresenceRaw = readFirst(raw, [
    'garbage_presence',
    'garbage_present',
    'garbage',
  ]);
  const garbagePresence = toBooleanOrNull(garbagePresenceRaw);
  if (garbagePresence === null) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring key "garbage_presence" must be boolean');
  }

  const detectedIssuesRaw = readFirst(raw, ['detected_issues', 'issues', 'issue_tags']);
  const detectedIssues = Array.isArray(detectedIssuesRaw) ? detectedIssuesRaw : [];
  if (!Array.isArray(detectedIssuesRaw) && detectedIssuesRaw !== undefined) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring key "detected_issues" must be array');
  }

  const severityRaw = readFirst(raw, ['severity_level', 'severity']);
  if (typeof severityRaw !== 'string') {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring key "severity_level" must be string');
  }
  const severityLevel = String(severityRaw).trim().toLowerCase();
  if (!SCORING_SEVERITY_TYPES.has(severityLevel)) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring key "severity_level" has invalid value');
  }

  const reviewRequiredRaw = readFirst(raw, ['human_review_required', 'review_required']);
  const humanReviewRequired = toBooleanOrNull(reviewRequiredRaw);
  if (humanReviewRequired === null) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring key "human_review_required" must be boolean');
  }

  const explanationRaw = readFirst(raw, ['explanation_summary', 'summary', 'explanation']);
  if (
    explanationRaw !== null &&
    explanationRaw !== undefined &&
    typeof explanationRaw !== 'string'
  ) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring key "explanation_summary" must be string');
  }

  const percentScaleMultiplier = inferPercentScaleMultiplier({
    floorRaw,
    commodeRaw,
    overallRaw,
  });
  const floorCleanliness = toScore(floorRaw, 0, {
    multiplier: percentScaleMultiplier,
  });
  const commodeCleanliness = toScore(commodeRaw, 0, {
    multiplier: percentScaleMultiplier,
  });
  const stainPresence = toScore(stainRaw, 0, {
    multiplier: percentScaleMultiplier,
  });
  const waterStagnation = toScore(waterRaw, 0, {
    multiplier: percentScaleMultiplier,
  });

  const weightedOverall = weightedOverallFromStrict({
    floorCleanliness,
    commodeCleanliness,
    stainPresence,
    waterStagnation,
    garbagePresence,
  });

  const overallScore = toScore(overallRaw, weightedOverall, {
    multiplier: percentScaleMultiplier,
  });
  const confidenceScore = toConfidence(confidenceRaw, null);
  if (confidenceScore === null) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring key "confidence_score" has invalid value');
  }

  const explanationSummary = String(explanationRaw || '')
    .trim()
    .slice(0, 1800);

  return {
    floor_cleanliness: floorCleanliness,
    commode_urinal_cleanliness: commodeCleanliness,
    stain_presence: stainPresence,
    water_stagnation: waterStagnation,
    garbage_presence: garbagePresence,
    overall_cleanliness_score: overallScore,
    confidence_score: confidenceScore,
    detected_issues: normalizeArray(detectedIssues),
    severity_level: severityLevel,
    human_review_required: humanReviewRequired,
    explanation_summary: explanationSummary || null,
  };
};

const normalizeScoringPayload = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring pass did not return a JSON object');
  }
  if (isStrictSanitationPayload(parsed)) {
    const strict = normalizeStrictSanitationPayload(parsed);
    strict.sensor_impact = toNumberOrNull(readFirstKey(parsed, ['sensorImpact', 'sensor_impact']));
    strict.environmental_score = toNumberOrNull(readFirstKey(parsed, ['environmentalScore', 'environmental_score']));
    if (strict.sensor_impact !== null) {
      strict.sensor_impact = clamp(Math.round(strict.sensor_impact), -25, 0);
    }
    if (strict.environmental_score !== null) {
      strict.environmental_score = clamp(Number(strict.environmental_score), 0, 100);
    }
    return strict;
  }
  if (isRubricPayload(parsed)) {
    const rubric = normalizeRubricScoringPayload(parsed);
    rubric.sensor_impact = toNumberOrNull(readFirstKey(parsed, ['sensorImpact', 'sensor_impact']));
    rubric.environmental_score = toNumberOrNull(readFirstKey(parsed, ['environmentalScore', 'environmental_score']));
    if (rubric.sensor_impact !== null) rubric.sensor_impact = clamp(Math.round(rubric.sensor_impact), -25, 0);
    if (rubric.environmental_score !== null) rubric.environmental_score = clamp(Number(rubric.environmental_score), 0, 100);
    return rubric;
  }
  const legacy = normalizeLegacyScoringPayload(parsed);
  legacy.sensor_impact = toNumberOrNull(readFirstKey(parsed, ['sensorImpact', 'sensor_impact']));
  legacy.environmental_score = toNumberOrNull(readFirstKey(parsed, ['environmentalScore', 'environmental_score']));
  if (legacy.sensor_impact !== null) legacy.sensor_impact = clamp(Math.round(legacy.sensor_impact), -25, 0);
  if (legacy.environmental_score !== null) legacy.environmental_score = clamp(Number(legacy.environmental_score), 0, 100);
  return legacy;
};

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildSensorContext = (snapshot = null) => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const readingTime = snapshot.readingTime || snapshot.timestamp || snapshot.linkedAt || null;
  const readingTs = readingTime ? new Date(readingTime).getTime() : null;
  const ageMinutes = Number.isFinite(readingTs)
    ? Math.max(0, Math.floor((Date.now() - readingTs) / 60000))
    : null;
  const temperature = toNumberOrNull(snapshot.temperature);
  const humidity = toNumberOrNull(snapshot.humidity);
  const ppm = toNumberOrNull(snapshot.ppm ?? snapshot.field1 ?? snapshot.field_1);
  const battery = toNumberOrNull(snapshot.battery ?? snapshot.batteryLevel);
  const rssi = toNumberOrNull(snapshot.rssi ?? snapshot.signalStrength);
  const hasData = [temperature, humidity, ppm, battery, rssi].some((v) => v !== null);
  if (!hasData) return null;
  return {
    version: SENSOR_CONTEXT_VERSION,
    temperature,
    humidity,
    ppm,
    battery,
    rssi,
    sensorStatus: String(snapshot.sensorStatus || 'ONLINE').toUpperCase(),
    readingAgeMinutes: ageMinutes,
    readingTime: readingTime || null,
  };
};

const getOpenAiAnalysisConfigState = () => {
  const provider = runtimeConfig.analysis.provider;
  const hasApiKey = Boolean(String(runtimeConfig.analysis.openaiApiKey || '').trim());
  if (provider !== 'openai') {
    return {
      ok: false,
      reason: 'AI provider not configured',
      code: 'PROVIDER_NOT_OPENAI',
    };
  }
  if (!hasApiKey) {
    return {
      ok: false,
      reason: 'OPENAI_API_KEY is missing',
      code: 'OPENAI_API_KEY_MISSING',
    };
  }
  return { ok: true, reason: null, code: null };
};

const assertOpenAiAnalysisConfigured = () => {
  const state = getOpenAiAnalysisConfigState();
  if (!state.ok) {
    const error = new Error(state.reason || 'OpenAI analysis is not configured');
    error.code = state.code || 'OPENAI_CONFIG_INVALID';
    throw error;
  }
  return true;
};

const isOpenAiAnalysisEnabled = () => getOpenAiAnalysisConfigState().ok;

const callOpenAiVisionJson = async ({
  model,
  promptText,
  imageUrl,
  contextText,
  maxTokens = 700,
}) => {
  const baseUrl = String(runtimeConfig.analysis.openaiBaseUrl || OPENAI_DEFAULT_BASE_URL).replace(
    /\/+$/,
    ''
  );
  const timeoutMs = Math.max(runtimeConfig.analysis.openaiTimeoutMs, 5000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload;
  const callStartMs = Date.now();

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtimeConfig.analysis.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: clamp(Number(maxTokens) || 700, 120, 1200),
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You are a strict sanitation inspection model. Return JSON only.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'text', text: contextText },
              { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `OpenAI request failed (${response.status})`;
      const error = new Error(message);
      error.code = 'OPENAI_REQUEST_FAILED';
      error.status = response.status;
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }

  const rawContent = normalizeMessageContent(payload?.choices?.[0]?.message?.content);
  const parsed = tryParseJson(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    throw schemaError('OPENAI_INVALID_JSON', 'OpenAI response did not contain valid JSON');
  }

  return {
    parsed,
    responseId: payload?.id || null,
    usage: payload?.usage || null,
    rawContent,
    latencyMs: Date.now() - callStartMs,
  };
};

const analyzeInspectionWithOpenAI = async ({ inspection, mediaRows, usageContext = {}, sensorSnapshot = null, singleStructuredPass = false }) => {
  assertOpenAiAnalysisConfigured();

  const selected = Array.isArray(mediaRows) ? mediaRows[0] : null;
  if (!selected) {
    return null;
  }

  const imageUrl = await resolveMediaUrlForVision(selected);
  if (!imageUrl) {
    const error = new Error('Image payload is unavailable for analysis');
    error.code = 'IMAGE_SOURCE_UNAVAILABLE';
    throw error;
  }

  const model = runtimeConfig.analysis.openaiModel || 'gpt-4o-mini';
  const sensorContext = buildSensorContext(sensorSnapshot);
  const contextText = [
    `inspection_id=${inspection.id}`,
    `facility_id=${inspection.facility_id}`,
    'Ignore any overlay watermark text (GPS/time/worker/toilet/stage/score).',
    'Evaluate only visible hygiene condition in the scene.',
    sensorContext
      ? `Sensor context (secondary evidence): ${JSON.stringify(sensorContext)}`
      : 'Sensor context: unavailable',
  ].join(', ');

  let detectionPass;
  let scoringPass;
  if (singleStructuredPass) {
    // V2 uses one structured vision response. Detection fields are included in
    // the scoring schema so modes can be recalculated without another billable call.
    scoringPass = await callOpenAiVisionJson({
      model,
      promptText: SCORING_PROMPT,
      imageUrl,
      contextText,
      maxTokens: 1050,
    });
    const raw = scoringPass.parsed || {};
    detectionPass = {
      parsed: {
        toilet_detected: raw.toiletDetected !== false && raw.toilet_detected !== false && raw.imageQuality?.usable !== false,
        urinal_detected: String(raw.sceneType || raw.scene_type || '').trim().toLowerCase() === 'urinal',
        scene_type: raw.sceneType || raw.scene_type || 'unclear',
        visibility_score: raw.visibilityScore ?? raw.visibility_score ?? raw.imageQuality?.score ?? 0.5,
        toilet_visibility: raw.toiletDetected === false || raw.toilet_detected === false ? 'not_visible' : 'partial',
        reason: 'Derived from the V2 structured scoring response',
      },
      responseId: null,
      usage: null,
      latencyMs: 0,
    };
  } else {
    [detectionPass, scoringPass] = await Promise.all([
      callOpenAiVisionJson({
        model,
        promptText: DETECTION_PROMPT,
        imageUrl,
        contextText,
        maxTokens: 220,
      }),
      callOpenAiVisionJson({
        model,
        promptText: SCORING_PROMPT,
        imageUrl,
        contextText,
        maxTokens: 950,
      }),
    ]);
  }
  const detection = normalizeDetectionPayload(detectionPass.parsed);
  const strictJson = normalizeScoringPayload(scoringPass.parsed);
  const sensorImpact = Number.isFinite(Number(strictJson.sensor_impact))
    ? clamp(Math.round(Number(strictJson.sensor_impact)), -25, 0)
    : 0;
  const environmentalScore =
    strictJson.environmental_score !== null && strictJson.environmental_score !== undefined
      ? clamp(Number(strictJson.environmental_score), 0, 100)
      : null;
  const detectionWarnings = [];
  const adjustedIssues = Array.isArray(strictJson.detected_issues)
    ? [...strictJson.detected_issues]
    : [];
  let adjustedConfidence = Number(strictJson.confidence_score || 0);
  let adjustedReviewRequired = Boolean(strictJson.human_review_required);

  if (!detection.toilet_detected) {
    adjustedConfidence = Math.min(adjustedConfidence, 0.32);
    adjustedReviewRequired = true;
    adjustedIssues.push('toilet_not_visible');
    detectionWarnings.push(
      String(detection.reason || 'Toilet/urinal not clearly detected').slice(0, 240)
    );
  }
  if (Number(detection.visibility_score || 0) < 0.4) {
    adjustedConfidence = Math.min(adjustedConfidence, 0.45);
    adjustedReviewRequired = true;
    adjustedIssues.push('low_visibility');
    detectionWarnings.push('Low visibility detected in inspection image');
  }
  if (String(detection.scene_type || '').trim().toLowerCase() === 'unclear') {
    adjustedConfidence = Math.min(adjustedConfidence, 0.5);
    adjustedReviewRequired = true;
    adjustedIssues.push('scene_unclear');
    detectionWarnings.push('Scene classification is unclear');
  }

  const normalizedIssueTags = normalizeArray(adjustedIssues);
  const resolvedExplanationText = [
    String(strictJson.explanation_summary || '').trim(),
    detectionWarnings.length > 0
      ? `Detection notes: ${detectionWarnings.join('; ')}`
      : '',
  ]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 1800);

  const odorRiskScore = clamp(
    Math.round(
      strictJson.stain_presence * 0.45 +
        strictJson.water_stagnation * 0.4 +
        (strictJson.garbage_presence ? 15 : 0)
    ),
    0,
    100
  );
  const wetnessCleanliness = clamp(100 - strictJson.water_stagnation, 0, 100);
  const stainCleanliness = clamp(100 - strictJson.stain_presence, 0, 100);
  const litterScore = strictJson.garbage_presence ? 0 : 100;

  // Fire-and-forget usage logging — never blocks the analysis result
  try {
    const { logUsage } = require('../ai/aiUsageLogger.service');
    const totalInputTokens =
      (Number(detectionPass.usage?.prompt_tokens) || 0) +
      (Number(scoringPass.usage?.prompt_tokens) || 0);
    const totalOutputTokens =
      (Number(detectionPass.usage?.completion_tokens) || 0) +
      (Number(scoringPass.usage?.completion_tokens) || 0);
    const combinedLatencyMs =
      (Number(detectionPass.latencyMs) || 0) + (Number(scoringPass.latencyMs) || 0);
    void logUsage({
      tenantId: usageContext.tenantId || inspection.tenant_id || null,
      userId: usageContext.userId || null,
      workerId: usageContext.workerId || null,
      inspectionId: inspection.id || null,
      toiletId: usageContext.toiletId || inspection.toilet_unit_id || null,
      userRole: usageContext.userRole || null,
      featureKey: 'TOILET_IMAGE_SCORING',
      featureName: 'Toilet Image Scoring',
      provider: 'openai',
      modelName: model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      imageCount: 1,
      status: 'success',
      latencyMs: combinedLatencyMs,
      isEstimated: totalInputTokens === 0,
      metadata: {
        reason: 'Scoring toilet cleanliness from inspection image',
        source: usageContext.source || 'worker_mobile_app',
        detectionResponseId: detectionPass.responseId || null,
        scoringResponseId: scoringPass.responseId || null,
        score: strictJson.overall_cleanliness_score,
        inspectionId: inspection.id,
      },
    });
  } catch (_) {
    // best effort
  }

  return {
    modelName: model,
    modelVersion: 'openai-chat-completions-v4',
    provider: 'openai',
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    scoringVersion: SCORING_VERSION,
    overallCleanlinessScore: strictJson.overall_cleanliness_score,
    cleanlinessScore: strictJson.floor_cleanliness,
    hygieneScore: strictJson.commode_urinal_cleanliness,
    odorRiskScore,
    wetnessScore: wetnessCleanliness,
    stainScore: stainCleanliness,
    litterScore,
    overallStatus: deriveStatus(strictJson.overall_cleanliness_score),
    anomalyFlags: {
      low_cleanliness: strictJson.overall_cleanliness_score < 45,
      wetness_concern: strictJson.water_stagnation >= 55,
      stain_concern: strictJson.stain_presence >= 55,
      litter_concern: strictJson.garbage_presence === true,
      detection_uncertain: detectionWarnings.length > 0,
    },
    confidenceScore: Number(adjustedConfidence.toFixed(4)),
    explanationText:
      resolvedExplanationText ||
      (normalizedIssueTags.length > 0
        ? `Detected issues: ${normalizedIssueTags.slice(0, 6).join(', ')}`
        : 'No major issues detected'),
    issueTags: normalizedIssueTags,
    severityLabel: strictJson.severity_level,
    subScores: {
      floorCleanliness: strictJson.floor_cleanliness,
      commodeCondition: strictJson.commode_urinal_cleanliness,
      stainSeverity: strictJson.stain_presence,
      wastePresence: strictJson.garbage_presence ? 100 : 0,
      waterStagnation: strictJson.water_stagnation,
      ...(strictJson.scoring_rubric === 'hygiene_v1'
        ? {
            rubric: {
              bowl30: strictJson.bowl_score_30,
              floor20: strictJson.floor_score_20,
              walls15: strictJson.walls_score_15,
              fixtures10: strictJson.fixtures_score_10,
              trashRisk10: strictJson.trash_risk_score_10,
              usability15: strictJson.usability_score_15,
              hygiene100: strictJson.hygiene_score_0_100,
              star05: strictJson.star_rating_0_5,
              ratingLabel: strictJson.rating_label,
              hygieneInspectionResult: strictJson.hygiene_inspection_result,
            },
          }
        : {}),
    },
    reviewRequired: adjustedReviewRequired,
    rawResult: {
      provider: 'openai',
      strictJson: {
        ...strictJson,
        sensor_impact: sensorImpact,
        environmental_score: environmentalScore,
        confidence_score: Number(adjustedConfidence.toFixed(4)),
        human_review_required: adjustedReviewRequired,
        detected_issues: normalizedIssueTags,
        explanation_summary: resolvedExplanationText || strictJson.explanation_summary || null,
      },
      detection,
      detectionWarnings,
      sensorContext,
      promptVersion: PROMPT_VERSION,
      scoringVersion: SCORING_VERSION,
      responseIds: [detectionPass.responseId, scoringPass.responseId].filter(Boolean),
      usage: {
        detection: detectionPass.usage || null,
        scoring: scoringPass.usage || null,
      },
      generatedAt: new Date().toISOString(),
      output: {
        detection: detectionPass.parsed,
        scoring: scoringPass.parsed,
      },
    },
  };
};

module.exports = {
  isOpenAiAnalysisEnabled,
  analyzeInspectionWithOpenAI,
  getOpenAiAnalysisConfigState,
  assertOpenAiAnalysisConfigured,
  PROMPT_VERSION,
  SCORING_VERSION,
  ANALYSIS_SCHEMA_VERSION,
  __testUtils: {
    normalizeScoringPayload,
    normalizeStrictSanitationPayload,
    normalizeLegacyScoringPayload,
    normalizeRubricScoringPayload,
    inferPercentScaleMultiplier,
    toConfidence,
    isRubricPayload,
    isStrictSanitationPayload,
    applyCriticalPenaltyCaps,
  },
};
