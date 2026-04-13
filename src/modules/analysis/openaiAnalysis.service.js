const { resolveMediaUrlForVision } = require('./analysisMediaResolver.service');

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const ANALYSIS_SCHEMA_VERSION = 'analysis.v4';
const PROMPT_VERSION = 'sanitation-detection-v1';
const SCORING_VERSION = 'sanitation-weighted-v2';

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
- Do not hallucinate.
- Return valid JSON only.
`.trim();

const SCORING_PROMPT = `
You are a sanitation inspection AI trained to evaluate toilet cleanliness.

Analyze the image and return ONLY JSON.

Evaluate these aspects:
1. Floor cleanliness (0-100)
2. Commode/urinal cleanliness (0-100)
3. Stain severity (0-100, higher = worse)
4. Water stagnation (0-100, higher = worse)
5. Garbage presence (true/false)

Then compute:
- overall_cleanliness_score (0-100)
- confidence_score (0-1)

Rules:
- Use the full 0-100 scale. Avoid defaulting to mid-range values.
- 90-100: spotless and clearly well maintained.
- 70-89: mostly clean with minor visible issues.
- 40-69: noticeable dirt/stains/wetness or mixed condition.
- 0-39: clearly unhygienic, heavy stains/waste/water problems.
- If image is unclear, reduce confidence.
- If toilet is not visible, return low confidence and explicit reason in explanation_summary.
- Do NOT hallucinate.
- Be strict and realistic.

Also return:
- detected_issues (array)
- severity_level (low/medium/high)
- human_review_required (true/false)
- explanation_summary (short factual summary)

Return ONLY valid JSON with exactly the keys listed above.
`.trim();

const DETECTION_SCENE_TYPES = new Set(['toilet', 'urinal', 'other', 'unclear']);
const DETECTION_VISIBILITY_TYPES = new Set(['full', 'partial', 'not_visible']);
const SCORING_SEVERITY_TYPES = new Set(['low', 'medium', 'high']);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

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

const toScore = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(Math.round(parsed), 0, 100);
};

const toConfidence = (value, fallback = null) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(Number(parsed.toFixed(4)), 0, 1);
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

  return Math.round(
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

const normalizeScoringPayload = (parsed) => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw schemaError('OPENAI_SCORING_PARSE_FAILED', 'Scoring pass did not return a JSON object');
  }
  const raw = parsed;

  const readFirst = (source, keys = []) => {
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

  const floorCleanliness = toScore(floorRaw, 0);
  const commodeCleanliness = toScore(commodeRaw, 0);
  const stainPresence = toScore(stainRaw, 0);
  const waterStagnation = toScore(waterRaw, 0);

  const weightedOverall = weightedOverallFromStrict({
    floorCleanliness,
    commodeCleanliness,
    stainPresence,
    waterStagnation,
    garbagePresence,
  });

  const overallScore = toScore(overallRaw, weightedOverall);
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

const getOpenAiAnalysisConfigState = () => {
  const provider = String(process.env.ANALYSIS_PROVIDER || '').trim().toLowerCase();
  const hasApiKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim());
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

const callOpenAiVisionJson = async ({ model, promptText, imageUrl, contextText }) => {
  const baseUrl = String(process.env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Math.max(Number(process.env.OPENAI_ANALYSIS_TIMEOUT_MS || 45000), 5000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload;

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 700,
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

  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-4o';
  const contextText = `inspection_id=${inspection.id}, facility_id=${inspection.facility_id}, stage=${selected.capture_stage || 'evidence'}`;

  const detectionPass = await callOpenAiVisionJson({
    model,
    promptText: DETECTION_PROMPT,
    imageUrl,
    contextText,
  });
  const detection = normalizeDetectionPayload(detectionPass.parsed);

  const scoringPass = await callOpenAiVisionJson({
    model,
    promptText: SCORING_PROMPT,
    imageUrl,
    contextText,
  });
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
};
