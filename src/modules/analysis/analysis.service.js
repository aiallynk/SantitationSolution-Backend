const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  Inspection,
  InspectionMedia,
  InspectionSubmission,
  AiAnalysisResult,
  AiProcessingJob,
  InspectionEvent,
  Alert,
  Facility,
  Tenant,
} = require('../../models');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { createAuditLog } = require('../audit/audit.service');
const {
  analyzeInspectionWithOpenAI,
  getOpenAiAnalysisConfigState,
  PROMPT_VERSION,
  SCORING_VERSION,
} = require('./openaiAnalysis.service');
const { validateInspectionMediaQuality } = require('./qualityValidation.service');
const {
  computePerceptualHash,
  perceptualSimilarity,
} = require('./perceptualHash.service');
const { normalizeIssueTags } = require('./issueNormalization.service');
const { computeConfidence } = require('./confidenceEngine.service');
const {
  recomputeInspectionAggregates,
  scoreLabel,
} = require('../inspections/inspectionEvidence.service');
const { classifyAnalysisFailure } = require('./analysisFailureClassifier.service');
const { IMAGE_PROCESSING_STATES } = require('../inspections/imageLifecycle.constants');
const { runtimeConfig } = require('../../config/runtime');
const {
  applySingleImagePostProcessing,
  buildSupervisorReviewFlags,
} = require('./sanitationPostProcessing.helper');
const {
  AI_SCORING_POLICY_VERSION,
  resolveAiScoringMode,
  scoreInspectionFindings,
} = require('./aiInspectionScoring.service');
const { resolvePpmOdorTier } = require('../sensors/ppmOdorTier.service');
const { resolveTenantFeatureFlags } = require('../../core/config/tenantFeatureFlags');
const {
  EXPLAINABLE_SCORING_V2_VERSION,
  scoreExplainableInspection,
} = require('./explainableScoringV2.service');

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round2 = (value) =>
  value === null || value === undefined ? null : Number(Number(value).toFixed(2));
const toFiniteNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const mean = (values = []) => {
  if (!Array.isArray(values) || values.length === 0) return null;
  const valid = values
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
  if (valid.length === 0) return null;
  return valid.reduce((sum, item) => sum + item, 0) / valid.length;
};
const toSensorNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const parseSensorContext = (snapshot = null) => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const readingTime = snapshot.readingTime || snapshot.timestamp || snapshot.linkedAt || null;
  const readingTs = readingTime ? new Date(readingTime).getTime() : null;
  const readingAgeMinutes = Number.isFinite(readingTs)
    ? Math.max(0, Math.floor((Date.now() - readingTs) / 60000))
    : null;
  const context = {
    temperature: toSensorNumber(snapshot.temperature),
    humidity: toSensorNumber(snapshot.humidity),
    ppm: toSensorNumber(snapshot.ppm ?? snapshot.field1 ?? snapshot.field_1),
    battery: toSensorNumber(snapshot.battery ?? snapshot.batteryLevel),
    rssi: toSensorNumber(snapshot.rssi ?? snapshot.signalStrength),
    readingAgeMinutes,
    sensorStatus: String(snapshot.sensorStatus || 'ONLINE').toUpperCase(),
    readingTime: readingTime || null,
  };
  const hasMetric = Object.entries(context).some(([k, v]) => k !== 'sensorStatus' && k !== 'readingTime' && v !== null);
  return hasMetric ? context : null;
};
const computeSensorImpact = (context = null) => {
  if (!context) {
    return {
      sensorImpact: 0,
      nonPpmSensorImpact: 0,
      ppmImpact: 0,
      environmentalScore: null,
      ppmOdorTier: null,
      reasons: [],
    };
  }
  let nonPpmSensorImpact = 0;
  const reasons = [];
  if (context.sensorStatus === 'OFFLINE') {
    nonPpmSensorImpact -= 6;
    reasons.push('sensor_offline');
  }
  if (context.readingAgeMinutes !== null && context.readingAgeMinutes > 15) {
    nonPpmSensorImpact -= Math.min(6, Math.floor((context.readingAgeMinutes - 15) / 15) + 1);
    reasons.push('stale_sensor_reading');
  }
  if (context.humidity !== null && context.humidity >= 90) {
    nonPpmSensorImpact -= 7;
    reasons.push('very_high_humidity');
  } else if (context.humidity !== null && context.humidity >= 80) {
    nonPpmSensorImpact -= 4;
    reasons.push('high_humidity');
  } else if (context.humidity !== null && context.humidity <= 10) {
    nonPpmSensorImpact -= 3;
    reasons.push('very_low_humidity');
  }
  if (context.temperature !== null && context.temperature >= 40) {
    nonPpmSensorImpact -= 6;
    reasons.push('very_high_temperature');
  } else if (context.temperature !== null && context.temperature >= 35) {
    nonPpmSensorImpact -= 3;
    reasons.push('high_temperature');
  }
  const ppmOdorTier = resolvePpmOdorTier(context.ppm);
  const ppmImpact = ppmOdorTier?.scoreAdjustment || 0;
  if (ppmOdorTier) {
    reasons.push(`ppm_${ppmOdorTier.key}_odor_tier`);
  }
  nonPpmSensorImpact = clamp(Math.round(nonPpmSensorImpact), -25, 0);
  const sensorImpact = clamp(nonPpmSensorImpact + ppmImpact, -25, 20);
  const environmentalScore = clamp(100 + sensorImpact, 0, 100);
  return {
    sensorImpact,
    nonPpmSensorImpact,
    ppmImpact,
    environmentalScore,
    ppmOdorTier,
    reasons,
  };
};
const ANALYSIS_SCHEMA_VERSION = 'analysis.v5';
const FRAUD_SIMILARITY_THRESHOLD = runtimeConfig.analysis.fraudSimilarityThreshold;
const AI_IMAGE_MAX_RETRIES = Math.max(runtimeConfig.analysis.aiImageMaxRetries, 1);
const AI_RETRY_BASE_DELAY_MS = Math.max(runtimeConfig.analysis.aiRetryBaseDelayMs, 500);
const JOB_LEASE_MS = Math.max(runtimeConfig.analysis.jobLeaseMs, 60000);
const SCORE_SPREAD_GAIN = clamp(
  toFiniteNumber(runtimeConfig.analysis.scoreSpreadGain, 1.16),
  1,
  1.4
);
const ALWAYS_SCORE_ON_FAILURE = Boolean(runtimeConfig.analysis.alwaysScoreOnFailure);

const deriveStatus = (score) => {
  if (score >= 80) return 'clean';
  if (score >= 60) return 'moderate';
  if (score >= 40) return 'poor';
  return 'critical';
};

const deriveSeverityLabel = ({ overallCleanlinessScore, issueCount }) => {
  if (overallCleanlinessScore < 35 || issueCount >= 4) return 'critical';
  if (overallCleanlinessScore < 50 || issueCount >= 3) return 'high';
  if (overallCleanlinessScore < 70 || issueCount >= 2) return 'medium';
  return 'low';
};

const toHighMediumLowSeverity = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical') return 'high';
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return null;
};

const severityFromHygieneRisk = (risk) => {
  const normalized = String(risk || '').trim().toLowerCase();
  if (normalized === 'severe' || normalized === 'high') return 'high';
  if (normalized === 'medium') return 'medium';
  if (normalized === 'low') return 'low';
  return null;
};

const hygieneRiskRank = (risk) => {
  const normalized = String(risk || '').trim().toLowerCase();
  if (normalized === 'severe') return 3;
  if (normalized === 'high') return 2;
  if (normalized === 'medium') return 1;
  return 0;
};

const scoreToHygieneRisk = (score) => {
  const value = clamp(Number(score) || 0, 0, 100);
  if (value <= 25) return 'severe';
  if (value <= 40) return 'high';
  if (value <= 70) return 'medium';
  return 'low';
};

const inferCriticalFindingsFromStrictJson = (strictJson = {}, normalizedIssues = []) => {
  const issues = Array.isArray(normalizedIssues)
    ? normalizedIssues.map((item) => String(item || '').toLowerCase())
    : [];
  const issueText = issues.join(' | ');
  return {
    visible_feces_or_potty:
      strictJson?.critical_findings?.visible_feces_or_potty === true ||
      Boolean(strictJson?.feces_or_extreme_bio_visible) ||
      ['feces', 'faeces', 'potty', 'stool', 'human_waste', 'sewage', 'biohazard'].some((k) =>
        issueText.includes(k)
      ),
    urine_pooling:
      strictJson?.critical_findings?.urine_pooling === true ||
      ['urine', 'urine_pooling', 'pee_pool'].some((k) => issueText.includes(k)),
    dirty_commode_or_pan:
      strictJson?.critical_findings?.dirty_commode_or_pan === true ||
      Boolean(strictJson?.heavy_bowl_unsafe) ||
      ['dirty_commode', 'dirty_pan', 'dirty_bowl', 'commode_stain', 'pan_stain'].some((k) =>
        issueText.includes(k)
      ),
    heavy_stains:
      strictJson?.critical_findings?.heavy_stains === true ||
      Boolean(strictJson?.heavy_bowl_unsafe) ||
      Number(strictJson?.stain_presence || 0) >= 60,
    trash_or_waste:
      strictJson?.critical_findings?.trash_or_waste === true ||
      Boolean(strictJson?.garbage_presence) ||
      ['trash', 'garbage', 'waste', 'overflowing_bin', 'sanitary_waste', 'wet_waste'].some((k) =>
        issueText.includes(k)
      ),
    waterlogging:
      strictJson?.critical_findings?.waterlogging === true ||
      Number(strictJson?.water_stagnation || 0) >= 60 ||
      ['waterlogging', 'water_logging', 'dirty_water', 'blocked_drain'].some((k) =>
        issueText.includes(k)
      ),
    insects_or_biohazard:
      strictJson?.critical_findings?.insects_or_biohazard === true ||
      ['insect', 'maggot', 'biohazard', 'blood'].some((k) => issueText.includes(k)),
  };
};

const buildStrictToiletJsonFromNormalizedResult = ({
  overallCleanlinessScore,
  cleanlinessScore,
  hygieneScore,
  stainScore,
  wetnessScore,
  litterScore,
  confidenceScore,
  issueTags,
  severityLabel,
  reviewRequired,
}) => {
  const floorCleanliness = clamp(Number(cleanlinessScore || 0), 0, 100);
  const commodeCleanliness = clamp(Number(hygieneScore || 0), 0, 100);
  const stainPresence = clamp(100 - Number(stainScore || 0), 0, 100);
  const waterStagnation = clamp(100 - Number(wetnessScore || 0), 0, 100);
  const garbagePresence = Number(litterScore || 0) < 50;
  const normalizedIssues = Array.isArray(issueTags)
    ? [...new Set(issueTags.map((item) => String(item || '').trim()).filter(Boolean))]
    : [];

  const resolvedOverallScore = clamp(
    Number.isFinite(Number(overallCleanlinessScore)) ? Number(overallCleanlinessScore) : floorCleanliness,
    0,
    100
  );
  const confidence =
    confidenceScore !== null && confidenceScore !== undefined
      ? clamp(Number(confidenceScore), 0, 1)
      : null;

  const mappedSeverity = toHighMediumLowSeverity(severityLabel);
  const resolvedSeverity =
    mappedSeverity ||
    (resolvedOverallScore < 45 || stainPresence > 65 || waterStagnation > 65 || garbagePresence
      ? 'high'
      : resolvedOverallScore < 70 || stainPresence > 45 || waterStagnation > 45
        ? 'medium'
        : 'low');

  const threshold = runtimeConfig.analysis.confidenceThreshold;
  const humanReviewRequired =
    reviewRequired !== undefined && reviewRequired !== null
      ? Boolean(reviewRequired)
      : (confidence ?? 0.65) < threshold || resolvedSeverity === 'high';

  return {
    floor_cleanliness: Math.round(floorCleanliness),
    commode_urinal_cleanliness: Math.round(commodeCleanliness),
    stain_presence: Math.round(stainPresence),
    water_stagnation: Math.round(waterStagnation),
    garbage_presence: garbagePresence,
    overall_cleanliness_score: Math.round(resolvedOverallScore),
    confidence_score: confidence !== null ? Number(confidence.toFixed(3)) : null,
    detected_issues: normalizedIssues,
    severity_level: resolvedSeverity,
    human_review_required: humanReviewRequired,
  };
};

const normalizeResultFromProvider = ({ providerResult, processingMs }) => {
  if (!providerResult || typeof providerResult !== 'object') {
    throw new AppError('AI scoring provider response is missing', 500, {
      code: 'AI_PROVIDER_RESPONSE_MISSING',
    });
  }

  const source = providerResult;
  const overallCleanlinessScore = clamp(
    Number(source.overallCleanlinessScore ?? source.cleanlinessScore ?? 0),
    0,
    100
  );

  const subScores =
    source.subScores && typeof source.subScores === 'object' ? source.subScores : {};
  const issueTags = Array.isArray(source.issueTags)
    ? [...new Set(source.issueTags.map((item) => String(item).trim()).filter(Boolean))]
    : [];
  const confidenceScore = Number.isFinite(Number(source.confidenceScore))
    ? clamp(Number(source.confidenceScore), 0, 1)
    : null;

  const reviewRequired =
    source.reviewRequired !== undefined
      ? Boolean(source.reviewRequired)
      : (confidenceScore ?? 0.65) < runtimeConfig.analysis.confidenceThreshold;

  const severityLabel =
    source.severityLabel ||
    deriveSeverityLabel({
      overallCleanlinessScore,
      issueCount: issueTags.length,
    });

  const overallStatus = source.overallStatus || deriveStatus(overallCleanlinessScore);

  const normalizedBase = {
    modelName: source.modelName || runtimeConfig.analysis.openaiModel || 'gpt-4o-mini',
    modelVersion: source.modelVersion || 'openai-chat-completions-v4',
    provider: source.provider || 'openai',
    schemaVersion: source.schemaVersion || ANALYSIS_SCHEMA_VERSION,
    promptVersion: source.promptVersion || PROMPT_VERSION,
    scoringVersion: source.scoringVersion || SCORING_VERSION,
    overallStatus,
    overallCleanlinessScore,
    cleanlinessScore: clamp(Number(source.cleanlinessScore ?? 0), 0, 100),
    hygieneScore: clamp(Number(source.hygieneScore ?? 0), 0, 100),
    odorRiskScore: clamp(Number(source.odorRiskScore ?? 0), 0, 100),
    wetnessScore: clamp(Number(source.wetnessScore ?? 0), 0, 100),
    stainScore: clamp(Number(source.stainScore ?? 0), 0, 100),
    litterScore: clamp(Number(source.litterScore ?? 0), 0, 100),
    subScores,
    issueTags,
    severityLabel,
    confidenceScore,
    reviewRequired,
    explanationText: String(source.explanationText || source.summary || '').slice(0, 1900) || null,
    anomalyFlags:
      source.anomalyFlags && typeof source.anomalyFlags === 'object'
        ? source.anomalyFlags
        : {},
    processingMs,
    sensorImpact: clamp(Number(source.sensorImpact ?? source.rawResult?.strictJson?.sensor_impact ?? 0), -25, 0),
    environmentalScore:
      source.environmentalScore ?? source.rawResult?.strictJson?.environmental_score ?? null,
  };

  const strictJsonFromSource =
    source?.rawResult &&
    typeof source.rawResult === 'object' &&
    source.rawResult.strictJson &&
    typeof source.rawResult.strictJson === 'object'
      ? source.rawResult.strictJson
      : null;
  if (!strictJsonFromSource) {
    throw new AppError('AI scoring provider response missing strict JSON payload', 500, {
      code: 'AI_PROVIDER_STRICT_JSON_MISSING',
    });
  }
  const strictJson = strictJsonFromSource;

  return {
    ...normalizedBase,
    rawResult: {
      ...(source.rawResult || {}),
      strictJson,
      provider: normalizedBase.provider,
      processingMs,
    },
  };
};

const maybeCreateAlert = async ({ inspection, result }) => {
  const shouldAlert =
    result.overallStatus === 'poor' ||
    result.overallStatus === 'critical' ||
    result.odorRiskScore > 75;

  if (!shouldAlert) {
    return null;
  }

  const severity =
    result.overallStatus === 'critical' || result.odorRiskScore > 85 ? 'critical' : 'high';

  const openAlert = await Alert.findOne({
    where: {
      source_type: 'ai_analysis',
      source_id: inspection.id,
      status: {
        [Op.in]: ['open', 'acknowledged'],
      },
    },
  });
  if (openAlert) {
    return openAlert;
  }

  const inspectionCode = `INS-${String(inspection.id || '')
    .replace(/-/g, '')
    .slice(0, 8)
    .toUpperCase()}`;

  const alert = await Alert.create({
    tenant_id: inspection.tenant_id,
    alert_type: 'inspection_quality_breach',
    severity,
    source_type: 'ai_analysis',
    source_id: inspection.id,
    facility_id: inspection.facility_id,
    message: `${inspectionCode} flagged ${result.severityLabel} (score ${result.overallCleanlinessScore})`,
    status: 'open',
    created_at: new Date(),
    updated_at: new Date(),
  });

  eventBus.emit(EVENTS.ALERT_CREATED, {
    id: alert.id,
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    facilityId: inspection.facility_id,
    severity: alert.severity,
    status: alert.status,
    message: alert.message,
  });

  return alert;
};

const toGarbageScore = (strictJson, result) => {
  if (strictJson && strictJson.garbage_presence !== undefined) {
    return strictJson.garbage_presence ? 100 : 0;
  }
  if (Number(result.litterScore || 0) < 50) {
    return 100;
  }
  return 0;
};

const normalizeSha256 = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32,128}$/.test(normalized) ? normalized : null;
};

const readAiScoringMetadata = (mediaRow) =>
  mediaRow?.metadata &&
  typeof mediaRow.metadata === 'object' &&
  !Array.isArray(mediaRow.metadata) &&
  mediaRow.metadata.ai_scoring &&
  typeof mediaRow.metadata.ai_scoring === 'object'
    ? mediaRow.metadata.ai_scoring
    : null;

const buildCachedImageResultFromMediaRow = (
  mediaRow,
  { provider = 'cached', imageId = null, rawResultSource = 'media_row' } = {}
) => {
  const cachedScoring = readAiScoringMetadata(mediaRow);
  const overallScore = Number(mediaRow.overall_score || 0);
  const floorScore = Number(mediaRow.floor_score || 0);
  const commodeScore = Number(mediaRow.commode_score || 0);
  const stainScore = Number(mediaRow.stain_score || 0);
  const waterScore = Number(mediaRow.water_score || 0);
  const garbageScore = Number(mediaRow.garbage_score || 0);
  const confidenceScore =
    mediaRow.confidence_score !== null && mediaRow.confidence_score !== undefined
      ? Number(mediaRow.confidence_score)
      : null;
  const issueTags = Array.isArray(mediaRow.issue_tags) ? mediaRow.issue_tags : [];
  const starRating =
    cachedScoring?.star_rating_0_5 !== undefined
      ? Number(cachedScoring.star_rating_0_5)
      : Number((overallScore / 20).toFixed(1));
  const strictJson = {
    ...(cachedScoring || {}),
    floor_cleanliness: Math.round(floorScore),
    commode_urinal_cleanliness: Math.round(commodeScore),
    stain_presence: Math.round(stainScore),
    water_stagnation: Math.round(waterScore),
    garbage_presence: garbageScore > 50,
    overall_cleanliness_score: Math.round(overallScore),
    confidence_score: confidenceScore,
    detected_issues: issueTags,
    severity_level: mediaRow.severity || 'medium',
    human_review_required: Boolean(mediaRow.review_required),
    explanation_summary: mediaRow.explanation_summary || mediaRow.issue_summary || null,
    score_0_100:
      cachedScoring?.score_0_100 !== undefined
        ? Number(cachedScoring.score_0_100)
        : Math.round(overallScore),
    star_rating_0_5: starRating,
    hygiene_risk: cachedScoring?.hygiene_risk || scoreToHygieneRisk(overallScore),
    cleanliness_level: cachedScoring?.cleanliness_level || null,
    critical_findings:
      cachedScoring?.critical_findings && typeof cachedScoring.critical_findings === 'object'
        ? cachedScoring.critical_findings
        : inferCriticalFindingsFromStrictJson(
            {
              stain_presence: stainScore,
              water_stagnation: waterScore,
              garbage_presence: garbageScore > 50,
            },
            issueTags
          ),
    requires_retake: Boolean(cachedScoring?.requires_retake),
    retake_reason: cachedScoring?.retake_reason || '',
  };

  return {
    imageId: imageId || mediaRow.id,
    strictJson,
    result: {
      overallCleanlinessScore: overallScore,
      cleanlinessScore: floorScore,
      hygieneScore: commodeScore,
      stainScore: 100 - stainScore,
      wetnessScore: 100 - waterScore,
      litterScore: 100 - garbageScore,
      confidenceScore,
      issueTags,
      reviewRequired: Boolean(mediaRow.review_required),
      severityLabel: mediaRow.severity || 'medium',
      modelName: runtimeConfig.analysis.openaiModel || 'gpt-4o-mini',
      modelVersion: mediaRow.model_version || 'openai-chat-completions-v4',
      provider,
      promptVersion: mediaRow.prompt_version || PROMPT_VERSION,
      scoringVersion: mediaRow.scoring_version || SCORING_VERSION,
      explanationText: mediaRow.explanation_summary || mediaRow.issue_summary || null,
      rawResult: {
        strictJson,
        cache: {
          source: rawResultSource,
          sourceImageId: mediaRow.id,
        },
      },
    },
    scoringRejected: false,
  };
};

const findReusableScoredMediaByHash = async ({ mediaRow, inspection }) => {
  const hash = normalizeSha256(mediaRow?.sha256);
  if (!hash) return null;

  return InspectionMedia.findOne({
    where: {
      sha256: hash,
      id: { [Op.ne]: mediaRow.id },
      ai_status: 'AI_COMPLETED',
      scoring_version: SCORING_VERSION,
      overall_score: { [Op.ne]: null },
      [Op.or]: [{ scoring_rejected: false }, { scoring_rejected: { [Op.is]: null } }],
    },
    include: [
      {
        model: Inspection,
        attributes: ['id', 'tenant_id'],
        required: true,
        where: {
          tenant_id: inspection.tenant_id,
        },
      },
    ],
    order: [
      ['ai_processed_at', 'DESC'],
      ['updated_at', 'DESC'],
    ],
  });
};

const weightedOverallScore = (strictJson) => {
  const floor = clamp(Number(strictJson?.floor_cleanliness || 0), 0, 100);
  const commode = clamp(Number(strictJson?.commode_urinal_cleanliness || 0), 0, 100);
  const stainSeverity = clamp(Number(strictJson?.stain_presence || 0), 0, 100);
  const waterSeverity = clamp(Number(strictJson?.water_stagnation || 0), 0, 100);
  const garbagePresence = Boolean(strictJson?.garbage_presence);

  const stainCleanliness = 100 - stainSeverity;
  const waterCleanliness = 100 - waterSeverity;
  const garbageCleanliness = garbagePresence ? 0 : 100;

  return round2(
    clamp(
      floor * 0.3 +
        commode * 0.3 +
        stainCleanliness * 0.2 +
        waterCleanliness * 0.1 +
        garbageCleanliness * 0.1,
      0,
      100
    )
  );
};

const severityCalibrationShift = (severityLevel) => {
  const normalized = String(severityLevel || '').trim().toLowerCase();
  if (normalized === 'high') return -1.5;
  if (normalized === 'medium') return -0.3;
  if (normalized === 'low') return 1;
  return 0;
};

const calibrateOverallScore = ({
  strictJson,
  normalizedIssues = [],
  confidence = null,
}) => {
  if (String(strictJson?.scoring_rubric || '').trim() === 'hygiene_v1') {
    const modelOverall = clamp(
      toFiniteNumber(strictJson?.overall_cleanliness_score, 0),
      0,
      100
    );
    const confidenceValue = toFiniteNumber(
      confidence,
      toFiniteNumber(strictJson?.confidence_score, null)
    );
    const confidencePenalty =
      confidenceValue === null ? 0 : clamp((0.58 - confidenceValue) * 5, 0, 5);
    return round2(clamp(modelOverall - confidencePenalty, 0, 100));
  }

  const weighted = weightedOverallScore(strictJson);
  const modelOverall = clamp(
    toFiniteNumber(strictJson?.overall_cleanliness_score, weighted),
    0,
    100
  );
  const floor = clamp(
    toFiniteNumber(strictJson?.floor_cleanliness, modelOverall),
    0,
    100
  );
  const commode = clamp(
    toFiniteNumber(strictJson?.commode_urinal_cleanliness, modelOverall),
    0,
    100
  );
  const stainPresence = clamp(toFiniteNumber(strictJson?.stain_presence, 0), 0, 100);
  const waterStagnation = clamp(
    toFiniteNumber(strictJson?.water_stagnation, 0),
    0,
    100
  );
  const garbagePresence = Boolean(strictJson?.garbage_presence);

  const issueCount = Array.isArray(normalizedIssues) ? normalizedIssues.length : 0;
  const issuePenalty = Math.min(9, issueCount * 1.6);
  const stainPenalty = clamp((stainPresence - 60) * 0.09, 0, 4);
  const waterPenalty = clamp((waterStagnation - 60) * 0.07, 0, 3);
  const garbagePenalty = garbagePresence ? 4 : 0;
  const severityShift = severityCalibrationShift(strictJson?.severity_level);

  const confidenceValue = toFiniteNumber(
    confidence,
    toFiniteNumber(strictJson?.confidence_score, null)
  );
  const confidencePenalty =
    confidenceValue === null ? 0 : clamp((0.58 - confidenceValue) * 8, 0, 2.5);
  const confidenceBoost =
    confidenceValue === null ? 0 : clamp((confidenceValue - 0.8) * 3, 0, 1);

  const highCleanlinessBonus =
    floor >= 88 &&
    commode >= 88 &&
    stainPresence <= 20 &&
    waterStagnation <= 20 &&
    !garbagePresence &&
    issueCount === 0
      ? 4
      : 0;

  const catastrophicDirty =
    floor <= 5 &&
    commode <= 5 &&
    stainPresence >= 95 &&
    waterStagnation >= 95 &&
    garbagePresence;

  const calibratedFloor = catastrophicDirty
    ? 0
    : clamp(
        weighted * 0.38 +
          (garbagePresence ? 0 : 4) +
          (confidenceValue === null ? 0 : clamp((confidenceValue - 0.5) * 3, -1.2, 1.2)),
        1.5,
        35
      );

  const scoreGap = Math.abs(modelOverall - weighted);
  const modelWeight =
    scoreGap >= 35 ? 0.1 : scoreGap >= 20 ? 0.2 : scoreGap >= 10 ? 0.3 : 0.4;
  const blendedBase = weighted * (1 - modelWeight) + modelOverall * modelWeight;
  const adjustedBase =
    blendedBase -
    issuePenalty -
    stainPenalty -
    waterPenalty -
    garbagePenalty -
    confidencePenalty +
    confidenceBoost +
    severityShift +
    highCleanlinessBonus;
  const spreadAdjusted = 50 + (adjustedBase - 50) * SCORE_SPREAD_GAIN;
  const spreadProtected =
    spreadAdjusted > adjustedBase
      ? adjustedBase + (spreadAdjusted - adjustedBase) * 0.35
      : adjustedBase;
  const finalScore = catastrophicDirty
    ? clamp(spreadProtected, 0, 100)
    : clamp(Math.max(spreadProtected, calibratedFloor), 0, 100);

  return round2(finalScore);
};

const buildFallbackStrictJson = ({
  captureStage = 'evidence',
  qualityResult = null,
  failure = null,
}) => {
  const stage = String(captureStage || 'evidence').trim().toLowerCase();
  const qualityScore = clamp(
    toFiniteNumber(qualityResult?.imageQualityScore, 0.52),
    0,
    1
  );

  const stageBase = stage === 'before' ? 42 : stage === 'after' ? 55 : 48;
  const qualityLift = (qualityScore - 0.5) * 24;
  const floorCleanliness = clamp(Math.round(stageBase + qualityLift), 18, 88);
  const commodeCleanliness = clamp(Math.round(stageBase - 4 + qualityLift), 15, 86);
  const stainPresence = clamp(
    Math.round(100 - (floorCleanliness + commodeCleanliness) / 2 + 14),
    18,
    92
  );
  const waterStagnation = clamp(Math.round(100 - floorCleanliness + 10), 12, 90);
  const garbagePresence = floorCleanliness < 45 || commodeCleanliness < 42;

  const fallbackSummary = String(failure?.message || '').trim();
  const fallbackCode = String(failure?.errorCode || failure?.code || '')
    .trim()
    .toLowerCase();
  const confidenceScore = clamp(
    Number((0.28 + qualityScore * 0.26).toFixed(4)),
    0.28,
    0.62
  );

  const rawIssues = [
    fallbackCode ? `analysis_error_${fallbackCode}` : null,
    'ai_fallback_scoring',
    qualityResult?.validationStatus &&
    String(qualityResult.validationStatus).toUpperCase() !== 'VALID'
      ? 'image_quality_warning'
      : null,
  ].filter(Boolean);

  const detectedIssues = Array.from(new Set(rawIssues));
  const strict = {
    floor_cleanliness: floorCleanliness,
    commode_urinal_cleanliness: commodeCleanliness,
    stain_presence: stainPresence,
    water_stagnation: waterStagnation,
    garbage_presence: garbagePresence,
    overall_cleanliness_score: 0,
    confidence_score: confidenceScore,
    detected_issues: detectedIssues,
    severity_level: floorCleanliness < 45 || commodeCleanliness < 45 ? 'high' : 'medium',
    human_review_required: true,
    explanation_summary:
      fallbackSummary.length > 0
        ? `Fallback scoring applied: ${fallbackSummary}`.slice(0, 1800)
        : 'Fallback scoring applied because AI response was unavailable or invalid.',
  };

  strict.overall_cleanliness_score = weightedOverallScore(strict);
  return strict;
};

const compareAgainstBeforeHashes = async ({ inspectionId, captureStage, perceptualHash, imageId }) => {
  const stage = String(captureStage || '').toLowerCase();
  if (!perceptualHash || stage !== 'after') {
    return {
      maxSimilarity: null,
      suspicious: false,
      similarImageId: null,
    };
  }

  const beforeRows = await InspectionMedia.findAll({
    where: {
      inspection_id: inspectionId,
      capture_stage: { [Op.iLike]: 'before' },
      perceptual_hash: { [Op.ne]: null },
      id: { [Op.ne]: imageId || null },
    },
    attributes: ['id', 'perceptual_hash'],
  });

  let maxSimilarity = null;
  let similarImageId = null;
  for (const beforeRow of beforeRows) {
    const similarity = perceptualSimilarity(perceptualHash, beforeRow.perceptual_hash);
    if (similarity === null) continue;
    if (maxSimilarity === null || similarity > maxSimilarity) {
      maxSimilarity = similarity;
      similarImageId = beforeRow.id;
    }
  }

  return {
    maxSimilarity: maxSimilarity !== null ? Number(maxSimilarity.toFixed(4)) : null,
    suspicious: maxSimilarity !== null && maxSimilarity >= FRAUD_SIMILARITY_THRESHOLD,
    similarImageId: similarImageId || null,
  };
};

const reuseScoringFromMedia = async ({
  targetMediaRow,
  sourceMediaRow,
  inspection,
  qualityResult,
  perceptualHash,
  processingMs,
}) => {
  const similarityResult = await compareAgainstBeforeHashes({
    inspectionId: inspection.id,
    captureStage: targetMediaRow.capture_stage,
    perceptualHash: perceptualHash || sourceMediaRow.perceptual_hash,
    imageId: targetMediaRow.id,
  });
  const sourceScoring = readAiScoringMetadata(sourceMediaRow);
  const existingMetadata =
    targetMediaRow.metadata &&
    typeof targetMediaRow.metadata === 'object' &&
    !Array.isArray(targetMediaRow.metadata)
      ? targetMediaRow.metadata
      : {};
  const qualityValidationStatus = String(qualityResult?.validationStatus || '').toUpperCase();
  const qualityWarning = qualityValidationStatus && qualityValidationStatus !== 'VALID';
  const validationReasons = [
    `AI scoring reused from identical image ${sourceMediaRow.id}`,
    qualityWarning ? qualityResult?.validationReason || 'Image quality warning detected' : null,
    similarityResult?.suspicious
      ? `After image is too similar to before image ${similarityResult.similarImageId}`
      : null,
  ].filter(Boolean);
  const validationStatus = similarityResult?.suspicious
    ? 'POSSIBLE_DUPLICATE_REVIEW'
    : qualityWarning
      ? 'QUALITY_WARNING'
      : sourceMediaRow.validation_status || 'VALID';
  const reviewRequired =
    Boolean(sourceMediaRow.review_required) ||
    Boolean(similarityResult?.suspicious) ||
    qualityWarning;
  const cacheMetadata = {
    source: 'sha256',
    source_image_id: sourceMediaRow.id,
    source_inspection_id: sourceMediaRow.inspection_id,
    source_sha256: normalizeSha256(sourceMediaRow.sha256),
    reused_at: new Date().toISOString(),
    scoring_version: sourceMediaRow.scoring_version || SCORING_VERSION,
  };
  const metadata = {
    ...existingMetadata,
    ai_scoring: {
      ...(sourceScoring || {}),
      cache_reuse: cacheMetadata,
    },
    ai_cache_reuse: cacheMetadata,
    ai_supervisor_flags:
      sourceMediaRow.metadata &&
      typeof sourceMediaRow.metadata === 'object' &&
      !Array.isArray(sourceMediaRow.metadata)
        ? sourceMediaRow.metadata.ai_supervisor_flags || []
        : [],
  };

  await targetMediaRow.update({
    ai_status: 'AI_COMPLETED',
    processing_state: IMAGE_PROCESSING_STATES.AI_COMPLETED,
    image_quality_status:
      qualityResult?.imageQualityStatus || sourceMediaRow.image_quality_status || 'ok',
    overall_score: sourceMediaRow.overall_score,
    confidence_score: sourceMediaRow.confidence_score,
    floor_score: sourceMediaRow.floor_score,
    commode_score: sourceMediaRow.commode_score,
    stain_score: sourceMediaRow.stain_score,
    garbage_score: sourceMediaRow.garbage_score,
    water_score: sourceMediaRow.water_score,
    issue_tags: Array.isArray(sourceMediaRow.issue_tags) ? sourceMediaRow.issue_tags : [],
    issue_summary: sourceMediaRow.issue_summary || null,
    severity: sourceMediaRow.severity || 'medium',
    review_required: reviewRequired,
    model_version: sourceMediaRow.model_version || null,
    prompt_version: sourceMediaRow.prompt_version || PROMPT_VERSION,
    scoring_version: sourceMediaRow.scoring_version || SCORING_VERSION,
    ai_processed_at: new Date(),
    ai_error: null,
    last_error_code: null,
    last_error_message: null,
    next_retry_at: null,
    image_quality_score: qualityResult?.imageQualityScore || sourceMediaRow.image_quality_score || null,
    toilet_detected: Boolean(sourceMediaRow.toilet_detected),
    validation_status: validationStatus,
    validation_reason: validationReasons.join(' | ').slice(0, 500) || null,
    visibility_score: sourceMediaRow.visibility_score || null,
    perceptual_hash: perceptualHash || sourceMediaRow.perceptual_hash || null,
    similarity_score: similarityResult?.maxSimilarity || null,
    scoring_rejected: false,
    explanation_summary: sourceMediaRow.explanation_summary || null,
    metadata,
    updated_at: new Date(),
  });

  const cachedResult = buildCachedImageResultFromMediaRow(sourceMediaRow, {
    provider: 'hash_cache',
    imageId: targetMediaRow.id,
    rawResultSource: 'sha256',
  });
  cachedResult.strictJson = {
    ...cachedResult.strictJson,
    human_review_required: reviewRequired,
  };
  cachedResult.result.reviewRequired = reviewRequired;
  cachedResult.result.rawResult.cache = {
    ...cachedResult.result.rawResult.cache,
    reusedImageId: targetMediaRow.id,
    similarityScore: similarityResult?.maxSimilarity || null,
    suspiciousSimilarity: Boolean(similarityResult?.suspicious),
  };

  await InspectionEvent.create({
    tenant_id: inspection.tenant_id,
    inspection_id: inspection.id,
    toilet_id: targetMediaRow.toilet_unit_id || inspection.toilet_unit_id || null,
    image_id: targetMediaRow.id,
    event_type: 'analysis.image.cache_reused',
    event_status: 'AI_COMPLETED',
    source: 'worker',
    payload: {
      imageId: targetMediaRow.id,
      sourceImageId: sourceMediaRow.id,
      sourceInspectionId: sourceMediaRow.inspection_id,
      stage: targetMediaRow.capture_stage,
      sha256: normalizeSha256(targetMediaRow.sha256),
      score: round2(sourceMediaRow.overall_score),
      confidence: round2(sourceMediaRow.confidence_score),
      validationStatus,
      reviewRequired,
      similarityScore: similarityResult?.maxSimilarity || null,
      suspiciousSimilarity: Boolean(similarityResult?.suspicious),
      processingMs,
    },
    occurred_at: new Date(),
  });

  return cachedResult;
};

const buildResultSummaryFromImages = ({ imageResults, aggregate }) => {
  const effective = Array.isArray(imageResults)
    ? imageResults.filter(
        (item) =>
          item &&
          item.result &&
          !Boolean(item.scoringRejected) &&
          Number.isFinite(Number(item.result?.overallCleanlinessScore))
      )
    : [];
  const base = effective[effective.length - 1]?.result || null;

  const avgCleanliness = mean(
    effective.map((item) => item.strictJson?.floor_cleanliness ?? item.result?.cleanlinessScore)
  );
  const avgHygiene = mean(
    effective.map(
      (item) =>
        item.strictJson?.commode_urinal_cleanliness ?? item.result?.hygieneScore
    )
  );
  const avgStain = mean(
    effective.map((item) => item.strictJson?.stain_presence ?? 100 - Number(item.result?.stainScore || 0))
  );
  const avgWater = mean(
    effective.map((item) => item.strictJson?.water_stagnation ?? 100 - Number(item.result?.wetnessScore || 0))
  );
  const avgGarbage = mean(
    effective.map((item) => toGarbageScore(item.strictJson, item.result || {}))
  );
  const avgConfidence = mean(
    effective.map((item) => item.strictJson?.confidence_score ?? item.result?.confidenceScore)
  );

  const overviewScore =
    aggregate?.avgAfterScore ??
    aggregate?.avgBeforeScore ??
    base?.overallCleanlinessScore ??
    0;

  const issueTags = Array.from(
    new Set([
      ...(aggregate?.beforeIssueTags || []),
      ...(aggregate?.afterIssueTags || []),
      ...effective.flatMap((item) =>
        Array.isArray(item.strictJson?.detected_issues)
          ? item.strictJson.detected_issues
          : item.result?.issueTags || []
      ),
    ])
  );
  const overviewScoreRounded = round2(overviewScore) || 0;
  const riskCandidates = effective
    .map((item) => String(item.strictJson?.hygiene_risk || '').trim().toLowerCase())
    .filter((item) => ['low', 'medium', 'high', 'severe'].includes(item));
  const aggregateRisk =
    riskCandidates.length > 0
      ? riskCandidates.reduce((max, item) =>
          hygieneRiskRank(item) > hygieneRiskRank(max) ? item : max
        )
      : scoreToHygieneRisk(overviewScoreRounded);
  const aggregateCriticalFindings = effective.reduce(
    (acc, item) => {
      const findings =
        item?.strictJson?.critical_findings &&
        typeof item.strictJson.critical_findings === 'object'
          ? item.strictJson.critical_findings
          : {};
      const next = { ...acc };
      for (const key of Object.keys(next)) {
        if (findings[key] === true) next[key] = true;
      }
      return next;
    },
    {
      visible_feces_or_potty: false,
      urine_pooling: false,
      dirty_commode_or_pan: false,
      heavy_stains: false,
      trash_or_waste: false,
      waterlogging: false,
      insects_or_biohazard: false,
    }
  );
  const requiresRetakeAny = effective.some(
    (item) => item?.strictJson?.requires_retake === true
  );
  const severityLevelFromRisk = severityFromHygieneRisk(aggregateRisk) || 'medium';
  const supervisorFlags = Array.isArray(aggregate?.pipelineCounters?.ai_supervisor_flags)
    ? aggregate.pipelineCounters.ai_supervisor_flags
    : [];
  const comparisonResult =
    aggregate?.pipelineCounters &&
    typeof aggregate.pipelineCounters === 'object' &&
    aggregate.pipelineCounters.ai_comparison_result &&
    typeof aggregate.pipelineCounters.ai_comparison_result === 'object'
      ? aggregate.pipelineCounters.ai_comparison_result
      : null;
  const sensorImpact = Number(base?.sensorImpact ?? base?.strictJson?.sensor_impact ?? 0) || 0;
  const environmentalScore =
    base?.environmentalScore ?? base?.strictJson?.environmental_score ?? null;
  const ppmOdorTier = base?.strictJson?.ppm_odor_tier ?? null;

  return {
    overallStatus: deriveStatus(overviewScore),
    overallCleanlinessScore: overviewScoreRounded,
    cleanlinessScore: round2(avgCleanliness ?? base?.cleanlinessScore ?? overviewScore) || 0,
    hygieneScore: round2(avgHygiene ?? base?.hygieneScore ?? overviewScore) || 0,
    odorRiskScore: round2(base?.odorRiskScore ?? 60) || 0,
    wetnessScore: round2(100 - (avgWater ?? 0)) || 0,
    stainScore: round2(100 - (avgStain ?? 0)) || 0,
    litterScore: round2(100 - (avgGarbage ?? 0)) || 0,
    confidenceScore: round2(avgConfidence ?? aggregate?.confidenceAvg ?? base?.confidenceScore ?? 0.6),
    issueTags,
    severityLabel:
      base?.severityLabel ||
      (aggregate?.reviewRequired ? 'high' : severityLevelFromRisk),
    reviewRequired: Boolean(aggregate?.reviewRequired || base?.reviewRequired),
    sensorImpact,
    environmentalScore,
    ppmOdorTier,
    explanationText:
      base?.explanationText ||
      (issueTags.length > 0 ? `Detected issues: ${issueTags.slice(0, 6).join(', ')}` : 'No major issues detected'),
    modelName: base?.modelName || runtimeConfig.analysis.openaiModel || 'gpt-4o-mini',
    modelVersion: base?.modelVersion || 'openai-chat-completions-v4',
    provider: base?.provider || 'openai',
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    subScores: {
      floorCleanliness: round2(avgCleanliness),
      commodeCondition: round2(avgHygiene),
      stainSeverity: round2(avgStain),
      wastePresence: round2(avgGarbage !== null ? 100 - avgGarbage : null),
      waterStagnation: round2(avgWater !== null ? 100 - avgWater : null),
    },
    anomalyFlags: {
      low_cleanliness: overviewScore < 45,
      wetness_concern: (avgWater ?? 0) > 55,
      stain_concern: (avgStain ?? 0) > 55,
      litter_concern: (avgGarbage ?? 0) > 55,
    },
    rawResult: {
      strictJson: {
        floor_cleanliness: Math.round(avgCleanliness ?? base?.cleanlinessScore ?? 0),
        commode_urinal_cleanliness: Math.round(avgHygiene ?? base?.hygieneScore ?? 0),
        stain_presence: Math.round(avgStain ?? 0),
        water_stagnation: Math.round(avgWater ?? 0),
        garbage_presence: (avgGarbage ?? 0) > 50,
        overall_cleanliness_score: Math.round(overviewScore),
        confidence_score:
          avgConfidence !== null ? Number(Number(avgConfidence).toFixed(3)) : null,
        detected_issues: issueTags,
        severity_level: severityLevelFromRisk,
        human_review_required:
          Boolean(aggregate?.reviewRequired || base?.reviewRequired) || requiresRetakeAny,
        score_0_100: overviewScoreRounded,
        star_rating_0_5: Number((overviewScoreRounded / 20).toFixed(1)),
        hygiene_risk: aggregateRisk,
        cleanliness_level: null,
        critical_findings: aggregateCriticalFindings,
        requires_retake: requiresRetakeAny,
        sensor_impact: sensorImpact,
        environmental_score: environmentalScore,
        ppm_odor_tier: ppmOdorTier,
      },
      imageCount: effective.length,
      aggregate: aggregate || null,
      supervisorFlags,
      comparisonResult,
    },
  };
};

const runInspectionAnalysis = async ({
  inspectionId,
  submissionId = null,
  imageId = null,
  jobType = 'AI_ANALYSIS',
  queueJobId = null,
  req = null,
}) => {
  const startedAt = Date.now();
  const inspection = await Inspection.findByPk(inspectionId);
  if (!inspection) {
    return null;
  }
  // A missing/legacy tenant configuration must never block the inspection worker.
  const scoringTenant = await Tenant.findByPk(inspection.tenant_id, { attributes: ['id', 'ai_scoring_mode', 'metadata'] }).catch(() => null);
  const tenantAiScoringMode = resolveAiScoringMode(scoringTenant?.metadata?.aiScoringMode || scoringTenant?.ai_scoring_mode);
  const tenantFeatureFlags = resolveTenantFeatureFlags(scoringTenant);
  const explainableScoringV2Enabled = tenantFeatureFlags.explainableScoringV2;

  const processingJob = queueJobId
    ? await AiProcessingJob.findOne({
        where: {
          queue_name: 'inspection-analysis',
          queue_job_id: queueJobId,
        },
        order: [['created_at', 'DESC']],
      })
    : null;

  if (processingJob) {
    await processingJob.update({
      status: 'running',
      attempts: Number(processingJob.attempts || 0) + 1,
      image_id: imageId || processingJob.image_id || null,
      job_type: String(jobType || 'AI_ANALYSIS'),
      started_at: new Date(),
      leased_until: new Date(Date.now() + JOB_LEASE_MS),
      last_heartbeat_at: new Date(),
      failure_classification: null,
      dead_letter_reason: null,
      next_retry_at: null,
      updated_at: new Date(),
    });
  }

  if (submissionId) {
    const submission = await InspectionSubmission.findByPk(submissionId);
    if (submission) {
      await submission.update({
        status: 'processing',
        updated_at: new Date(),
      });
    }
  }

  await inspection.update({
    processing_status: 'processing',
    pipeline_status: 'processing',
    status: inspection.submitted_at ? 'SUBMITTED' : inspection.status || 'IN_PROGRESS',
    last_processing_error: null,
    updated_at: new Date(),
  });

  await InspectionEvent.create({
    tenant_id: inspection.tenant_id,
    inspection_id: inspection.id,
    toilet_id: inspection.toilet_unit_id || null,
    image_id: imageId || null,
    event_type: 'analysis.processing_started',
    event_status: 'processing',
    source: 'worker',
    payload: {
      type: String(jobType || 'AI_ANALYSIS'),
      imageId: imageId || null,
      queueJobId: queueJobId || null,
      submissionId: submissionId || null,
    },
    occurred_at: new Date(),
  });

  let mediaRows = await InspectionMedia.findAll({
    where: {
      inspection_id: inspection.id,
      ...(imageId ? { id: imageId } : {}),
    },
  });
  if (imageId && mediaRows.length === 0) {
    throw new AppError('Inspection image not found for AI analysis', 404, {
      code: 'IMAGE_NOT_FOUND',
    });
  }
  if (!imageId) {
    mediaRows = mediaRows.filter((row) =>
      ['before', 'after'].includes(String(row.capture_stage || '').toLowerCase())
    );
  }
  if (mediaRows.length === 0) {
    throw new AppError('No inspection evidence images found for analysis', 400, {
      code: 'NO_EVIDENCE_IMAGES',
    });
  }

  const analyzedImageIds = [];
  const imageResults = [];
  const imageFailures = [];
  const transientRetryImageIds = [];
  const configState = getOpenAiAnalysisConfigState();

  for (const mediaRow of mediaRows) {
    const forceReprocess = Boolean(req?.reprocess);
    const hasCurrentScoringVersion =
      String(mediaRow.scoring_version || '').trim() === String(SCORING_VERSION);
    if (
      !forceReprocess &&
      hasCurrentScoringVersion &&
      String(mediaRow.ai_status || '').toUpperCase() === 'AI_COMPLETED' &&
      mediaRow.overall_score !== null &&
      mediaRow.overall_score !== undefined &&
      !Boolean(mediaRow.scoring_rejected)
    ) {
      imageResults.push(buildCachedImageResultFromMediaRow(mediaRow));
      continue;
    }

    const mediaStartedAt = Date.now();
    analyzedImageIds.push(mediaRow.id);
    let qualityResult = null;
    let similarityResult = null;
    let perceptualHash = null;
    let visibilityScore = null;
    let toiletDetected = false;

    await mediaRow.update({
      ai_status: 'AI_PROCESSING',
      processing_state: IMAGE_PROCESSING_STATES.AI_PROCESSING,
      ai_attempt_count: Number(mediaRow.ai_attempt_count || 0) + 1,
      ai_error: null,
      validation_status: 'PENDING',
      validation_reason: null,
      last_error_code: null,
      last_error_message: null,
      updated_at: new Date(),
    });

    await InspectionEvent.create({
      tenant_id: inspection.tenant_id,
      inspection_id: inspection.id,
      toilet_id: mediaRow.toilet_unit_id || inspection.toilet_unit_id || null,
      image_id: mediaRow.id,
      event_type: 'analysis.image.processing_started',
      event_status: 'AI_PROCESSING',
      source: 'worker',
      payload: {
        imageId: mediaRow.id,
        stage: mediaRow.capture_stage,
      },
      occurred_at: new Date(),
    });

    try {
      if (!configState.ok) {
        const configError = new Error(configState.reason || 'AI provider not configured');
        configError.code = 'AI_PROVIDER_NOT_CONFIGURED';
        throw configError;
      }

      qualityResult = await validateInspectionMediaQuality(mediaRow);
      perceptualHash = await computePerceptualHash(mediaRow);
      const qualityValidationStatus = String(qualityResult.validationStatus || '').toUpperCase();
      if (qualityValidationStatus === 'FAILED_SOURCE') {
        const validationError = new Error(
          qualityResult.validationReason || 'Image validation failed'
        );
        validationError.code = 'IMAGE_VALIDATION_FAILED';
        validationError.validationStatus = qualityValidationStatus;
        throw validationError;
      }

      // A cached image score belongs to the source inspection's environment.
      // PPM is captured per inspection, so reusing a hash would apply the
      // wrong odor tier when the current inspection has a real PPM reading.
      const currentPpmTier = resolvePpmOdorTier(
        inspection.sensor_snapshot?.ppm ??
          inspection.sensor_snapshot?.field1 ??
          inspection.sensor_snapshot?.field_1
      );
      if (!forceReprocess && !currentPpmTier) {
        const reusableMedia = await findReusableScoredMediaByHash({
          mediaRow,
          inspection,
        });
        // Do not use a source image scored with another inspection's PPM.
        if (reusableMedia && !readAiScoringMetadata(reusableMedia)?.ppm_odor_tier) {
          const cachedResult = await reuseScoringFromMedia({
            targetMediaRow: mediaRow,
            sourceMediaRow: reusableMedia,
            inspection,
            qualityResult,
            perceptualHash,
            processingMs: Date.now() - mediaStartedAt,
          });
          const cachedPolicy = scoreInspectionFindings({
            mode: tenantAiScoringMode,
            baseScore: cachedResult.strictJson?.baseScore ?? cachedResult.result?.overallCleanlinessScore,
            strictJson: cachedResult.strictJson,
            fallbackIssues: cachedResult.result?.issueTags,
          });
          cachedResult.strictJson = {
            ...cachedResult.strictJson,
            overall_cleanliness_score: cachedPolicy.finalScore,
            score_0_100: cachedPolicy.finalScore,
            findings: cachedPolicy.findings,
            ai_scoring: cachedPolicy,
          };
          cachedResult.result.overallCleanlinessScore = cachedPolicy.finalScore;
          cachedResult.result.rawResult = { ...cachedResult.result.rawResult, strictJson: cachedResult.strictJson };
          await mediaRow.update({
            overall_score: cachedPolicy.finalScore,
            metadata: { ...(mediaRow.metadata || {}), ai_scoring: cachedPolicy },
            updated_at: new Date(),
          });
          imageResults.push(cachedResult);
          continue;
        }
      }

      const providerResult = await analyzeInspectionWithOpenAI({
        inspection,
        mediaRows: [mediaRow],
        // V2 keeps each image tied to its own evidence. Legacy analysis keeps
        // the existing inspection-wide snapshot for backward compatibility.
        sensorSnapshot: explainableScoringV2Enabled
          ? (mediaRow.sensor_evidence?.nearestSample
              ? {
                  ...mediaRow.sensor_evidence.nearestSample,
                  readingTime: mediaRow.sensor_evidence.nearestSample.sensorMeasuredAt || mediaRow.sensor_evidence.nearestSample.sensorReceivedAt || null,
                  sensorStatus: mediaRow.sensor_evidence?.validation?.status || null,
                }
              : null)
          : inspection.sensor_snapshot || null,
        singleStructuredPass: explainableScoringV2Enabled,
        usageContext: {
          tenantId: inspection.tenant_id || req?.user?.tenantId || null,
          userId: req?.user?.id || null,
          workerId: mediaRow.worker_id || inspection.inspector_user_id || null,
          toiletId: mediaRow.toilet_unit_id || inspection.toilet_unit_id || null,
          userRole: Array.isArray(req?.user?.roleCodes) ? req.user.roleCodes[0] : null,
          source: 'worker_mobile_app',
        },
      });
      const processingMs = Date.now() - mediaStartedAt;
      const result = normalizeResultFromProvider({
        providerResult,
        processingMs,
      });
      const strictJson = result.rawResult?.strictJson || null;
      const inspectionSensorContext = parseSensorContext(inspection.sensor_snapshot || null);
      const localSensorFusion = computeSensorImpact(inspectionSensorContext);
      const modelSensorImpact = Number.isFinite(Number(result.sensorImpact)) ? Number(result.sensorImpact) : 0;
      // The model may still contribute non-PPM environmental evidence, but
      // PPM itself is server-enforced from the documented odor policy. Keeping
      // it separate prevents a model response from double-counting PPM.
      const appliedNonPpmSensorImpact = Math.min(
        0,
        Math.max(modelSensorImpact, localSensorFusion.nonPpmSensorImpact)
      );
      const appliedSensorImpact = clamp(
        appliedNonPpmSensorImpact + localSensorFusion.ppmImpact,
        -25,
        20
      );
      if (!strictJson || typeof strictJson !== 'object') {
        const parsingError = new Error('Scoring response is missing strict JSON payload');
        parsingError.code = 'SCORING_PARSE_FAILED';
        throw parsingError;
      }
      const detection = result.rawResult?.detection || {};
      toiletDetected = Boolean(detection.toilet_detected);
      visibilityScore =
        detection.visibility_score !== null && detection.visibility_score !== undefined
          ? Number(detection.visibility_score)
          : null;

      const normalizedIssues = normalizeIssueTags({
        aiIssues: Array.isArray(strictJson?.detected_issues) ? strictJson.detected_issues : [],
        floorCleanliness: strictJson.floor_cleanliness,
        commodeCleanliness: strictJson.commode_urinal_cleanliness,
        stainPresence: strictJson.stain_presence,
        waterStagnation: strictJson.water_stagnation,
        garbagePresence: strictJson.garbage_presence,
        confidenceScore: strictJson.confidence_score,
      });
      const confidenceEngine = computeConfidence({
        aiConfidence: strictJson.confidence_score,
        blurPenalty: qualityResult?.blurPenalty || 0,
        lightingPenalty: qualityResult?.lightingPenalty || 0,
        visibilityScore,
      });
      const confidence = Number(confidenceEngine.finalConfidence || 0);
      const lowConfidenceReview = Boolean(confidenceEngine.rejected);
      const issues = Array.isArray(strictJson?.detected_issues)
        ? normalizedIssues
        : Array.isArray(result.issueTags)
          ? normalizeIssueTags({ aiIssues: result.issueTags })
          : [];
      const calibratedOverallScore = calibrateOverallScore({
        strictJson,
        normalizedIssues: issues,
        confidence,
      });
      const quality = qualityResult?.imageQualityStatus || 'ok';
      const inferredCriticalFindings = inferCriticalFindingsFromStrictJson(strictJson, issues);
      const singleImagePost = applySingleImagePostProcessing({
        score_0_100: calibratedOverallScore,
        star_rating_0_5: strictJson?.star_rating_0_5,
        cleanliness_level: strictJson?.cleanliness_level || null,
        hygiene_risk: strictJson?.hygiene_risk || null,
        critical_findings: strictJson?.critical_findings || inferredCriticalFindings,
        detected_issues: issues,
        positive_observations: Array.isArray(strictJson?.positive_observations)
          ? strictJson.positive_observations
          : [],
        score_reason:
          strictJson?.score_reason ||
          strictJson?.reasoning_summary ||
          strictJson?.explanation_summary ||
          result.explanationText ||
          '',
        confidence,
        requires_retake: Boolean(strictJson?.requires_retake),
        retake_reason: strictJson?.retake_reason || '',
        toilet_detected: toiletDetected,
        visibility_score: visibilityScore,
        image_quality_status: quality,
      });
      const visualScore = Number(singleImagePost.score_0_100 || 0);
      let overallScore = clamp(visualScore + appliedSensorImpact, 0, 100);
      let appliedScoringPolicy = scoreInspectionFindings({
        mode: tenantAiScoringMode,
        baseScore: overallScore,
        strictJson: { ...strictJson, ...singleImagePost, detected_issues: issues },
        fallbackIssues: issues,
      });
      overallScore = appliedScoringPolicy.finalScore;
      let presentation = singleImagePost;
      let v2Scoring = null;
      if (explainableScoringV2Enabled) {
        v2Scoring = scoreExplainableInspection({
          mode: tenantAiScoringMode,
          findings: Array.isArray(strictJson.findings) && strictJson.findings.length > 0
            ? strictJson.findings
            : issues.map((issue) => ({ issue, severity: strictJson.severity_level, confidence: strictJson.confidence_score })),
          sensorEvidence: mediaRow.sensor_evidence || null,
        });
        overallScore = v2Scoring.score;
        appliedScoringPolicy = {
          mode: v2Scoring.mode,
          policyVersion: v2Scoring.scoringFormulaVersion,
          baseScore: v2Scoring.components.visualHygiene.score,
          finalScore: v2Scoring.score,
          totalPenalty: round2(100 - v2Scoring.components.visualHygiene.score),
          severityCounts: {},
          findings: v2Scoring.findings,
          capsApplied: v2Scoring.capsApplied,
          explainable: v2Scoring,
        };
        presentation = {
          ...singleImagePost,
          score_0_100: v2Scoring.score,
          star_rating_0_5: Number((v2Scoring.score / 20).toFixed(1)),
          hygiene_risk: String(v2Scoring.hygieneRisk || 'MEDIUM').toLowerCase(),
          cleanliness_level: String(v2Scoring.band || 'FAIR').toLowerCase(),
          caps_applied: v2Scoring.capsApplied.map((item) => item.reason),
          score_reason: v2Scoring.reasons.map((item) => item.explanation).filter(Boolean).join(' '),
        };
      }
      const finalConfidence = Number(presentation.confidence || confidence || 0);
      const floorScore =
        strictJson && strictJson.floor_cleanliness !== undefined
          ? Number(strictJson.floor_cleanliness)
          : Number(result.cleanlinessScore || 0);
      const commodeScore =
        strictJson && strictJson.commode_urinal_cleanliness !== undefined
          ? Number(strictJson.commode_urinal_cleanliness)
          : Number(result.hygieneScore || 0);
      const stainScore =
        strictJson && strictJson.stain_presence !== undefined
          ? Number(strictJson.stain_presence)
          : 100 - Number(result.stainScore || 0);
      const waterScore =
        strictJson && strictJson.water_stagnation !== undefined
          ? Number(strictJson.water_stagnation)
          : 100 - Number(result.wetnessScore || 0);
      const garbageScore = toGarbageScore(strictJson, result);
      let reviewRequired =
        (strictJson && strictJson.human_review_required !== undefined
          ? Boolean(strictJson.human_review_required)
          : Boolean(result.reviewRequired)) || confidenceEngine.reviewRequired;
      similarityResult = await compareAgainstBeforeHashes({
        inspectionId: inspection.id,
        captureStage: mediaRow.capture_stage,
        perceptualHash,
        imageId: mediaRow.id,
      });
      reviewRequired =
        reviewRequired ||
        presentation.requires_retake ||
        ['high', 'severe'].includes(String(presentation.hygiene_risk || '').toLowerCase()) ||
        Boolean(similarityResult?.suspicious);
      const severity =
        severityFromHygieneRisk(presentation.hygiene_risk) ||
        strictJson?.severity_level ||
        (String(result.severityLabel || '').toLowerCase() === 'critical'
          ? 'high'
          : String(result.severityLabel || '').toLowerCase() || null) ||
        'medium';
      const suspiciousFlags = [];
      if (similarityResult?.suspicious) {
        suspiciousFlags.push('possible_fake_cleaning_similar_images');
      }
      if (confidenceEngine.reviewRequired) {
        suspiciousFlags.push('low_confidence');
      }
      if (presentation.requires_retake) {
        suspiciousFlags.push('retake_required');
      }
      const qualityWarning = qualityValidationStatus !== 'VALID';
      const resolvedValidationStatus = presentation.requires_retake
        ? 'RETAKE_REQUIRED'
        : lowConfidenceReview
          ? qualityWarning
            ? 'LOW_CONFIDENCE_QUALITY_WARNING'
            : 'LOW_CONFIDENCE_REVIEW'
          : qualityWarning
            ? 'QUALITY_WARNING'
            : 'VALID';
      const validationReasons = [];
      if (qualityWarning) {
        validationReasons.push(
          qualityResult?.validationReason || 'Image quality warning detected'
        );
      }
      if (lowConfidenceReview) {
        validationReasons.push('Confidence below review threshold');
      }
      if (presentation.requires_retake && presentation.retake_reason) {
        validationReasons.push(presentation.retake_reason);
      }
      const resolvedValidationReason =
        validationReasons.length > 0 ? validationReasons.join(' | ').slice(0, 500) : null;
      const supervisorFlags = buildSupervisorReviewFlags({
        singleImageResult: presentation,
        pairwiseComparison: null,
        afterScore: overallScore,
      });
      const strictJsonFinal = {
        ...strictJson,
        ...presentation,
        overall_cleanliness_score: overallScore,
        score_0_100: overallScore,
        star_rating_0_5: Number((overallScore / 20).toFixed(1)),
        visual_score: visualScore,
        environmental_score: v2Scoring ? v2Scoring.components.environmental.score : clamp(100 + appliedSensorImpact, 0, 100),
        sensor_impact: v2Scoring ? 0 : appliedSensorImpact,
        sensor_context: v2Scoring ? v2Scoring.sensor.evidence : inspectionSensorContext,
        sensor_reasons:
          v2Scoring ? v2Scoring.sensor.reasons : (localSensorFusion.reasons.length > 0 ? localSensorFusion.reasons : undefined),
        ppm_odor_tier: v2Scoring ? undefined : localSensorFusion.ppmOdorTier || undefined,
        confidence_score: finalConfidence,
        critical_findings: presentation.critical_findings,
        detected_issues: issues,
        severity_level: severity,
        human_review_required: reviewRequired,
        findings: appliedScoringPolicy.findings,
        ai_scoring: appliedScoringPolicy,
        explanation_summary:
          presentation.score_reason ||
          strictJson?.explanation_summary ||
          result.explanationText ||
          null,
      };
      const existingMetadata =
        mediaRow.metadata && typeof mediaRow.metadata === 'object' && !Array.isArray(mediaRow.metadata)
          ? mediaRow.metadata
          : {};
      const scoringMetadata = {
        ...presentation,
        ...appliedScoringPolicy,
        applied_at: new Date().toISOString(),
        prompt_version: result.promptVersion || PROMPT_VERSION,
        scoring_version: result.scoringVersion || SCORING_VERSION,
        tenant_scoring_policy_version: v2Scoring ? EXPLAINABLE_SCORING_V2_VERSION : AI_SCORING_POLICY_VERSION,
        tenant_scoring_mode: appliedScoringPolicy.mode,
        ppm_odor_tier: v2Scoring ? null : localSensorFusion.ppmOdorTier || null,
        explainable_scoring_v2: v2Scoring,
        supervisor_flags: supervisorFlags,
      };
      const metadata = {
        ...existingMetadata,
        ai_scoring: scoringMetadata,
        ai_supervisor_flags: supervisorFlags,
      };

      await mediaRow.update({
        ai_status: 'AI_COMPLETED',
        processing_state: IMAGE_PROCESSING_STATES.AI_COMPLETED,
        image_quality_status: quality,
        overall_score: round2(overallScore),
        confidence_score: round2(finalConfidence),
        floor_score: round2(floorScore),
        commode_score: round2(commodeScore),
        stain_score: round2(stainScore),
        garbage_score: round2(garbageScore),
        water_score: round2(waterScore),
        issue_tags: issues,
        issue_summary:
          issues.length > 0
            ? issues.slice(0, 6).join(', ')
            : strictJsonFinal.explanation_summary || null,
        severity,
        review_required:
          reviewRequired ||
          quality !== 'ok' ||
          Boolean(similarityResult?.suspicious) ||
          lowConfidenceReview ||
          presentation.requires_retake,
        model_version: result.modelVersion || null,
        prompt_version: result.promptVersion || PROMPT_VERSION,
        scoring_version: result.scoringVersion || SCORING_VERSION,
        ai_processed_at: new Date(),
        ai_error: null,
        last_error_code: null,
        last_error_message: null,
        next_retry_at: null,
        image_quality_score: qualityResult?.imageQualityScore || null,
        toilet_detected: toiletDetected,
        validation_status: resolvedValidationStatus,
        validation_reason: resolvedValidationReason,
        visibility_score: visibilityScore,
        perceptual_hash: perceptualHash || null,
        similarity_score: similarityResult?.maxSimilarity || null,
        scoring_rejected: false,
        explanation_summary:
          strictJsonFinal.explanation_summary ||
          result.explanationText ||
          (issues.length > 0 ? issues.join(', ') : null),
        metadata,
        updated_at: new Date(),
      });

      result.overallCleanlinessScore = round2(overallScore);
      result.visualScore = round2(visualScore);
      result.sensorImpact = appliedSensorImpact;
      result.environmentalScore = strictJsonFinal.environmental_score ?? null;
      result.confidenceScore = round2(finalConfidence);
      result.reviewRequired = Boolean(reviewRequired);
      result.issueTags = issues;
      result.severityLabel = severity;
      result.explanationText =
        strictJsonFinal.explanation_summary || result.explanationText || null;
      if (!result.rawResult || typeof result.rawResult !== 'object') {
        result.rawResult = {};
      }
      result.rawResult.strictJson = strictJsonFinal;

      // eslint-disable-next-line no-console
      console.info(
        '[ai-scoring] image-final',
        JSON.stringify({
          inspectionId: inspection.id,
          imageId: mediaRow.id,
          captureStage: mediaRow.capture_stage,
          rawScore: round2(calibratedOverallScore),
          finalScore: round2(overallScore),
          scoringMode: appliedScoringPolicy.mode,
          policyVersion: appliedScoringPolicy.policyVersion,
          stars: presentation.star_rating_0_5,
          hygieneRisk: presentation.hygiene_risk,
          capsApplied: presentation.caps_applied,
          confidence: round2(finalConfidence),
          requiresRetake: Boolean(presentation.requires_retake),
          suspiciousSimilarity: Boolean(similarityResult?.suspicious),
          supervisorFlags,
        })
      );

      imageResults.push({
        imageId: mediaRow.id,
        strictJson: strictJsonFinal,
        result,
        scoringRejected: false,
      });

      await InspectionEvent.create({
        tenant_id: inspection.tenant_id,
        inspection_id: inspection.id,
        toilet_id: mediaRow.toilet_unit_id || inspection.toilet_unit_id || null,
        image_id: mediaRow.id,
        event_type: 'analysis.image.completed',
        event_status: 'AI_COMPLETED',
        source: 'worker',
        payload: {
          imageId: mediaRow.id,
          stage: mediaRow.capture_stage,
          score: round2(overallScore),
          confidence: round2(finalConfidence),
          severity,
          reviewRequired:
            reviewRequired ||
            quality !== 'ok' ||
            Boolean(similarityResult?.suspicious) ||
            lowConfidenceReview ||
            presentation.requires_retake,
          suspiciousFlags,
          validationStatus: resolvedValidationStatus,
          scoringRejected: false,
          lowConfidenceReview,
          requiresRetake: Boolean(presentation.requires_retake),
          retakeReason: presentation.retake_reason || null,
          hygieneRisk: presentation.hygiene_risk,
          starRating: presentation.star_rating_0_5,
          similarityScore: similarityResult?.maxSimilarity || null,
          processingMs,
        },
        occurred_at: new Date(),
      });
    } catch (imageError) {
      const code = String(imageError?.code || '').trim();
      const failure = classifyAnalysisFailure(imageError);
      const retryCount = Number(mediaRow.retry_count || 0);
      const canRetry = failure.retryable && retryCount < AI_IMAGE_MAX_RETRIES;

      if (ALWAYS_SCORE_ON_FAILURE) {
        const fallbackStrictJson = buildFallbackStrictJson({
          captureStage: mediaRow.capture_stage,
          qualityResult,
          failure,
        });
        const normalizedFallbackIssues = normalizeIssueTags({
          aiIssues: fallbackStrictJson.detected_issues,
          floorCleanliness: fallbackStrictJson.floor_cleanliness,
          commodeCleanliness: fallbackStrictJson.commode_urinal_cleanliness,
          stainPresence: fallbackStrictJson.stain_presence,
          waterStagnation: fallbackStrictJson.water_stagnation,
          garbagePresence: fallbackStrictJson.garbage_presence,
          confidenceScore: fallbackStrictJson.confidence_score,
        });
        const fallbackIssues = Array.from(
          new Set([...normalizedFallbackIssues, 'ai_fallback_scoring'])
        );
        const fallbackConfidenceEngine = computeConfidence({
          aiConfidence: fallbackStrictJson.confidence_score,
          blurPenalty: qualityResult?.blurPenalty || 0,
          lightingPenalty: qualityResult?.lightingPenalty || 0,
          visibilityScore,
        });
        const fallbackConfidence = Number(
          fallbackConfidenceEngine.finalConfidence || fallbackStrictJson.confidence_score || 0
        );
        const fallbackCalibratedScore = calibrateOverallScore({
          strictJson: fallbackStrictJson,
          normalizedIssues: fallbackIssues,
          confidence: fallbackConfidence,
        });
        const fallbackSinglePost = applySingleImagePostProcessing({
          score_0_100: fallbackCalibratedScore,
          star_rating_0_5: fallbackStrictJson.star_rating_0_5,
          cleanliness_level: fallbackStrictJson.cleanliness_level || null,
          hygiene_risk: fallbackStrictJson.hygiene_risk || null,
          critical_findings:
            fallbackStrictJson.critical_findings ||
            inferCriticalFindingsFromStrictJson(fallbackStrictJson, fallbackIssues),
          detected_issues: fallbackIssues,
          positive_observations: Array.isArray(fallbackStrictJson.positive_observations)
            ? fallbackStrictJson.positive_observations
            : [],
          score_reason: fallbackStrictJson.explanation_summary || fallbackStrictJson.score_reason || '',
          confidence: fallbackConfidence,
          requires_retake: Boolean(fallbackStrictJson.requires_retake),
          retake_reason: fallbackStrictJson.retake_reason || '',
          toilet_detected: Boolean(toiletDetected),
          visibility_score: visibilityScore,
          image_quality_status: qualityResult?.imageQualityStatus || 'unknown',
        });
        const fallbackVisualScore = Number(fallbackSinglePost.score_0_100 || 0);
        const fallbackSensorContext = parseSensorContext(inspection.sensor_snapshot || null);
        const fallbackSensorFusion = computeSensorImpact(fallbackSensorContext);
        const fallbackFinalScore = clamp(
          fallbackVisualScore + fallbackSensorFusion.sensorImpact,
          0,
          100
        );
        const fallbackFinalConfidence = Number(fallbackSinglePost.confidence || fallbackConfidence);
        const fallbackSeverity =
          severityFromHygieneRisk(fallbackSinglePost.hygiene_risk) ||
          fallbackStrictJson.severity_level ||
          'high';
        const fallbackStrictWithCalibrated = {
          ...fallbackStrictJson,
          ...fallbackSinglePost,
          overall_cleanliness_score: Math.round(fallbackFinalScore),
          score_0_100: Math.round(fallbackFinalScore),
          star_rating_0_5: Number((fallbackFinalScore / 20).toFixed(1)),
          visual_score: fallbackVisualScore,
          environmental_score: fallbackSensorFusion.environmentalScore,
          sensor_impact: fallbackSensorFusion.sensorImpact,
          sensor_context: fallbackSensorContext,
          sensor_reasons:
            fallbackSensorFusion.reasons.length > 0 ? fallbackSensorFusion.reasons : undefined,
          ppm_odor_tier: fallbackSensorFusion.ppmOdorTier || undefined,
          confidence_score: Number(fallbackFinalConfidence.toFixed(4)),
          detected_issues: fallbackIssues,
          severity_level: fallbackSeverity,
          human_review_required: true,
          explanation_summary:
            fallbackSinglePost.score_reason || fallbackStrictJson.explanation_summary || null,
        };
        const fallbackFloorScore = Number(
          fallbackStrictWithCalibrated.floor_cleanliness || 0
        );
        const fallbackCommodeScore = Number(
          fallbackStrictWithCalibrated.commode_urinal_cleanliness || 0
        );
        const fallbackStainScore = Number(
          fallbackStrictWithCalibrated.stain_presence || 0
        );
        const fallbackWaterScore = Number(
          fallbackStrictWithCalibrated.water_stagnation || 0
        );
        const fallbackGarbageScore = fallbackStrictWithCalibrated.garbage_presence
          ? 100
          : 0;
        const fallbackOdorRiskScore = clamp(
          Math.round(
            fallbackStainScore * 0.45 +
              fallbackWaterScore * 0.4 +
              (fallbackStrictWithCalibrated.garbage_presence ? 15 : 0)
          ),
          0,
          100
        );
        const fallbackSupervisorFlags = buildSupervisorReviewFlags({
          singleImageResult: fallbackSinglePost,
          pairwiseComparison: null,
          afterScore: fallbackFinalScore,
        });
        const fallbackValidationReason = `Fallback scoring applied due to ${
          failure.errorCode || code || 'analysis_error'
        }: ${failure.message || 'Unknown failure'}${
          fallbackSinglePost.retake_reason ? ` | ${fallbackSinglePost.retake_reason}` : ''
        }`.slice(0, 500);

        await mediaRow.update({
          ai_status: 'AI_COMPLETED',
          processing_state: IMAGE_PROCESSING_STATES.AI_COMPLETED,
          image_quality_status: qualityResult?.imageQualityStatus || 'unknown',
          overall_score: round2(fallbackFinalScore),
          confidence_score: round2(fallbackFinalConfidence),
          floor_score: round2(fallbackFloorScore),
          commode_score: round2(fallbackCommodeScore),
          stain_score: round2(fallbackStainScore),
          garbage_score: round2(fallbackGarbageScore),
          water_score: round2(fallbackWaterScore),
          issue_tags: fallbackIssues,
          issue_summary:
            fallbackIssues.length > 0 ? fallbackIssues.slice(0, 6).join(', ') : null,
          severity: fallbackSeverity,
          review_required: true,
          model_version: 'fallback-v1',
          prompt_version: PROMPT_VERSION,
          scoring_version: SCORING_VERSION,
          ai_processed_at: new Date(),
          ai_error: failure.message.slice(0, 2000),
          last_error_code: failure.errorCode || code || null,
          last_error_message: failure.message.slice(0, 2000),
          next_retry_at: null,
          image_quality_score: qualityResult?.imageQualityScore || null,
          toilet_detected: Boolean(toiletDetected),
          validation_status: fallbackSinglePost.requires_retake
            ? 'RETAKE_REQUIRED'
            : 'FALLBACK_SCORED',
          validation_reason: fallbackValidationReason,
          visibility_score: visibilityScore,
          perceptual_hash: perceptualHash || null,
          similarity_score: similarityResult?.maxSimilarity || null,
          scoring_rejected: false,
          explanation_summary:
            fallbackStrictWithCalibrated.explanation_summary || fallbackValidationReason,
          metadata: {
            ...(mediaRow.metadata && typeof mediaRow.metadata === 'object' && !Array.isArray(mediaRow.metadata)
              ? mediaRow.metadata
              : {}),
            ai_scoring: {
              ...fallbackSinglePost,
              ppm_odor_tier: fallbackSensorFusion.ppmOdorTier || null,
              applied_at: new Date().toISOString(),
              prompt_version: PROMPT_VERSION,
              scoring_version: SCORING_VERSION,
              supervisor_flags: fallbackSupervisorFlags,
            },
            ai_supervisor_flags: fallbackSupervisorFlags,
          },
          updated_at: new Date(),
        });

        const fallbackResult = {
          overallCleanlinessScore: round2(fallbackFinalScore),
          cleanlinessScore: round2(fallbackFloorScore),
          hygieneScore: round2(fallbackCommodeScore),
          odorRiskScore: round2(fallbackOdorRiskScore),
          wetnessScore: round2(clamp(100 - fallbackWaterScore, 0, 100)),
          stainScore: round2(clamp(100 - fallbackStainScore, 0, 100)),
          litterScore: fallbackGarbageScore > 50 ? 0 : 100,
          confidenceScore: round2(fallbackFinalConfidence),
          issueTags: fallbackIssues,
          severityLabel: fallbackSeverity,
          reviewRequired: true,
          explanationText:
            fallbackStrictWithCalibrated.explanation_summary || fallbackValidationReason,
          modelName: runtimeConfig.analysis.openaiModel || 'gpt-4o-mini',
          modelVersion: 'fallback-v1',
          provider: 'fallback',
          promptVersion: PROMPT_VERSION,
          scoringVersion: SCORING_VERSION,
          sensorImpact: fallbackSensorFusion.sensorImpact,
          environmentalScore: fallbackSensorFusion.environmentalScore,
          rawResult: {
            strictJson: fallbackStrictWithCalibrated,
            fallback: true,
            failure: {
              errorCode: failure.errorCode || code || null,
              message: failure.message.slice(0, 500),
              classification: failure.classification || null,
            },
          },
        };

        imageResults.push({
          imageId: mediaRow.id,
          strictJson: fallbackStrictWithCalibrated,
          result: fallbackResult,
          scoringRejected: false,
        });

        // eslint-disable-next-line no-console
        console.info(
          '[ai-scoring] image-fallback',
          JSON.stringify({
            inspectionId: inspection.id,
            imageId: mediaRow.id,
            captureStage: mediaRow.capture_stage,
            rawScore: round2(fallbackCalibratedScore),
            finalScore: round2(fallbackFinalScore),
            stars: fallbackSinglePost.star_rating_0_5,
            hygieneRisk: fallbackSinglePost.hygiene_risk,
            capsApplied: fallbackSinglePost.caps_applied,
            confidence: round2(fallbackFinalConfidence),
            requiresRetake: Boolean(fallbackSinglePost.requires_retake),
            supervisorFlags: fallbackSupervisorFlags,
            errorCode: failure.errorCode || code || null,
          })
        );

        await InspectionEvent.create({
          tenant_id: inspection.tenant_id,
          inspection_id: inspection.id,
          toilet_id: mediaRow.toilet_unit_id || inspection.toilet_unit_id || null,
          image_id: mediaRow.id,
          event_type: 'analysis.image.completed',
          event_status: 'AI_COMPLETED',
          source: 'worker',
          payload: {
            imageId: mediaRow.id,
            stage: mediaRow.capture_stage,
            score: round2(fallbackFinalScore),
            confidence: round2(fallbackFinalConfidence),
            severity: fallbackSeverity,
            reviewRequired: true,
            validationStatus: fallbackSinglePost.requires_retake
              ? 'RETAKE_REQUIRED'
              : 'FALLBACK_SCORED',
            scoringRejected: false,
            fallbackScored: true,
            requiresRetake: Boolean(fallbackSinglePost.requires_retake),
            retakeReason: fallbackSinglePost.retake_reason || null,
            hygieneRisk: fallbackSinglePost.hygiene_risk,
            starRating: fallbackSinglePost.star_rating_0_5,
            supervisorFlags: fallbackSupervisorFlags,
            errorCode: failure.errorCode || code || null,
            processingMs: Date.now() - mediaStartedAt,
          },
          occurred_at: new Date(),
        });

        continue;
      }

      if (canRetry) {
        const nextRetryCount = retryCount + 1;
        const delayMs = Math.min(
          AI_RETRY_BASE_DELAY_MS * Math.pow(2, retryCount),
          120000
        );
        const nextRetryAt = new Date(Date.now() + delayMs);

        await mediaRow.update({
          ai_status: 'AI_QUEUED',
          processing_state: IMAGE_PROCESSING_STATES.AI_RETRYING,
          retry_count: nextRetryCount,
          last_retry_at: new Date(),
          next_retry_at: nextRetryAt,
          validation_status: 'PENDING',
          validation_reason: `AI transient error, retry scheduled (attempt ${nextRetryCount}/${AI_IMAGE_MAX_RETRIES})`,
          image_quality_status: qualityResult?.imageQualityStatus || 'unknown',
          image_quality_score: qualityResult?.imageQualityScore || null,
          toilet_detected: Boolean(toiletDetected),
          visibility_score: visibilityScore,
          perceptual_hash: perceptualHash || null,
          similarity_score: similarityResult?.maxSimilarity || null,
          review_required: false,
          ai_error: failure.message,
          last_error_code: failure.errorCode || null,
          last_error_message: failure.message,
          updated_at: new Date(),
        });

        const { enqueueInspectionAnalysis } = require('./analysis.queue');
        await enqueueInspectionAnalysis({
          inspectionId: inspection.id,
          imageId: mediaRow.id,
          tenantId: inspection.tenant_id,
          jobType: String(jobType || 'AI_ANALYSIS'),
          delayMs,
          requestContext: {
            requestId: req?.requestId || null,
            reprocess: true,
            reprocessToken: `retry-${mediaRow.id}-${nextRetryCount}`,
            user: req?.user || null,
          },
        });

        await InspectionEvent.create({
          tenant_id: inspection.tenant_id,
          inspection_id: inspection.id,
          toilet_id: mediaRow.toilet_unit_id || inspection.toilet_unit_id || null,
          image_id: mediaRow.id,
          event_type: 'analysis.image.retrying',
          event_status: 'AI_RETRYING',
          source: 'worker',
          payload: {
            imageId: mediaRow.id,
            attempt: nextRetryCount,
            maxAttempts: AI_IMAGE_MAX_RETRIES,
            nextRetryAt: nextRetryAt.toISOString(),
            delayMs,
            errorCode: failure.errorCode || null,
            error: failure.message.slice(0, 400),
          },
          occurred_at: new Date(),
        });

        transientRetryImageIds.push(mediaRow.id);
        continue;
      }

      const validationStatus = code === 'NO_TOILET_DETECTED'
        ? 'FAILED_NO_TOILET'
        : code === 'LOW_VISIBILITY'
          ? 'FAILED_VISIBILITY'
          : code === 'OPENAI_DETECTION_PARSE_FAILED' || code === 'OPENAI_SCORING_PARSE_FAILED'
            ? 'FAILED_SOURCE'
            : String(imageError?.validationStatus || '').trim() || 'FAILED_SOURCE';

      imageFailures.push({
        imageId: mediaRow.id,
        error: failure.message.slice(0, 500),
      });
      await mediaRow.update({
        ai_status: 'AI_FAILED',
        processing_state:
          failure.classification === 'transient'
            ? IMAGE_PROCESSING_STATES.AI_FAILED_TRANSIENT
            : IMAGE_PROCESSING_STATES.MANUAL_REVIEW_REQUIRED,
        validation_status: validationStatus,
        validation_reason: failure.message.slice(0, 500),
        image_quality_status: qualityResult?.imageQualityStatus || 'invalid',
        image_quality_score: qualityResult?.imageQualityScore || null,
        toilet_detected: Boolean(toiletDetected),
        visibility_score: visibilityScore,
        perceptual_hash: perceptualHash || null,
        similarity_score: similarityResult?.maxSimilarity || null,
        review_required: true,
        manual_review_required_at: new Date(),
        ai_error: failure.message.slice(0, 2000),
        last_error_code: failure.errorCode || null,
        last_error_message: failure.message.slice(0, 2000),
        next_retry_at: null,
        updated_at: new Date(),
      });
      await InspectionEvent.create({
        tenant_id: inspection.tenant_id,
        inspection_id: inspection.id,
        toilet_id: mediaRow.toilet_unit_id || inspection.toilet_unit_id || null,
        image_id: mediaRow.id,
        event_type: 'analysis.image.failed',
        event_status: 'AI_FAILED',
        source: 'worker',
        payload: {
          imageId: mediaRow.id,
          error: failure.message.slice(0, 1000),
          errorCode: failure.errorCode || null,
          failureClassification: failure.classification,
          validationStatus,
        },
        occurred_at: new Date(),
      });
    }
  }

  const failedImageIds = imageFailures.map((item) => item.imageId);
  const failureMessage =
    imageFailures.length > 0
      ? imageFailures
          .map((item) => `${item.imageId}: ${item.error}`)
          .join(' | ')
          .slice(0, 2000)
      : transientRetryImageIds.length > 0
        ? `Transient retries queued for images: ${transientRetryImageIds.join(', ')}`
        : 'AI analysis could not process any inspection images';
  const processingMs = Date.now() - startedAt;
  const processedAt = new Date();

  if (imageResults.length === 0) {
    const onlyTransientRetries =
      transientRetryImageIds.length > 0 && imageFailures.length === 0;
    const aggregate = await recomputeInspectionAggregates(inspection.id, {
      updateToilet: true,
    });
    const refreshedInspection = await Inspection.findByPk(inspection.id);
    const pipelineStatus =
      refreshedInspection?.pipeline_status ||
      aggregate?.pipelineStatus ||
      'needs_review';
    const processingStatus =
      refreshedInspection?.processing_status ||
      aggregate?.processingStatus ||
      'completed';
    const overallStatus =
      refreshedInspection?.overall_status || inspection.overall_status || null;

    await inspection.update({
      processing_status: onlyTransientRetries ? 'queued' : processingStatus,
      pipeline_status: onlyTransientRetries ? 'queued_for_ai' : pipelineStatus,
      submitted_at: inspection.submitted_at || (submissionId ? processedAt : null),
      review_required: onlyTransientRetries ? false : true,
      last_processing_error: onlyTransientRetries ? null : failureMessage,
      updated_at: processedAt,
    });

    if (submissionId) {
      const submission = await InspectionSubmission.findByPk(submissionId);
      if (submission) {
        await submission.update({
          status:
            refreshedInspection?.status ||
            aggregate?.status ||
            pipelineStatus,
          updated_at: new Date(),
        });
      }
    }

    if (processingJob) {
      await processingJob.update({
        status: onlyTransientRetries ? 'queued' : 'succeeded',
        completed_at: processedAt,
        duration_ms: processingMs,
        image_id: imageId || processingJob.image_id || null,
        job_type: String(jobType || 'AI_ANALYSIS'),
        last_error: onlyTransientRetries ? null : failureMessage,
        leased_until: null,
        last_heartbeat_at: new Date(),
        failure_classification: onlyTransientRetries ? 'transient' : 'permanent',
        result: {
          analysisId: null,
          type: String(jobType || 'AI_ANALYSIS'),
          imageId: imageId || null,
          analyzedImageIds,
          failedImageIds,
          transientRetryImageIds,
          pipelineStatus,
          overallStatus,
          confidenceScore: null,
          inspectionStatus: refreshedInspection?.status || aggregate?.status || null,
        },
        updated_at: new Date(),
      });
    }

    await InspectionEvent.create({
      tenant_id: inspection.tenant_id,
      inspection_id: inspection.id,
      toilet_id: inspection.toilet_unit_id || null,
      image_id: imageId || null,
      event_type: 'analysis.completed',
      event_status: onlyTransientRetries ? 'queued_for_ai' : pipelineStatus,
      source: 'worker',
      payload: {
        analysisId: null,
        type: String(jobType || 'AI_ANALYSIS'),
        imageId: imageId || null,
        analyzedImageIds,
        failedImageIds,
        transientRetryImageIds,
        queueJobId: queueJobId || null,
        submissionId: submissionId || null,
        confidenceScore: null,
        reviewRequired: onlyTransientRetries ? false : true,
        severityLabel: null,
        processingMs,
        aggregate,
      },
      occurred_at: new Date(),
    });

    eventBus.emit(EVENTS.INSPECTION_UPDATED, {
      inspectionId: inspection.id,
      tenantId: inspection.tenant_id,
      processingStatus,
      pipelineStatus: onlyTransientRetries ? 'queued_for_ai' : pipelineStatus,
      overallStatus,
      reviewRequired: onlyTransientRetries ? false : true,
      inspectionStatus: refreshedInspection?.status || aggregate?.status || null,
    });

    await createAuditLog({
      req,
      actorUserId: req?.user?.id || inspection.inspector_user_id,
      tenantId: inspection.tenant_id,
      action: 'analysis.inspection_run',
      entityType: 'inspection',
      entityId: inspection.id,
      details: {
        analysisId: null,
        type: String(jobType || 'AI_ANALYSIS'),
        imageId: imageId || null,
        analyzedImageIds,
        failedImageIds,
        overallStatus,
        confidenceScore: null,
        reviewRequired: true,
        inspectionStatus: refreshedInspection?.status || aggregate?.status || null,
        processingMs,
      },
    });

    return null;
  }

  const aggregate = await recomputeInspectionAggregates(inspection.id, {
    updateToilet: true,
  });
  const refreshedInspection = await Inspection.findByPk(inspection.id);

  const result = buildResultSummaryFromImages({
    imageResults,
    aggregate,
  });
  result.processingMs = processingMs;
  const policyRows = imageResults.map((item) => item?.strictJson?.ai_scoring).filter(Boolean);
  const explainableRows = policyRows.map((row) => row?.explainable).filter(Boolean);
  const selectedExplainable = explainableRows[explainableRows.length - 1] || null;
  const severitySummary = policyRows.reduce((summary, row) => {
    for (const key of ['minor', 'moderate', 'major', 'critical']) summary[key] += Number(row?.severityCounts?.[key] || 0);
    return summary;
  }, { minor: 0, moderate: 0, major: 0, critical: 0 });
  result.aiScoring = {
    mode: selectedExplainable?.mode || tenantAiScoringMode,
    policyVersion: selectedExplainable?.scoringFormulaVersion || AI_SCORING_POLICY_VERSION,
    baseScore: round2(mean(policyRows.map((row) => row.baseScore)) ?? result.overallCleanlinessScore),
    finalScore: result.overallCleanlinessScore,
    severitySummary,
    capsApplied: policyRows.flatMap((row) => row.capsApplied || []),
    explainable: selectedExplainable,
  };
  result.rawResult = { ...result.rawResult, aiScoring: result.aiScoring };

  const analysis = await AiAnalysisResult.create({
    inspection_id: inspection.id,
    model_name: result.modelName,
    model_version: result.modelVersion,
    provider: result.provider,
    schema_version: result.schemaVersion,
    cleanliness_score: result.cleanlinessScore,
    hygiene_score: result.hygieneScore,
    odor_risk_score: result.odorRiskScore,
    wetness_score: result.wetnessScore,
    stain_score: result.stainScore,
    litter_score: result.litterScore,
    confidence_score: result.confidenceScore,
    review_required: Boolean(result.reviewRequired),
    sub_scores: result.subScores,
    issue_tags: result.issueTags,
    severity_label: result.severityLabel,
    explanation_text: result.explanationText,
    processing_ms: processingMs,
    anomaly_flags: result.anomalyFlags,
    raw_result: result.rawResult,
    ai_scoring_mode_applied: result.aiScoring.mode,
    ai_scoring_policy_version: result.aiScoring.policyVersion,
    ai_base_score: result.aiScoring.baseScore,
    ai_final_score: result.aiScoring.finalScore,
    ai_severity_summary: result.aiScoring.severitySummary,
    scoring_mode: selectedExplainable?.mode || null,
    scoring_config_version: selectedExplainable?.scoringConfigVersion || null,
    scoring_formula_version: selectedExplainable?.scoringFormulaVersion || null,
    ai_model_version_v2: selectedExplainable ? result.modelVersion : null,
    sensor_calibration_version: selectedExplainable?.sensor?.evidence?.sensorCalibrationVersion || null,
    capture_protocol_version: selectedExplainable?.sensor?.evidence?.protocolVersion || null,
    scoring_explanation_json: selectedExplainable || null,
    component_scores_json: selectedExplainable?.components || null,
    score_reasons_json: selectedExplainable?.reasons || null,
    processed_at: processedAt,
  });

  await inspection.update({
    processing_status: refreshedInspection?.processing_status || 'completed',
    pipeline_status: refreshedInspection?.pipeline_status || 'completed',
    submitted_at: inspection.submitted_at || (submissionId ? processedAt : null),
    overall_status: result.overallStatus,
    review_required: Boolean(refreshedInspection?.review_required || result.reviewRequired),
    last_processing_error: imageFailures.length > 0 ? failureMessage : null,
    ai_scoring_mode_applied: result.aiScoring.mode,
    ai_scoring_policy_version: result.aiScoring.policyVersion,
    scoring_mode: selectedExplainable?.mode || null,
    scoring_config_version: selectedExplainable?.scoringConfigVersion || null,
    scoring_formula_version: selectedExplainable?.scoringFormulaVersion || null,
    ai_model_version: selectedExplainable ? result.modelVersion : null,
    sensor_calibration_version: selectedExplainable?.sensor?.evidence?.sensorCalibrationVersion || null,
    capture_protocol_version: selectedExplainable?.sensor?.evidence?.protocolVersion || null,
    scoring_explanation_json: selectedExplainable || null,
    component_scores_json: selectedExplainable?.components || null,
    score_reasons_json: selectedExplainable?.reasons || null,
    updated_at: processedAt,
  });

  const pipelineStatus = refreshedInspection?.pipeline_status || inspection.pipeline_status || 'completed';

  if (submissionId) {
    const submission = await InspectionSubmission.findByPk(submissionId);
    if (submission) {
      await submission.update({
        status: refreshedInspection?.status || pipelineStatus,
        updated_at: new Date(),
      });
    }
  }

  if (processingJob) {
    await processingJob.update({
      status: imageResults.length > 0 ? 'succeeded' : 'failed',
      completed_at: processedAt,
      duration_ms: processingMs,
      image_id: imageId || processingJob.image_id || null,
      job_type: String(jobType || 'AI_ANALYSIS'),
      last_error: imageFailures.length > 0 ? failureMessage : null,
      leased_until: null,
      last_heartbeat_at: new Date(),
      failure_classification: imageFailures.length > 0 ? 'permanent' : null,
      next_retry_at: null,
      result: {
        analysisId: analysis.id,
        type: String(jobType || 'AI_ANALYSIS'),
        imageId: imageId || null,
        analyzedImageIds,
        failedImageIds,
        pipelineStatus,
        overallStatus: result.overallStatus,
        confidenceScore: result.confidenceScore,
        inspectionStatus: aggregate?.status || refreshedInspection?.status || null,
      },
      updated_at: new Date(),
    });
  }

  await InspectionEvent.create({
    tenant_id: inspection.tenant_id,
    inspection_id: inspection.id,
    toilet_id: inspection.toilet_unit_id || null,
    image_id: imageId || null,
    event_type: 'analysis.completed',
    event_status: pipelineStatus,
    source: 'worker',
    payload: {
      analysisId: analysis.id,
      type: String(jobType || 'AI_ANALYSIS'),
      imageId: imageId || null,
      analyzedImageIds,
      failedImageIds,
      queueJobId: queueJobId || null,
      submissionId: submissionId || null,
      confidenceScore: result.confidenceScore,
      reviewRequired: Boolean(refreshedInspection?.review_required || result.reviewRequired),
      severityLabel: result.severityLabel,
      processingMs,
      aggregate,
    },
    occurred_at: new Date(),
  });

  await maybeCreateAlert({ inspection, result });

  eventBus.emit(EVENTS.ANALYSIS_COMPLETED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    facilityId: inspection.facility_id,
    result: {
      id: analysis.id,
      overallCleanlinessScore: result.overallCleanlinessScore,
      cleanlinessScore: result.cleanlinessScore,
      hygieneScore: result.hygieneScore,
      odorRiskScore: result.odorRiskScore,
      wetnessScore: result.wetnessScore,
      stainScore: result.stainScore,
      litterScore: result.litterScore,
      issueTags: result.issueTags,
      severityLabel: result.severityLabel,
      confidenceScore: result.confidenceScore,
      reviewRequired: Boolean(refreshedInspection?.review_required || result.reviewRequired),
      overallStatus: result.overallStatus,
      strictJson: result.rawResult?.strictJson || null,
          sensorImpact: result.sensorImpact,
          environmentalScore: result.environmentalScore,
          visualScore: result.visualScore ?? null,
      processedAt,
      scoreLabel: scoreLabel(result.overallCleanlinessScore),
      imageResultsCount: imageResults.length,
    },
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    processingStatus: refreshedInspection?.processing_status || 'completed',
    pipelineStatus: refreshedInspection?.pipeline_status || pipelineStatus,
    overallStatus: result.overallStatus,
    reviewRequired: Boolean(refreshedInspection?.review_required || result.reviewRequired),
    inspectionStatus: refreshedInspection?.status || aggregate?.status || null,
  });

  try {
    const facilityMetrics = await getFacilityMetrics(inspection.facility_id, {
      user: { isSuperAdmin: true, tenantId: inspection.tenant_id },
    });
    if (facilityMetrics) {
      eventBus.emit(EVENTS.FACILITY_METRICS_UPDATED, {
        facilityId: inspection.facility_id,
        tenantId: inspection.tenant_id,
        metrics: facilityMetrics,
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to emit facility metrics update:', error.message);
  }

  await createAuditLog({
    req,
    actorUserId: req?.user?.id || inspection.inspector_user_id,
    tenantId: inspection.tenant_id,
    action: 'analysis.inspection_run',
    entityType: 'inspection',
    entityId: inspection.id,
    details: {
      analysisId: analysis.id,
      type: String(jobType || 'AI_ANALYSIS'),
      imageId: imageId || null,
      analyzedImageIds,
      failedImageIds,
      overallStatus: result.overallStatus,
      confidenceScore: result.confidenceScore,
      sensorImpact: result.sensorImpact || 0,
      environmentalScore: result.environmentalScore ?? null,
      visualScore: result.visualScore ?? null,
      reviewRequired: Boolean(refreshedInspection?.review_required || result.reviewRequired),
      inspectionStatus: refreshedInspection?.status || aggregate?.status || null,
      processingMs,
    },
  });

  return analysis;
};

const getAnalysisResult = async (inspectionId, req) => {
  const inspection = await Inspection.findByPk(inspectionId);
  if (!inspection) {
    return null;
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    return null;
  }

  const analysis = await AiAnalysisResult.findOne({
    where: { inspection_id: inspectionId },
    order: [['processed_at', 'DESC']],
  });

  if (!analysis) {
    return {
      inspectionId,
      processingStatus: inspection.processing_status,
      pipelineStatus: inspection.pipeline_status || inspection.processing_status,
      reviewRequired: Boolean(inspection.review_required),
      result: null,
    };
  }

  const rawResult =
    analysis.raw_result && typeof analysis.raw_result === 'object' ? analysis.raw_result : {};
  const strictJsonFromRaw =
    rawResult.strictJson && typeof rawResult.strictJson === 'object' ? rawResult.strictJson : null;
  const computedStrictJson =
    strictJsonFromRaw ||
    buildStrictToiletJsonFromNormalizedResult({
      overallCleanlinessScore: rawResult.overallCleanlinessScore ?? analysis.cleanliness_score,
      cleanlinessScore: analysis.cleanliness_score,
      hygieneScore: analysis.hygiene_score,
      stainScore: analysis.stain_score,
      wetnessScore: analysis.wetness_score,
      litterScore: analysis.litter_score,
      confidenceScore: analysis.confidence_score,
      issueTags: Array.isArray(analysis.issue_tags) ? analysis.issue_tags : [],
      severityLabel: analysis.severity_label || null,
      reviewRequired: analysis.review_required,
    });

  return {
    inspectionId,
    processingStatus: inspection.processing_status,
    pipelineStatus: inspection.pipeline_status || inspection.processing_status,
    reviewRequired: Boolean(inspection.review_required),
    result: {
      id: analysis.id,
      modelName: analysis.model_name,
      modelVersion: analysis.model_version,
      provider: analysis.provider || null,
      schemaVersion: analysis.schema_version || null,
      overallCleanlinessScore: Number(computedStrictJson.overall_cleanliness_score || 0),
      cleanlinessScore: Number(analysis.cleanliness_score),
      hygieneScore: Number(analysis.hygiene_score),
      odorRiskScore: Number(analysis.odor_risk_score),
      wetnessScore: Number(analysis.wetness_score),
      stainScore: Number(analysis.stain_score),
      litterScore: Number(analysis.litter_score),
      confidenceScore:
        analysis.confidence_score !== null && analysis.confidence_score !== undefined
          ? Number(analysis.confidence_score)
          : null,
      reviewRequired: Boolean(analysis.review_required),
      subScores: analysis.sub_scores || null,
      issueTags: Array.isArray(analysis.issue_tags) ? analysis.issue_tags : [],
      severityLabel: analysis.severity_label || null,
      explanationText: analysis.explanation_text || null,
      processingMs: Number(analysis.processing_ms || 0) || null,
      anomalyFlags: analysis.anomaly_flags || {},
      strictJson: computedStrictJson,
      rawResult,
      processedAt: analysis.processed_at,
      sensorImpact:
        Number(computedStrictJson.sensor_impact ?? rawResult?.strictJson?.sensor_impact ?? 0) || 0,
      environmentalScore:
        computedStrictJson.environmental_score ??
        rawResult?.strictJson?.environmental_score ??
        null,
      visualScore:
        computedStrictJson.visual_score ??
        rawResult?.strictJson?.visual_score ??
        Number(computedStrictJson.overall_cleanliness_score || 0),
      overallStatus: inspection.overall_status,
    },
  };
};

const getInspectionAnalysisTrend = async (inspectionId, req, options = {}) => {
  const inspection = await Inspection.findByPk(inspectionId);
  if (!inspection) {
    return null;
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    return null;
  }

  const limit = Math.min(Math.max(Number(options.limit || 25), 3), 60);
  const rows = await AiAnalysisResult.findAll({
    where: { inspection_id: inspectionId },
    order: [['processed_at', 'ASC']],
    limit,
  });

  const points = rows.map((row, index) => {
    const stainScore = Number(row.stain_score || 0);
    const litterScore = Number(row.litter_score || 0);
    const wetnessScore = Number(row.wetness_score || 0);
    const concernScore = Number(
      (((100 - stainScore) + (100 - litterScore) + (100 - wetnessScore)) / 3).toFixed(2)
    );

    return {
      index: index + 1,
      analysisId: row.id,
      processedAt: row.processed_at,
      stainScore,
      litterScore,
      wetnessScore,
      concernScore,
      cleanlinessScore: Number(row.cleanliness_score || 0),
      hygieneScore: Number(row.hygiene_score || 0),
      confidenceScore:
        row.confidence_score !== null && row.confidence_score !== undefined
          ? Number(row.confidence_score)
          : null,
      severityLabel: row.severity_label || null,
    };
  });

  return {
    inspectionId,
    tenantId: inspection.tenant_id,
    points,
  };
};

const getFacilityMetrics = async (facilityId, req) => {
  const facility = await Facility.findByPk(facilityId);
  if (!facility) {
    return null;
  }
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    return null;
  }

  const inspections = await Inspection.findAll({
    where: {
      facility_id: facilityId,
      processing_status: 'completed',
    },
    order: [['captured_at', 'DESC']],
    limit: 25,
    include: [{ model: AiAnalysisResult }],
  });

  const count = inspections.length;
  const avgCleanliness =
    count === 0
      ? 0
      : inspections.reduce((sum, item) => {
          const latest = (item.AiAnalysisResults || [])[0];
          return sum + Number(latest?.cleanliness_score || 0);
        }, 0) / count;

  return {
    facilityId,
    facilityName: facility.name,
    recentInspections: count,
    averageCleanliness: Number(avgCleanliness.toFixed(2)),
    latestOverallStatus: inspections[0]?.overall_status || null,
  };
};

module.exports = {
  runInspectionAnalysis,
  getAnalysisResult,
  getInspectionAnalysisTrend,
  getFacilityMetrics,
  __testUtils: {
    computeSensorImpact,
  },
};
