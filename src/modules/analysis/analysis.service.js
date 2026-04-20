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
const ANALYSIS_SCHEMA_VERSION = 'analysis.v4';
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

  return {
    overallStatus: deriveStatus(overviewScore),
    overallCleanlinessScore: round2(overviewScore) || 0,
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
      (aggregate?.reviewRequired ? 'high' : 'medium'),
    reviewRequired: Boolean(aggregate?.reviewRequired || base?.reviewRequired),
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
        severity_level: aggregate?.reviewRequired ? 'high' : 'medium',
        human_review_required: Boolean(aggregate?.reviewRequired || base?.reviewRequired),
      },
      imageCount: effective.length,
      aggregate: aggregate || null,
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
      imageResults.push({
        imageId: mediaRow.id,
        strictJson: {
          floor_cleanliness: Math.round(Number(mediaRow.floor_score || 0)),
          commode_urinal_cleanliness: Math.round(Number(mediaRow.commode_score || 0)),
          stain_presence: Math.round(Number(mediaRow.stain_score || 0)),
          water_stagnation: Math.round(Number(mediaRow.water_score || 0)),
          garbage_presence: Number(mediaRow.garbage_score || 0) > 50,
          overall_cleanliness_score: Math.round(Number(mediaRow.overall_score || 0)),
          confidence_score:
            mediaRow.confidence_score !== null && mediaRow.confidence_score !== undefined
              ? Number(mediaRow.confidence_score)
              : null,
          detected_issues: Array.isArray(mediaRow.issue_tags) ? mediaRow.issue_tags : [],
          severity_level: mediaRow.severity || 'medium',
          human_review_required: Boolean(mediaRow.review_required),
          explanation_summary: mediaRow.explanation_summary || mediaRow.issue_summary || null,
        },
        result: {
          overallCleanlinessScore: Number(mediaRow.overall_score || 0),
          cleanlinessScore: Number(mediaRow.floor_score || 0),
          hygieneScore: Number(mediaRow.commode_score || 0),
          stainScore: 100 - Number(mediaRow.stain_score || 0),
          wetnessScore: 100 - Number(mediaRow.water_score || 0),
          litterScore: 100 - Number(mediaRow.garbage_score || 0),
          confidenceScore:
            mediaRow.confidence_score !== null && mediaRow.confidence_score !== undefined
              ? Number(mediaRow.confidence_score)
              : null,
          issueTags: Array.isArray(mediaRow.issue_tags) ? mediaRow.issue_tags : [],
          reviewRequired: Boolean(mediaRow.review_required),
          severityLabel: mediaRow.severity || 'medium',
          modelName: runtimeConfig.analysis.openaiModel || 'gpt-4o-mini',
          modelVersion: mediaRow.model_version || 'openai-chat-completions-v4',
          provider: 'cached',
          explanationText: mediaRow.explanation_summary || mediaRow.issue_summary || null,
        },
      });
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

      const providerResult = await analyzeInspectionWithOpenAI({
        inspection,
        mediaRows: [mediaRow],
      });
      const processingMs = Date.now() - mediaStartedAt;
      const result = normalizeResultFromProvider({
        providerResult,
        processingMs,
      });
      const strictJson = result.rawResult?.strictJson || null;
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
      const overallScore = calibrateOverallScore({
        strictJson,
        normalizedIssues: issues,
        confidence,
      });
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
      const reviewRequired =
        (strictJson && strictJson.human_review_required !== undefined
          ? Boolean(strictJson.human_review_required)
          : Boolean(result.reviewRequired)) || confidenceEngine.reviewRequired;
      similarityResult = await compareAgainstBeforeHashes({
        inspectionId: inspection.id,
        captureStage: mediaRow.capture_stage,
        perceptualHash,
        imageId: mediaRow.id,
      });
      const severity =
        strictJson?.severity_level ||
        (String(result.severityLabel || '').toLowerCase() === 'critical'
          ? 'high'
          : String(result.severityLabel || '').toLowerCase() || null) ||
        'medium';
      const quality = qualityResult?.imageQualityStatus || 'ok';
      const suspiciousFlags = [];
      if (similarityResult?.suspicious) {
        suspiciousFlags.push('possible_fake_cleaning_similar_images');
      }
      if (confidenceEngine.reviewRequired) {
        suspiciousFlags.push('low_confidence');
      }
      const qualityWarning = qualityValidationStatus !== 'VALID';
      const resolvedValidationStatus = lowConfidenceReview
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
      const resolvedValidationReason =
        validationReasons.length > 0 ? validationReasons.join(' | ').slice(0, 500) : null;

      await mediaRow.update({
        ai_status: 'AI_COMPLETED',
        processing_state: IMAGE_PROCESSING_STATES.AI_COMPLETED,
        image_quality_status: quality,
        overall_score: round2(overallScore),
        confidence_score: round2(confidence),
        floor_score: round2(floorScore),
        commode_score: round2(commodeScore),
        stain_score: round2(stainScore),
        garbage_score: round2(garbageScore),
        water_score: round2(waterScore),
        issue_tags: issues,
        issue_summary: issues.length > 0 ? issues.slice(0, 6).join(', ') : null,
        severity,
        review_required:
          reviewRequired ||
          quality !== 'ok' ||
          Boolean(similarityResult?.suspicious) ||
          lowConfidenceReview,
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
          strictJson?.explanation_summary ||
          result.explanationText ||
          (issues.length > 0 ? issues.join(', ') : null),
        updated_at: new Date(),
      });

      imageResults.push({
        imageId: mediaRow.id,
        strictJson,
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
          confidence: round2(confidence),
          severity,
          reviewRequired:
            reviewRequired ||
            quality !== 'ok' ||
            Boolean(similarityResult?.suspicious) ||
            lowConfidenceReview,
          suspiciousFlags,
          validationStatus: resolvedValidationStatus,
          scoringRejected: false,
          lowConfidenceReview,
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
        const fallbackOverallScore = calibrateOverallScore({
          strictJson: fallbackStrictJson,
          normalizedIssues: fallbackIssues,
          confidence: fallbackConfidence,
        });
        const fallbackStrictWithCalibrated = {
          ...fallbackStrictJson,
          overall_cleanliness_score: Math.round(fallbackOverallScore),
          confidence_score: Number(fallbackConfidence.toFixed(4)),
          detected_issues: fallbackIssues,
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
        const fallbackSeverity =
          fallbackStrictWithCalibrated.severity_level || 'high';
        const fallbackOdorRiskScore = clamp(
          Math.round(
            fallbackStainScore * 0.45 +
              fallbackWaterScore * 0.4 +
              (fallbackStrictWithCalibrated.garbage_presence ? 15 : 0)
          ),
          0,
          100
        );
        const fallbackValidationReason = `Fallback scoring applied due to ${
          failure.errorCode || code || 'analysis_error'
        }: ${failure.message || 'Unknown failure'}`.slice(0, 500);

        await mediaRow.update({
          ai_status: 'AI_COMPLETED',
          processing_state: IMAGE_PROCESSING_STATES.AI_COMPLETED,
          image_quality_status: qualityResult?.imageQualityStatus || 'unknown',
          overall_score: round2(fallbackOverallScore),
          confidence_score: round2(fallbackConfidence),
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
          validation_status: 'FALLBACK_SCORED',
          validation_reason: fallbackValidationReason,
          visibility_score: visibilityScore,
          perceptual_hash: perceptualHash || null,
          similarity_score: similarityResult?.maxSimilarity || null,
          scoring_rejected: false,
          explanation_summary: fallbackStrictWithCalibrated.explanation_summary,
          updated_at: new Date(),
        });

        const fallbackResult = {
          overallCleanlinessScore: round2(fallbackOverallScore),
          cleanlinessScore: round2(fallbackFloorScore),
          hygieneScore: round2(fallbackCommodeScore),
          odorRiskScore: round2(fallbackOdorRiskScore),
          wetnessScore: round2(clamp(100 - fallbackWaterScore, 0, 100)),
          stainScore: round2(clamp(100 - fallbackStainScore, 0, 100)),
          litterScore: fallbackGarbageScore > 50 ? 0 : 100,
          confidenceScore: round2(fallbackConfidence),
          issueTags: fallbackIssues,
          severityLabel: fallbackSeverity,
          reviewRequired: true,
          explanationText: fallbackStrictWithCalibrated.explanation_summary,
          modelName: runtimeConfig.analysis.openaiModel || 'gpt-4o-mini',
          modelVersion: 'fallback-v1',
          provider: 'fallback',
          promptVersion: PROMPT_VERSION,
          scoringVersion: SCORING_VERSION,
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
            score: round2(fallbackOverallScore),
            confidence: round2(fallbackConfidence),
            severity: fallbackSeverity,
            reviewRequired: true,
            validationStatus: 'FALLBACK_SCORED',
            scoringRejected: false,
            fallbackScored: true,
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
      submitted_at: inspection.submitted_at || processedAt,
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
    processed_at: processedAt,
  });

  await inspection.update({
    processing_status: refreshedInspection?.processing_status || 'completed',
    pipeline_status: refreshedInspection?.pipeline_status || 'completed',
    submitted_at: inspection.submitted_at || processedAt,
    overall_status: result.overallStatus,
    review_required: Boolean(refreshedInspection?.review_required || result.reviewRequired),
    last_processing_error: imageFailures.length > 0 ? failureMessage : null,
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
};
