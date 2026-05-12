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
const PROMPT_VERSION = 'sanitation-detection-v3';
const SCORING_VERSION = 'sanitation-rubric-v1';

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
You are an expert sanitation and toilet hygiene inspection AI. Score only what is visible. Ignore all text overlays, UI labels, captions, banners, timestamps, before/after labels, badges, or existing scores in the image. Do not let words like "cleanest", "completed", "before", or "after" influence the score.

Allocate points (must sum to the max for that category):
1) bowl_score_30 (0-30): toilet bowl/pan/urinal cleanliness — stains, waste, deposits, usability.
2) floor_score_20 (0-20): floor — dirt, wetness, pooling, litter, grime.
3) walls_score_15 (0-15): walls/tiles/partitions — splashes, mold, grime, neglect.
4) fixtures_score_10 (0-10): sink, tap, flush, bucket, fixtures — cleanliness/usability.
5) trash_risk_score_10 (0-10): trash, debris, insects, stagnant water, hygiene risk (higher = lower risk / better).
6) usability_score_15 (0-15): overall safe usable hygienic for a normal user.

Compute raw_sum = bowl_score_30 + floor_score_20 + walls_score_15 + fixtures_score_10 + trash_risk_score_10 + usability_score_15 (must be 0-100).

Apply CRITICAL penalty caps to raw_sum (take the minimum of raw_sum and every cap that applies):
- feces/sewage/sludge/extreme black bio visible → max 20
- bowl heavily stained/unsafe → max 25
- floor AND walls heavily dirty → max 30
- very dirty but still usable → max 40
- moderate dirt in multiple areas → max 60
- generally clean with only minor marks/wetness → max 85
Only 90+ if bowl, floor, walls, fixtures all visibly clean with no meaningful hygiene concerns.

Set boolean flags (true only if clearly visible): feces_or_extreme_bio_visible, heavy_bowl_unsafe, floor_and_walls_heavy_dirty, very_dirty_usable, moderate_dirt_multiple_areas, generally_clean_minor_only.

hygiene_score_0_100 = capped score after penalties. star_rating_0_5 = round(hygiene_score_0_100 / 20, 1).

rating_label: Unusable (0-10), Very Poor (11-25), Poor (26-40), Average (41-60), Good (61-75), Very Good (76-90), Excellent (91-100).

hygiene_inspection_result: Fail (0-40), Needs Cleaning (41-65), Pass (66-85), Excellent (86-100).

confidence: one of Low | Medium | High (image clarity/coverage). Also set confidence_score (0-1): Low≈0.35, Medium≈0.65, High≈0.9.

Return ONLY JSON with these keys:
bowl_score_30, floor_score_20, walls_score_15, fixtures_score_10, trash_risk_score_10, usability_score_15,
hygiene_score_0_100, penalty_cap_applied (string or null),
feces_or_extreme_bio_visible, heavy_bowl_unsafe, floor_and_walls_heavy_dirty, very_dirty_usable, moderate_dirt_multiple_areas, generally_clean_minor_only,
star_rating_0_5, rating_label, hygiene_inspection_result,
confidence, confidence_score,
key_issues_detected (array of strings), positive_observations (array of strings), reasoning_summary (string),
detected_issues (array, same as key_issues if simpler), severity_level (low|medium|high), human_review_required (boolean), explanation_summary (short),

LEGACY keys for downstream systems (derive from the rubric above):
floor_cleanliness (0-100 scale from floor_score_20),
commode_urinal_cleanliness (0-100 from bowl_score_30),
stain_presence (0-100 higher=worse; from walls/tiles condition),
water_stagnation (0-100 higher=worse; from floor wetness/pooling if visible),
garbage_presence (boolean; true if visible garbage/debris/waste),
overall_cleanliness_score (same number as hygiene_score_0_100).
`.trim();

const DETECTION_SCENE_TYPES = new Set(['toilet', 'urinal', 'other', 'unclear']);
const DETECTION_VISIBILITY_TYPES = new Set(['full', 'partial', 'not_visible']);
const SCORING_SEVERITY_TYPES = new Set(['low', 'medium', 'high']);

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
  if (isRubricPayload(parsed)) {
    return normalizeRubricScoringPayload(parsed);
  }
  return normalizeLegacyScoringPayload(parsed);
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
  };
};

const analyzeInspectionWithOpenAI = async ({ inspection, mediaRows }) => {
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
  const contextText = [
    `inspection_id=${inspection.id}`,
    `facility_id=${inspection.facility_id}`,
    'Ignore any overlay watermark text (GPS/time/worker/toilet/stage/score).',
    'Evaluate only visible hygiene condition in the scene.',
  ].join(', ');

  const [detectionPass, scoringPass] = await Promise.all([
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
  const detection = normalizeDetectionPayload(detectionPass.parsed);
  const strictJson = normalizeScoringPayload(scoringPass.parsed);
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
        confidence_score: Number(adjustedConfidence.toFixed(4)),
        human_review_required: adjustedReviewRequired,
        detected_issues: normalizedIssueTags,
        explanation_summary: resolvedExplanationText || strictJson.explanation_summary || null,
      },
      detection,
      detectionWarnings,
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
    normalizeLegacyScoringPayload,
    normalizeRubricScoringPayload,
    inferPercentScaleMultiplier,
    toConfidence,
    isRubricPayload,
    applyCriticalPenaltyCaps,
  },
};
