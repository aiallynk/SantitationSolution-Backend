const { Op, QueryTypes } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  sequelize,
  Inspection,
  InspectionMedia,
  InspectionEvent,
  ToiletUnit,
  ToiletBlock,
  Facility,
  PlatformUser,
  WorkerAssignment,
  AiProcessingJob,
  AiAnalysisResult,
  ToiletScoreDaily,
} = require('../../models');
const {
  getQrImageUrl,
  getFeedbackQrImageUrl,
  getPublicFeedbackUrl,
  ensureAllQrImagesForToilet,
} = require('../platform/toiletQr.service');
const {
  normalizeMediaUrl,
  resolveMediaPairUrls,
} = require('../media/mediaUrl.service');
const { applyTenantScope, isFacilityInScope } = require('../../core/rbac/scopeWhere');
const { IMAGE_PROCESSING_STATES } = require('./imageLifecycle.constants');
const { runtimeConfig } = require('../../config/runtime');
const {
  evaluatePairwiseComparison,
  starRatingFromScore,
} = require('../analysis/sanitationPostProcessing.helper');

const REVIEW_CONFIDENCE_THRESHOLD = runtimeConfig.analysis.confidenceThreshold;
const IMPROVEMENT_THRESHOLD = runtimeConfig.analysis.improvementThreshold;

const toNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round2 = (value) =>
  value === null || value === undefined ? null : Number(Number(value).toFixed(2));

const mean = (values) => {
  if (!Array.isArray(values) || values.length === 0) return null;
  const valid = values.map((item) => toNumber(item, null)).filter((item) => item !== null);
  if (valid.length === 0) return null;
  return valid.reduce((sum, item) => sum + item, 0) / valid.length;
};

const scoreLabel = (score) => {
  const value = toNumber(score, null);
  if (value === null) return 'Unknown';
  if (value <= 30) return 'Very Dirty';
  if (value <= 50) return 'Dirty';
  if (value <= 70) return 'Moderate';
  if (value <= 85) return 'Clean';
  return 'Very Clean';
};

const BASELINE_MIN_INSPECTIONS = 3;

const resolveBaselineConfidence = (inspectionCount) => {
  const count = Number(inspectionCount || 0);
  if (!Number.isFinite(count) || count < BASELINE_MIN_INSPECTIONS) return 'insufficient';
  if (count >= 20) return 'high';
  if (count >= 8) return 'medium';
  return 'low';
};

const resolveBaselineScore = ({ totalInspections, avgAfterScore, latestScore }) => {
  const avgAfter = toNumber(avgAfterScore, null);
  const latest = toNumber(latestScore, null);
  const count = Number(totalInspections || 0);
  if (count >= BASELINE_MIN_INSPECTIONS) {
    return avgAfter ?? latest;
  }
  return latest ?? avgAfter;
};

const canViewAdminDiagnostics = (req) => {
  if (req?.user?.isSuperAdmin) return true;
  const permissions = new Set(
    (Array.isArray(req?.user?.permissionCodes) ? req.user.permissionCodes : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (permissions.has('inspection.review') || permissions.has('task.manage')) {
    return true;
  }
  const roleCodes = new Set(
    (Array.isArray(req?.user?.roleCodes) ? req.user.roleCodes : [])
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  );
  return (
    roleCodes.has('tenant_admin') ||
    roleCodes.has('supervisor') ||
    roleCodes.has('facility_manager') ||
    roleCodes.has('platform_ops')
  );
};

const workerSafeStatusMessage = ({ processingState, validationStatus, validationReason }) => {
  const state = String(processingState || '').trim().toLowerCase();
  const validation = String(validationStatus || '').trim().toUpperCase();
  if (state === IMAGE_PROCESSING_STATES.AI_COMPLETED) return 'Done';
  if (state === IMAGE_PROCESSING_STATES.AI_RETRYING) return 'Retry in progress';
  if (state === IMAGE_PROCESSING_STATES.AI_PROCESSING) return 'Processing';
  if (state === IMAGE_PROCESSING_STATES.QUEUED_FOR_AI) return 'Queued for processing';
  if (state === IMAGE_PROCESSING_STATES.STORAGE_VERIFIED || state === IMAGE_PROCESSING_STATES.UPLOADED) {
    return 'Uploaded';
  }
  if (state === IMAGE_PROCESSING_STATES.UPLOADING || state === IMAGE_PROCESSING_STATES.QUEUED_FOR_UPLOAD) {
    return 'Uploading';
  }
  if (
    state === IMAGE_PROCESSING_STATES.AI_FAILED_TRANSIENT ||
    validation === 'PENDING'
  ) {
    return 'Processing delayed, retry in progress';
  }
  if (
    state === IMAGE_PROCESSING_STATES.MANUAL_REVIEW_REQUIRED ||
    state === IMAGE_PROCESSING_STATES.AI_FAILED_PERMANENT ||
    state === IMAGE_PROCESSING_STATES.UPLOAD_FAILED_PERMANENT
  ) {
    return 'Needs review';
  }
  if (validation.startsWith('FAILED')) {
    return validationReason
      ? `Needs review: ${String(validationReason).slice(0, 140)}`
      : 'Needs review';
  }
  return 'Saved';
};

const normalizeIssueTag = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .slice(0, 80);

const unionIssueTags = (rows = []) => {
  const tags = new Set();
  for (const row of rows) {
    const list = Array.isArray(row.issue_tags) ? row.issue_tags : [];
    for (const item of list) {
      const normalized = normalizeIssueTag(item);
      if (normalized) tags.add(normalized);
    }
  }
  return Array.from(tags.values());
};

const stageOf = (row) => String(row.capture_stage || 'evidence').toLowerCase();

const getAiScoringMetadata = (row) => {
  if (!row || typeof row !== 'object') return null;
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : null;
  if (!metadata || Array.isArray(metadata)) return null;
  const scoring = metadata.ai_scoring;
  if (!scoring || typeof scoring !== 'object' || Array.isArray(scoring)) return null;
  return scoring;
};

const getScoreFromRow = (row) => {
  const scored = toNumber(row?.overall_score, null);
  if (scored !== null) return scored;
  const aiScoring = getAiScoringMetadata(row);
  if (!aiScoring) return null;
  return toNumber(aiScoring.score_0_100, null);
};

const scoreStatusFromSignals = ({ score, hygieneRisk, requiresRetake, suspicious }) => {
  if (requiresRetake) return 'Retake Required';
  if (suspicious) return 'Suspicious Improvement';
  if (String(hygieneRisk || '').toLowerCase() === 'severe') return 'Severe Hygiene Issue';
  const value = toNumber(score, null);
  if (value === null) return 'Pending Analysis';
  if (value < 40) return 'Needs Cleaning';
  return 'Clean';
};

const hasScored = (row) =>
  String(row.ai_status || '').toUpperCase() === 'AI_COMPLETED' &&
  toNumber(row.overall_score, null) !== null &&
  !Boolean(row.scoring_rejected) &&
  !String(row.validation_status || '')
    .toUpperCase()
    .startsWith('FAILED') &&
  String(row.validation_status || '').toUpperCase() !== 'REJECTED_LOW_CONFIDENCE';

const AI_STATUS_PRIORITY = {
  AI_COMPLETED: 60,
  AI_PROCESSING: 50,
  AI_QUEUED: 40,
  UPLOADED: 30,
  PENDING_UPLOAD: 20,
  AI_FAILED: 10,
};

const PLACEHOLDER_AI_STATUSES = new Set([
  'PENDING_UPLOAD',
  'UPLOADED',
  'AI_QUEUED',
  'AI_PROCESSING',
]);
const PLACEHOLDER_UPLOAD_STATUSES = new Set([
  'upload_session_created',
  'created',
  'pending',
  'uploading',
]);

const hasRenderableImage = (row) => {
  const fileUrl = String(row?.file_url || '').trim();
  const thumbnailUrl = String(row?.thumbnail_url || '').trim();
  return fileUrl.length > 0 || thumbnailUrl.length > 0;
};

const toTimestamp = (value) => {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const mediaRowPriority = (row) => {
  const aiStatus = String(row?.ai_status || '').trim().toUpperCase();
  const uploadStatus = String(row?.upload_status || '').trim().toLowerCase();
  const hasConfirmedUpload =
    uploadStatus === 'confirmed' || uploadStatus === 'uploaded';

  let score = 0;
  if (hasRenderableImage(row)) score += 1000;
  if (hasScored(row)) score += 500;
  if (hasConfirmedUpload) score += 120;
  score += AI_STATUS_PRIORITY[aiStatus] || 0;
  if (row?.captured_at) score += 20;
  return score;
};

const mediaDedupKey = (row, index = 0) => {
  const stage = stageOf(row);
  const clientImageId = String(row?.client_image_id || '').trim();
  if (clientImageId) return `client:${stage}:${clientImageId}`;

  const hash = String(row?.sha256 || '').trim().toLowerCase();
  if (hash) return `sha:${stage}:${hash}`;

  const fileUrl = String(row?.file_url || '').trim();
  if (fileUrl) return `url:${stage}:${fileUrl}`;

  return `id:${row?.id || index}`;
};

const pickPreferredMediaRow = (left, right) => {
  if (!left) return right;
  if (!right) return left;

  const leftPriority = mediaRowPriority(left);
  const rightPriority = mediaRowPriority(right);
  if (leftPriority !== rightPriority) {
    return rightPriority > leftPriority ? right : left;
  }

  const leftUpdated = toTimestamp(left.updated_at || left.created_at || left.captured_at);
  const rightUpdated = toTimestamp(right.updated_at || right.created_at || right.captured_at);
  return rightUpdated > leftUpdated ? right : left;
};

const removePlaceholderRows = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const hasRenderableByStage = new Map();
  for (const row of rows) {
    const stage = stageOf(row);
    if (hasRenderableImage(row)) {
      hasRenderableByStage.set(stage, true);
    } else if (!hasRenderableByStage.has(stage)) {
      hasRenderableByStage.set(stage, false);
    }
  }

  return rows.filter((row) => {
    const stage = stageOf(row);
    if (!hasRenderableByStage.get(stage)) {
      return true;
    }
    if (hasRenderableImage(row)) {
      return true;
    }

    const aiStatus = String(row.ai_status || '').trim().toUpperCase();
    const uploadStatus = String(row.upload_status || '').trim().toLowerCase();
    const isPlaceholder =
      PLACEHOLDER_AI_STATUSES.has(aiStatus) ||
      PLACEHOLDER_UPLOAD_STATUSES.has(uploadStatus);
    return !isPlaceholder;
  });
};

const sortMediaRowsForEvidence = (rows = []) => {
  return [...rows].sort((left, right) => {
    const stageComparison = stageOf(left).localeCompare(stageOf(right));
    if (stageComparison !== 0) return stageComparison;

    const leftOrdinal = toNumber(left.ordinal, Number.MAX_SAFE_INTEGER);
    const rightOrdinal = toNumber(right.ordinal, Number.MAX_SAFE_INTEGER);
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;

    const leftCaptured = toTimestamp(left.captured_at);
    const rightCaptured = toTimestamp(right.captured_at);
    if (leftCaptured !== rightCaptured) return leftCaptured - rightCaptured;

    const leftCreated = toTimestamp(left.created_at);
    const rightCreated = toTimestamp(right.created_at);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;

    return String(left.id || '').localeCompare(String(right.id || ''));
  });
};

const dedupeInspectionMediaRows = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const selected = new Map();
  rows.forEach((row, index) => {
    const key = mediaDedupKey(row, index);
    const previous = selected.get(key);
    selected.set(key, pickPreferredMediaRow(previous, row));
  });

  return sortMediaRowsForEvidence(removePlaceholderRows(Array.from(selected.values())));
};

const mapMediaEvidence = async (row, options = {}) => {
  const mediaUrlCache = options.mediaUrlCache || null;
  const includeAdminDiagnostics = Boolean(options.includeAdminDiagnostics);
  const aiScoring = getAiScoringMetadata(row);
  const overallScore =
    toNumber(row.overall_score, null) ?? toNumber(aiScoring?.score_0_100, null);
  const confidence = toNumber(row.confidence_score, null);
  const garbageScore = toNumber(row.garbage_score, null);
  const waterScore = toNumber(row.water_score, null);
  const stainScore = toNumber(row.stain_score, null);
  const issueTags = Array.isArray(row.issue_tags) ? row.issue_tags : [];
  const similarityScore = toNumber(row.similarity_score, null);
  const starRating =
    toNumber(aiScoring?.star_rating_0_5, null) ??
    (overallScore !== null ? starRatingFromScore(overallScore) : null);
  const hygieneRisk = String(aiScoring?.hygiene_risk || '').trim().toLowerCase() || null;
  const cleanlinessLevel =
    String(aiScoring?.cleanliness_level || '').trim().toLowerCase() || null;
  const requiresRetake = Boolean(aiScoring?.requires_retake);
  const retakeReason = String(aiScoring?.retake_reason || '').trim() || null;
  const scoreReason = String(aiScoring?.score_reason || '').trim() || null;
  const criticalFindings =
    aiScoring?.critical_findings && typeof aiScoring.critical_findings === 'object'
      ? aiScoring.critical_findings
      : null;
  const supervisorFlags =
    Array.isArray(aiScoring?.supervisor_flags) ? aiScoring.supervisor_flags : [];
  const validationStatus = row.validation_status || null;
  const validationReason = row.validation_reason || null;
  const suspiciousFlags = [];
  if (similarityScore !== null && similarityScore >= runtimeConfig.analysis.fraudSimilarityThreshold) {
    suspiciousFlags.push('possible_fake_cleaning_similar_images');
  }
  const operationalStatus =
    String(validationStatus || '').toUpperCase().startsWith('FAILED') ||
    String(validationStatus || '').toUpperCase() === 'REJECTED_LOW_CONFIDENCE'
      ? 'processing_failure'
      : 'ok';
  const processingState = row.processing_state || null;
  const workerMessage = workerSafeStatusMessage({
    processingState,
    validationStatus,
    validationReason,
  });

  const urls = await resolveMediaPairUrls(
    {
      fileUrl: row.file_url,
      thumbnailUrl: row.thumbnail_url || row.file_url,
      storageKey: row.storage_key || row.metadata?.storageKey || null,
    },
    { cache: mediaUrlCache }
  );

  return {
    id: row.id,
    clientImageId: row.client_image_id || null,
    inspectionId: row.inspection_id,
    toiletId: row.toilet_unit_id,
    workerId: row.worker_id,
    assignmentId: row.assignment_id,
    stage: String(row.capture_stage || 'evidence').toUpperCase(),
    imageUrl: urls.fileUrl || normalizeMediaUrl(row.file_url),
    thumbnailUrl:
      urls.thumbnailUrl || normalizeMediaUrl(row.thumbnail_url || row.file_url),
    capturedAt: row.captured_at || null,
    uploadedAt: row.uploaded_at || null,
    confirmedAt: row.confirmed_at || null,
    ordinal: row.ordinal || null,
    gpsLat: toNumber(row.gps_lat, null),
    gpsLng: toNumber(row.gps_lng, null),
    deviceId: row.device_id || null,
    uploadStatus: row.upload_status || null,
    processingState,
    aiStatus: row.ai_status || null,
    imageQualityStatus: row.image_quality_status || null,
    imageQualityScore: toNumber(row.image_quality_score, null),
    validationStatus,
    validationReason,
    toiletDetected:
      row.toilet_detected !== null && row.toilet_detected !== undefined
        ? Boolean(row.toilet_detected)
        : null,
    visibilityScore: toNumber(row.visibility_score, null),
    score: overallScore,
    score0To100: overallScore,
    starRating0To5: starRating,
    hygieneRisk,
    cleanlinessLevel,
    aiStatusLabel: scoreStatusFromSignals({
      score: overallScore,
      hygieneRisk,
      requiresRetake,
      suspicious: suspiciousFlags.length > 0,
    }),
    scoreLabel: scoreLabel(overallScore),
    confidence,
    aiConfidence:
      toNumber(aiScoring?.confidence, null) ??
      toNumber(aiScoring?.confidence_score, null) ??
      confidence,
    requiresRetake,
    retakeReason,
    scoreReason,
    criticalFindings,
    supervisorFlags,
    aiCapsApplied: Array.isArray(aiScoring?.caps_applied) ? aiScoring.caps_applied : [],
    subscores: {
      floor: toNumber(row.floor_score, null),
      commodeUrinal: toNumber(row.commode_score, null),
      stainPresence: stainScore,
      garbagePresence: garbageScore,
      waterStagnation: waterScore,
    },
    garbagePresence: garbageScore !== null ? garbageScore > 50 : null,
    issueTags,
    issueSummary: row.issue_summary || null,
    severity: row.severity || null,
    reviewRequired: Boolean(row.review_required),
    modelVersion: row.model_version || null,
    promptVersion: row.prompt_version || null,
    scoringVersion: row.scoring_version || null,
    aiProcessedAt: row.ai_processed_at || null,
    aiError: row.ai_error || null,
    retryCount: Number(row.retry_count || 0),
    aiAttemptCount: Number(row.ai_attempt_count || 0),
    nextRetryAt: row.next_retry_at || null,
    lastRetryAt: row.last_retry_at || null,
    storageVerifiedAt: row.storage_verified_at || null,
    lastErrorCode: includeAdminDiagnostics ? row.last_error_code || null : null,
    lastErrorMessage: includeAdminDiagnostics ? row.last_error_message || null : null,
    workerStatusMessage: workerMessage,
    scoringRejected: Boolean(row.scoring_rejected),
    similarityScore,
    suspiciousFlags,
    operationalStatus,
    explanationSummary: row.explanation_summary || null,
    watermarkMeta: row.watermark_meta || null,
    metadata: row.metadata || null,
  };
};

const scopedInspectionWhere = (req, where = {}) => {
  if (!req?.user) return where;
  return applyTenantScope(where, req);
};

const assertInspectionScope = async (inspectionId, req, options = {}) => {
  const inspection = await Inspection.findOne({
    where: scopedInspectionWhere(req, { id: inspectionId }),
    ...options,
  });
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!isFacilityInScope(req, inspection.facility_id || null)) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return inspection;
};

const assertToiletScope = async (toiletId, req) => {
  const unit = await ToiletUnit.findByPk(toiletId, {
    include: [{
      model: Facility,
      attributes: ['id', 'tenant_id', 'name', 'code', 'metadata', 'address_line', 'latitude', 'longitude'],
    }],
  });
  if (!unit) {
    throw new AppError('Toilet not found', 404, { code: 'TOILET_NOT_FOUND' });
  }
  if (!req?.user?.isSuperAdmin && req?.user?.tenantId !== unit.Facility?.tenant_id) {
    throw new AppError('Toilet out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, unit.facility_id || unit.Facility?.id || null)) {
    throw new AppError('Toilet out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return unit;
};

const normalizeDateKey = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const buildInspectionMediaMap = async (inspectionIds = []) => {
  if (!Array.isArray(inspectionIds) || inspectionIds.length === 0) {
    return new Map();
  }
  const rows = await InspectionMedia.findAll({
    where: {
      inspection_id: {
        [Op.in]: inspectionIds,
      },
    },
    attributes: [
      'id',
      'inspection_id',
      'capture_stage',
      'overall_score',
      'confidence_score',
      'issue_tags',
      'review_required',
      'ai_status',
      'validation_status',
      'scoring_rejected',
      'similarity_score',
    ],
    order: [['inspection_id', 'ASC'], ['capture_stage', 'ASC'], ['created_at', 'ASC']],
  });
  const dedupedRows = dedupeInspectionMediaRows(rows);
  const map = new Map();
  for (const row of dedupedRows) {
    const key = String(row.inspection_id);
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(row);
  }
  return map;
};

const buildLatestAiResultMap = async (inspectionIds = []) => {
  if (!Array.isArray(inspectionIds) || inspectionIds.length === 0) {
    return new Map();
  }
  const rows = await AiAnalysisResult.findAll({
    where: {
      inspection_id: {
        [Op.in]: inspectionIds,
      },
    },
    attributes: [
      'inspection_id',
      'cleanliness_score',
      'confidence_score',
      'issue_tags',
      'processed_at',
    ],
    order: [['inspection_id', 'ASC'], ['processed_at', 'DESC']],
  });
  const map = new Map();
  for (const row of rows) {
    const key = String(row.inspection_id);
    if (!map.has(key)) {
      map.set(key, row);
    }
  }
  return map;
};

const buildInspectionMetrics = ({
  inspectionType = null,
  persisted = {},
  mediaRows = [],
  aiResult = null,
}) => {
  const beforeRows = mediaRows.filter((row) => stageOf(row) === 'before');
  const afterRows = mediaRows.filter((row) => stageOf(row) === 'after');
  const evidenceRows = mediaRows.filter((row) => {
    const stage = stageOf(row);
    return stage !== 'before' && stage !== 'after';
  });
  const scoredRows = mediaRows.filter((row) => hasScored(row));
  const scoredBeforeRows = beforeRows.filter((row) => hasScored(row));
  const scoredAfterRows = afterRows.filter((row) => hasScored(row));
  const scoredEvidenceRows = evidenceRows.filter((row) => hasScored(row));

  let avgBeforeScore =
    toNumber(persisted.avgBeforeScore, null) ??
    round2(mean(scoredBeforeRows.map((row) => toNumber(row.overall_score, null))));
  let avgAfterScore =
    toNumber(persisted.avgAfterScore, null) ??
    round2(mean(scoredAfterRows.map((row) => toNumber(row.overall_score, null))));
  let confidenceAvg =
    toNumber(persisted.confidenceAvg, null) ??
    round2(mean(scoredRows.map((row) => toNumber(row.confidence_score, null))));

  let beforeImageCount =
    beforeRows.length > 0
      ? beforeRows.length
      : toNumber(persisted.beforeImageCount, null);
  let afterImageCount =
    afterRows.length > 0
      ? afterRows.length
      : toNumber(persisted.afterImageCount, null);

  const beforeIssueTags = Array.isArray(persisted.beforeIssueTags)
    ? persisted.beforeIssueTags
    : unionIssueTags(beforeRows);
  const afterIssueTags = Array.isArray(persisted.afterIssueTags)
    ? persisted.afterIssueTags
    : unionIssueTags(afterRows);

  const normalizedInspectionType = String(inspectionType || '').toLowerCase();
  const aiScore = toNumber(aiResult?.cleanliness_score, null);
  const aiConfidence = toNumber(aiResult?.confidence_score, null);

  if (
    avgBeforeScore === null &&
    avgAfterScore === null &&
    scoredEvidenceRows.length > 0
  ) {
    const evidenceAvg = round2(
      mean(scoredEvidenceRows.map((row) => toNumber(row.overall_score, null)))
    );
    if (normalizedInspectionType === 'before_cleaning') {
      avgBeforeScore = evidenceAvg;
      if (beforeImageCount === null) beforeImageCount = evidenceRows.length;
    } else {
      avgAfterScore = evidenceAvg;
      if (afterImageCount === null) afterImageCount = evidenceRows.length;
    }
  }

  if (avgBeforeScore === null && avgAfterScore === null && aiScore !== null) {
    if (normalizedInspectionType === 'before_cleaning') {
      avgBeforeScore = aiScore;
    } else {
      avgAfterScore = aiScore;
    }
  }

  if (confidenceAvg === null && aiConfidence !== null) {
    confidenceAvg = aiConfidence;
  }

  const improvementScore =
    toNumber(persisted.improvementScore, null) ??
    (avgBeforeScore !== null && avgAfterScore !== null
      ? round2(avgAfterScore - avgBeforeScore)
      : null);

  const resolvedIssues =
    Array.isArray(persisted.resolvedIssues) && persisted.resolvedIssues.length > 0
      ? persisted.resolvedIssues
      : beforeIssueTags.filter((tag) => !afterIssueTags.includes(tag));
  const remainingIssues =
    Array.isArray(persisted.remainingIssues) && persisted.remainingIssues.length > 0
      ? persisted.remainingIssues
      : afterIssueTags;

  const reviewRequired =
    Boolean(persisted.reviewRequired) ||
    mediaRows.some((row) => Boolean(row.review_required)) ||
    (confidenceAvg !== null && confidenceAvg < REVIEW_CONFIDENCE_THRESHOLD);

  const validationFailedCount =
    toNumber(persisted.validationFailedCount, null) ??
    mediaRows.filter((row) =>
      String(row.validation_status || '')
        .trim()
        .toUpperCase()
        .startsWith('FAILED')
    ).length;
  const rejectedImageCount =
    toNumber(persisted.rejectedImageCount, null) ??
    mediaRows.filter((row) =>
      Boolean(row.scoring_rejected) ||
      String(row.validation_status || '')
        .trim()
        .toUpperCase() === 'REJECTED_LOW_CONFIDENCE'
    ).length;
  const suspiciousReasons = Array.isArray(persisted.suspiciousReasons)
    ? persisted.suspiciousReasons
    : [];
  const suspiciousFlag = Boolean(
    persisted.suspiciousFlag || suspiciousReasons.length > 0
  );

  const hasBefore = Number(beforeImageCount || 0) > 0;
  const hasAfter = Number(afterImageCount || 0) > 0;

  const inspectionResult =
    persisted.inspectionResult ||
    resolveInspectionResult({
      hasBefore,
      hasAfter,
      improvementScore,
    });

  return {
    avgBeforeScore,
    avgAfterScore,
    improvementScore,
    confidenceAvg,
    beforeImageCount: Number(beforeImageCount || 0),
    afterImageCount: Number(afterImageCount || 0),
    beforeIssueTags,
    afterIssueTags,
    resolvedIssues,
    remainingIssues,
    reviewRequired,
    inspectionResult,
    suspiciousFlag,
    suspiciousReasons,
    validationFailedCount: Number(validationFailedCount || 0),
    rejectedImageCount: Number(rejectedImageCount || 0),
  };
};

const resolveInspectionStatus = ({
  inspection,
  totalImages,
  completedImages,
  processingImages,
  failedImages,
  reviewRequired,
}) => {
  const submitted = Boolean(inspection.submitted_at);

  if (!submitted && totalImages === 0) return 'DRAFT';
  if (!submitted && totalImages > 0) return 'IN_PROGRESS';
  if (failedImages > 0 && completedImages === 0) return 'REVIEW_REQUIRED';
  if (completedImages === 0) return 'SUBMITTED';
  if (completedImages < totalImages || processingImages > 0) return 'PARTIALLY_SCORED';
  if (reviewRequired) return 'REVIEW_REQUIRED';
  return 'FULLY_SCORED';
};

const resolveInspectionResult = ({
  hasBefore,
  hasAfter,
  improvementScore,
}) => {
  if (!hasBefore || !hasAfter) return 'invalid';
  if (improvementScore === null || improvementScore === undefined) return 'partial';
  if (improvementScore >= IMPROVEMENT_THRESHOLD) return 'improved';
  if (improvementScore > 0) return 'partial';
  return 'not_improved';
};

const resolvePipelineStatus = (status) => {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'DRAFT') return 'draft_local';
  if (normalized === 'IN_PROGRESS') return 'pending_upload';
  if (normalized === 'SUBMITTED') return 'queued_for_ai';
  if (normalized === 'PARTIALLY_SCORED') return 'processing';
  if (normalized === 'FULLY_SCORED') return 'completed';
  if (normalized === 'REVIEW_REQUIRED') return 'needs_review';
  if (normalized === 'COMPLETED') return 'completed';
  return 'processing';
};

const toMillis = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isStaleTimestamp = (value, staleMs) => {
  if (!value || !Number.isFinite(staleMs) || staleMs <= 0) return false;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return false;
  return Date.now() - time >= staleMs;
};

const requeueStaleImageAnalysis = async ({ inspection, rows = [], req }) => {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const staleMs =
    toMillis(runtimeConfig.queue.analysisProcessingStaleMs) ??
    180000;
  const candidates = rows.filter((row) => {
    const status = String(row.ai_status || '').trim().toUpperCase();
    if (status !== 'AI_PROCESSING' && status !== 'AI_QUEUED') return false;
    return isStaleTimestamp(row.updated_at || row.created_at, staleMs);
  });
  if (candidates.length === 0) return rows;

  const { enqueueInspectionAnalysis } = require('../analysis/analysis.queue');
  const requeueLimit = Math.min(candidates.length, 8);
  const selected = candidates.slice(0, requeueLimit);

  for (const row of selected) {
    await row.update({
      ai_status: 'AI_QUEUED',
      processing_state: IMAGE_PROCESSING_STATES.AI_RETRYING,
      retry_count: Number(row.retry_count || 0) + 1,
      last_retry_at: new Date(),
      next_retry_at: null,
      ai_error: null,
      validation_status: 'PENDING',
      validation_reason: null,
      last_error_code: 'AI_STALE_REQUEUE',
      last_error_message: 'Image AI status was stale and requeued',
      updated_at: new Date(),
    });

    await InspectionEvent.create({
      tenant_id: inspection.tenant_id,
      inspection_id: inspection.id,
      toilet_id: row.toilet_unit_id || inspection.toilet_unit_id || null,
      image_id: row.id,
      event_type: 'analysis.image.stale_requeued',
      event_status: 'AI_QUEUED',
      source: 'api',
      actor_user_id: req?.user?.id || null,
      payload: {
        imageId: row.id,
        previousStatus: row.ai_status || null,
        staleMs,
      },
      occurred_at: new Date(),
    });

    await enqueueInspectionAnalysis({
      inspectionId: inspection.id,
      imageId: row.id,
      tenantId: inspection.tenant_id,
      jobType: 'AI_ANALYSIS',
      requestContext: {
        requestId: req?.requestId || null,
        ip: req?.ip || null,
        user: req?.user
          ? {
              id: req.user.id || null,
              tenantId: req.user.tenantId || null,
              isSuperAdmin: Boolean(req.user.isSuperAdmin),
              roleCodes: Array.isArray(req.user.roleCodes) ? req.user.roleCodes.slice(0, 20) : [],
            }
          : null,
        headers: null,
      },
    });
  }

  return InspectionMedia.findAll({
    where: { inspection_id: inspection.id },
    order: [
      ['capture_stage', 'ASC'],
      ['ordinal', 'ASC'],
      ['captured_at', 'ASC'],
      ['created_at', 'ASC'],
    ],
  });
};

const resolveProcessingStatus = (status) => {
  const normalized = String(status || '').toUpperCase();
  if (normalized === 'DRAFT' || normalized === 'IN_PROGRESS') return 'draft';
  if (normalized === 'SUBMITTED') return 'queued';
  if (normalized === 'PARTIALLY_SCORED') return 'processing';
  if (normalized === 'FULLY_SCORED' || normalized === 'REVIEW_REQUIRED' || normalized === 'COMPLETED') {
    return 'completed';
  }
  return 'processing';
};

const recomputeToiletDailyAggregates = async (toiletId, { transaction = null } = {}) => {
  const dailyRows = await sequelize.query(
    `
      SELECT
        DATE(COALESCE(i.submitted_at, i.captured_at)) AS date,
        AVG(i.avg_before_score)::numeric AS avg_before_score,
        AVG(i.avg_after_score)::numeric AS avg_after_score,
        COUNT(i.id)::int AS inspection_count,
        SUM(CASE WHEN COALESCE(i.avg_before_score, 0) < 51 THEN 1 ELSE 0 END)::int AS dirty_count,
        SUM(CASE WHEN COALESCE(i.avg_after_score, 0) >= 71 THEN 1 ELSE 0 END)::int AS cleaned_count,
        AVG(i.improvement_score)::numeric AS avg_improvement
      FROM inspections i
      WHERE i.toilet_unit_id = :toiletId
        AND (i.avg_before_score IS NOT NULL OR i.avg_after_score IS NOT NULL)
      GROUP BY DATE(COALESCE(i.submitted_at, i.captured_at))
      ORDER BY DATE(COALESCE(i.submitted_at, i.captured_at)) DESC
      LIMIT 120
    `,
    {
      replacements: { toiletId },
      type: QueryTypes.SELECT,
      transaction,
    }
  );

  for (const row of dailyRows) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) {
      continue;
    }

    const values = {
      avg_before_score: round2(toNumber(row.avg_before_score, null)),
      avg_after_score: round2(toNumber(row.avg_after_score, null)),
      inspection_count: Number(row.inspection_count || 0),
      dirty_count: Number(row.dirty_count || 0),
      cleaned_count: Number(row.cleaned_count || 0),
      avg_improvement: round2(toNumber(row.avg_improvement, null)),
      updated_at: new Date(),
    };

    const existing = await ToiletScoreDaily.findOne({
      where: {
        toilet_id: toiletId,
        date,
      },
      transaction,
    });

    if (existing) {
      await existing.update(values, { transaction });
    } else {
      await ToiletScoreDaily.create(
        {
          toilet_id: toiletId,
          date,
          ...values,
        },
        { transaction }
      );
    }
  }
};

const recomputeToiletAggregates = async (toiletId, { transaction = null } = {}) => {
  const inspections = await Inspection.findAll({
    where: {
      toilet_unit_id: toiletId,
      submitted_at: { [Op.ne]: null },
    },
    attributes: [
      'id',
      'captured_at',
      'submitted_at',
      'avg_before_score',
      'avg_after_score',
      'improvement_score',
      'status',
      'inspection_result',
    ],
    order: [['submitted_at', 'DESC'], ['captured_at', 'DESC']],
    transaction,
  });

  const totalInspections = inspections.length;
  const beforeScores = inspections
    .map((item) => toNumber(item.avg_before_score, null))
    .filter((item) => item !== null);
  const afterScores = inspections
    .map((item) => toNumber(item.avg_after_score, null))
    .filter((item) => item !== null);
  const improvements = inspections
    .map((item) => toNumber(item.improvement_score, null))
    .filter((item) => item !== null);

  const latest = inspections[0] || null;
  const latestBefore = latest ? toNumber(latest.avg_before_score, null) : null;
  const latestAfter = latest ? toNumber(latest.avg_after_score, null) : null;
  const latestScore = latestAfter ?? latestBefore;

  const dirtyCount = inspections.filter((item) => {
    const before = toNumber(item.avg_before_score, null);
    return before !== null && before <= 50;
  }).length;
  const lowPerformanceCount = inspections.filter((item) => {
    const delta = toNumber(item.improvement_score, null);
    return delta !== null && delta < IMPROVEMENT_THRESHOLD;
  }).length;

  const dirtyFrequency =
    totalInspections > 0 ? round2((dirtyCount / totalInspections) * 100) : 0;
  const lowPerformanceFrequency =
    totalInspections > 0 ? round2((lowPerformanceCount / totalInspections) * 100) : 0;

  let nextStatus = 'moderate';
  if (latestScore !== null) {
    if (latestScore >= 71) nextStatus = 'clean';
    else if (latestScore >= 51) nextStatus = 'moderate';
    else if (latestScore >= 31) nextStatus = 'poor';
    else nextStatus = 'critical';
  }

  const unit = await ToiletUnit.findByPk(toiletId, { transaction });
  if (!unit) return null;

  await unit.update(
    {
      latest_score: round2(latestScore),
      latest_before_score: round2(latestBefore),
      latest_after_score: round2(latestAfter),
      avg_before_score: round2(mean(beforeScores)),
      avg_after_score: round2(mean(afterScores)),
      avg_improvement_score: round2(mean(improvements)),
      last_inspection_at: latest?.submitted_at || latest?.captured_at || null,
      last_cleaned_at:
        inspections.find((item) => toNumber(item.avg_after_score, null) !== null)?.submitted_at ||
        inspections.find((item) => toNumber(item.avg_after_score, null) !== null)?.captured_at ||
        null,
      total_inspections: totalInspections,
      dirty_frequency: dirtyFrequency || 0,
      low_performance_frequency: lowPerformanceFrequency || 0,
      status: nextStatus,
      updated_at: new Date(),
    },
    { transaction }
  );

  try {
    await recomputeToiletDailyAggregates(toiletId, { transaction });
  } catch (error) {
    // Keep inspection/image scoring flow resilient even if daily aggregate table has legacy constraint issues.
    // eslint-disable-next-line no-console
    console.warn('Skipping toilet daily aggregate refresh:', error.message);
  }
  return unit;
};

const recomputeInspectionAggregates = async (
  inspectionId,
  { transaction = null, updateToilet = true } = {}
) => {
  const inspection = await Inspection.findByPk(inspectionId, { transaction });
  if (!inspection) return null;

  const mediaRows = await InspectionMedia.findAll({
    where: { inspection_id: inspectionId },
    order: [
      ['capture_stage', 'ASC'],
      ['ordinal', 'ASC'],
      ['captured_at', 'ASC'],
      ['created_at', 'ASC'],
    ],
    transaction,
  });

  const evidenceRows = dedupeInspectionMediaRows(mediaRows);
  const beforeRows = evidenceRows.filter((row) => stageOf(row) === 'before');
  const afterRows = evidenceRows.filter((row) => stageOf(row) === 'after');
  const scoredRows = evidenceRows.filter((row) => hasScored(row));
  const beforeScored = beforeRows.filter((row) => hasScored(row));
  const afterScored = afterRows.filter((row) => hasScored(row));

  const avgBeforeScore = round2(mean(beforeScored.map((row) => row.overall_score)));
  const avgAfterScore = round2(mean(afterScored.map((row) => row.overall_score)));
  const improvementScore =
    avgBeforeScore !== null && avgAfterScore !== null
      ? round2(avgAfterScore - avgBeforeScore)
      : null;
  const confidenceAvg = round2(mean(scoredRows.map((row) => row.confidence_score)));

  const beforeIssueTags = unionIssueTags(beforeRows);
  const afterIssueTags = unionIssueTags(afterRows);
  const resolvedIssues = beforeIssueTags.filter((tag) => !afterIssueTags.includes(tag));
  const remainingIssues = afterIssueTags;

  const beforeByOrdinal = new Map();
  for (const row of beforeRows) {
    const ordinal = toNumber(row.ordinal, null);
    if (ordinal === null || !hasScored(row)) continue;
    beforeByOrdinal.set(Number(ordinal), row);
  }
  const pairwiseComparisons = [];
  for (const after of afterRows) {
    const ordinal = toNumber(after.ordinal, null);
    if (ordinal === null || !beforeByOrdinal.has(Number(ordinal)) || !hasScored(after)) {
      continue;
    }
    const before = beforeByOrdinal.get(Number(ordinal));
    const beforeScore = getScoreFromRow(before);
    const afterScore = getScoreFromRow(after);
    if (beforeScore === null || afterScore === null) continue;
    const beforeAi = getAiScoringMetadata(before);
    const afterAi = getAiScoringMetadata(after);
    const duplicateDetected =
      String(before.sha256 || '').trim().toLowerCase() &&
      String(before.sha256 || '').trim().toLowerCase() ===
        String(after.sha256 || '').trim().toLowerCase();
    const similarityValue = toNumber(after.similarity_score, null);
    const comparison = evaluatePairwiseComparison({
      before_score_0_100: beforeScore,
      after_score_0_100: afterScore,
      before_critical_findings: beforeAi?.critical_findings || null,
      after_critical_findings: afterAi?.critical_findings || null,
      similarities: similarityValue !== null ? [similarityValue] : [],
      duplicate_detected: duplicateDetected,
      same_toilet_likely: null,
    });
    pairwiseComparisons.push({
      ordinal: Number(ordinal),
      before_image_id: before.id,
      after_image_id: after.id,
      ...comparison,
    });
  }
  const pairDeltaAvg =
    pairwiseComparisons.length > 0
      ? round2(mean(pairwiseComparisons.map((item) => toNumber(item.score_delta, 0))))
      : null;
  const pairBeforeAvg =
    pairwiseComparisons.length > 0
      ? round2(mean(pairwiseComparisons.map((item) => toNumber(item.before_score_0_100, 0))))
      : null;
  const pairAfterAvg =
    pairwiseComparisons.length > 0
      ? round2(mean(pairwiseComparisons.map((item) => toNumber(item.after_score_0_100, 0))))
      : null;
  const pairNoMeaningfulImprovement =
    pairwiseComparisons.length > 0 &&
    pairwiseComparisons.every((item) => item.improvement_level === 'none');
  const pairSameToiletFalse = pairwiseComparisons.some(
    (item) => item.same_toilet_likely === false
  );
  const pairSuspiciousChange = pairwiseComparisons.some(
    (item) => item.suspicious_change_detected === true
  );
  const pairAcceptImprovement =
    pairwiseComparisons.length > 0 &&
    pairwiseComparisons.some((item) => item.should_accept_improvement === true);
  const comparisonResult = {
    pair_count: pairwiseComparisons.length,
    same_toilet_likely: pairSameToiletFalse ? false : true,
    before_score_0_100_avg: pairBeforeAvg ?? avgBeforeScore,
    after_score_0_100_avg: pairAfterAvg ?? avgAfterScore,
    score_delta: pairDeltaAvg ?? improvementScore,
    cleanliness_difference_detected: !pairNoMeaningfulImprovement,
    improvement_level: pairNoMeaningfulImprovement
      ? 'none'
      : pairDeltaAvg !== null && pairDeltaAvg > 30
        ? 'major'
        : pairDeltaAvg !== null && pairDeltaAvg > 15
          ? 'moderate'
          : pairDeltaAvg !== null && pairDeltaAvg > 5
            ? 'minor'
            : 'none',
    should_accept_improvement: pairAcceptImprovement,
    suspicious_change_detected: pairSuspiciousChange || pairSameToiletFalse,
    suspicious_reason: pairSameToiletFalse
      ? 'Before/after images are unlikely to be of same toilet.'
      : pairSuspiciousChange
        ? 'Suspicious before/after similarity detected.'
        : '',
    pairwise: pairwiseComparisons,
  };

  const lowConfidence = scoredRows.some((row) => {
    const confidence = toNumber(row.confidence_score, null);
    return confidence !== null && confidence < REVIEW_CONFIDENCE_THRESHOLD;
  });
  const suspiciousReuseBySha = beforeRows.some((before) => {
    const hash = String(before.sha256 || '').trim().toLowerCase();
    if (!hash) return false;
    return afterRows.some(
      (after) => String(after.sha256 || '').trim().toLowerCase() === hash
    );
  });
  const suspiciousReuseByPerceptualHash = afterRows.some((after) => {
    const similarity = toNumber(after.similarity_score, null);
    return similarity !== null && similarity >= runtimeConfig.analysis.fraudSimilarityThreshold;
  });
  const qualityInvalid = evidenceRows.some(
    (row) =>
      String(row.image_quality_status || '')
        .trim()
        .toLowerCase() !== 'ok' &&
      String(row.image_quality_status || '')
        .trim()
        .toLowerCase() !== 'unknown'
  );
  const validationFailedCount = evidenceRows.filter((row) =>
    String(row.validation_status || '')
      .trim()
      .toUpperCase()
      .startsWith('FAILED')
  ).length;
  const rejectedImageCount = evidenceRows.filter((row) =>
    Boolean(row.scoring_rejected) ||
    String(row.validation_status || '')
      .trim()
      .toUpperCase() === 'REJECTED_LOW_CONFIDENCE'
  ).length;
  const hasBefore = beforeRows.length > 0;
  const hasAfter = afterRows.length > 0;
  const noMeaningfulImprovement =
    pairwiseComparisons.length > 0
      ? pairNoMeaningfulImprovement
      : improvementScore !== null && improvementScore < IMPROVEMENT_THRESHOLD;
  const noImprovementDetected =
    pairwiseComparisons.length > 0
      ? pairNoMeaningfulImprovement
      : improvementScore !== null &&
        avgBeforeScore !== null &&
        avgAfterScore !== null &&
        avgAfterScore <= avgBeforeScore;
  const visibleFecesDetected = evidenceRows.some((row) => {
    const scoring = getAiScoringMetadata(row);
    return scoring?.critical_findings?.visible_feces_or_potty === true;
  });
  const severeRiskDetected = evidenceRows.some((row) => {
    const scoring = getAiScoringMetadata(row);
    return String(scoring?.hygiene_risk || '').trim().toLowerCase() === 'severe';
  });
  const retakeRequiredDetected = evidenceRows.some((row) => {
    const scoring = getAiScoringMetadata(row);
    return scoring?.requires_retake === true;
  });
  const afterBelow40 = afterScored.some((row) => {
    const score = getScoreFromRow(row);
    return score !== null && score < 40;
  });
  const supervisorFlags = new Set();
  if (visibleFecesDetected) supervisorFlags.add('SEVERE_HYGIENE_ISSUE');
  if (severeRiskDetected) supervisorFlags.add('SEVERE_HYGIENE_ISSUE');
  if (afterBelow40) supervisorFlags.add('AI_REVIEW_REQUIRED');
  if (suspiciousReuseBySha || suspiciousReuseByPerceptualHash) supervisorFlags.add('SUSPICIOUS_IMPROVEMENT');
  if (pairNoMeaningfulImprovement || noImprovementDetected) supervisorFlags.add('AI_REVIEW_REQUIRED');
  if (pairSameToiletFalse) supervisorFlags.add('SUSPICIOUS_IMPROVEMENT');
  if (retakeRequiredDetected || lowConfidence) supervisorFlags.add('RETAKE_REQUIRED');

  const suspiciousReasons = [];
  if (suspiciousReuseBySha || suspiciousReuseByPerceptualHash) {
    suspiciousReasons.push('possible_fake_cleaning_similar_images');
    suspiciousReasons.push('duplicate_before_after_image');
  }
  if (noImprovementDetected || pairNoMeaningfulImprovement) {
    suspiciousReasons.push('no_improvement_detected');
    suspiciousReasons.push('no_meaningful_improvement');
  }
  if (pairSameToiletFalse) suspiciousReasons.push('same_toilet_unlikely');
  if (pairSuspiciousChange) suspiciousReasons.push('suspicious_pairwise_change');
  if (visibleFecesDetected) suspiciousReasons.push('visible_feces_detected');
  if (retakeRequiredDetected) suspiciousReasons.push('retake_required');
  if (severeRiskDetected) suspiciousReasons.push('severe_hygiene_risk');
  const suspiciousReasonsUnique = Array.from(new Set(suspiciousReasons));
  const suspiciousFlag = suspiciousReasonsUnique.length > 0;

  const reviewRequired =
    evidenceRows.some((row) => Boolean(row.review_required)) ||
    lowConfidence ||
    suspiciousReuseBySha ||
    suspiciousReuseByPerceptualHash ||
    qualityInvalid ||
    validationFailedCount > 0 ||
    rejectedImageCount > 0 ||
    !hasBefore ||
    !hasAfter ||
    noMeaningfulImprovement ||
    visibleFecesDetected ||
    severeRiskDetected ||
    retakeRequiredDetected ||
    afterBelow40 ||
    pairSameToiletFalse;

  const completedImages = evidenceRows.filter(
    (row) =>
      String(row.processing_state || '').toLowerCase() === 'ai_completed' ||
      String(row.ai_status || '').toUpperCase() === 'AI_COMPLETED'
  ).length;
  const processingImages = evidenceRows.filter(
    (row) =>
      ['ai_processing', 'queued_for_ai', 'ai_retrying'].includes(
        String(row.processing_state || '').toLowerCase()
      ) ||
      ['AI_PROCESSING', 'AI_QUEUED'].includes(
        String(row.ai_status || '').toUpperCase()
      )
  ).length;
  const retryingImages = evidenceRows.filter(
    (row) => String(row.processing_state || '').toLowerCase() === 'ai_retrying'
  ).length;
  const failedTransientImages = evidenceRows.filter(
    (row) => String(row.processing_state || '').toLowerCase() === 'ai_failed_transient'
  ).length;
  const failedPermanentImages = evidenceRows.filter(
    (row) =>
      ['ai_failed_permanent', 'upload_failed_permanent'].includes(
        String(row.processing_state || '').toLowerCase()
      )
  ).length;
  const manualReviewImages = evidenceRows.filter(
    (row) => String(row.processing_state || '').toLowerCase() === 'manual_review_required'
  ).length;
  const failedImages = evidenceRows.filter(
    (row) =>
      ['AI_FAILED'].includes(String(row.ai_status || '').toUpperCase()) ||
      ['ai_failed_permanent', 'manual_review_required', 'upload_failed_permanent'].includes(
        String(row.processing_state || '').toLowerCase()
      )
  ).length;
  const totalImages = evidenceRows.length;
  const lifecycleCounters = {
    valid_scored: completedImages,
    processing: processingImages,
    retrying: retryingImages,
    failed_transient: failedTransientImages,
    failed_permanent: failedPermanentImages,
    manual_review: manualReviewImages,
    total: totalImages,
  };

  const status = resolveInspectionStatus({
    inspection,
    totalImages,
    completedImages,
    processingImages,
    failedImages,
    reviewRequired,
  });
  const inspectionResult = resolveInspectionResult({
    hasBefore,
    hasAfter,
    improvementScore,
  });

  const scoredOverallScores = scoredRows
    .map((row) => toNumber(row.overall_score, null))
    .filter((s) => s !== null);
  const hygieneAvgAllImages =
    scoredOverallScores.length > 0 ? round2(mean(scoredOverallScores)) : null;
  const hygieneWorstImageScore =
    scoredOverallScores.length > 0 ? round2(Math.min(...scoredOverallScores)) : null;
  const hygieneFailAnyBelow40 = scoredRows.some((row) => {
    const s = toNumber(row.overall_score, null);
    return s !== null && s < 40;
  });

  const existingPipelineCounters =
    inspection.pipeline_counters && typeof inspection.pipeline_counters === 'object'
      ? inspection.pipeline_counters
      : {};
  const mergedPipelineCounters = {
    ...existingPipelineCounters,
    ...lifecycleCounters,
    hygiene_aggregate: {
      avg_all_images: hygieneAvgAllImages,
      worst_image_score: hygieneWorstImageScore,
      fail_any_below_40: hygieneFailAnyBelow40,
      scored_image_count: scoredRows.length,
    },
    ai_comparison_result: comparisonResult,
    ai_supervisor_flags: Array.from(supervisorFlags.values()),
  };

  await inspection.update(
    {
      status,
      before_image_count: beforeRows.length,
      after_image_count: afterRows.length,
      avg_before_score: avgBeforeScore,
      avg_after_score: avgAfterScore,
      improvement_score: improvementScore,
      confidence_avg: confidenceAvg,
      before_issue_tags: beforeIssueTags,
      after_issue_tags: afterIssueTags,
      resolved_issues: resolvedIssues,
      remaining_issues: remainingIssues,
      inspection_result: inspectionResult,
      review_required: reviewRequired,
      suspicious_flag: suspiciousFlag,
      suspicious_reasons: suspiciousReasonsUnique,
      validation_failed_count: validationFailedCount,
      rejected_image_count: rejectedImageCount,
      pipeline_counters: mergedPipelineCounters,
      last_scored_at: completedImages > 0 ? new Date() : inspection.last_scored_at,
      pipeline_status: resolvePipelineStatus(status),
      processing_status: resolveProcessingStatus(status),
      updated_at: new Date(),
    },
    { transaction }
  );

  if (updateToilet && inspection.toilet_unit_id) {
    await recomputeToiletAggregates(inspection.toilet_unit_id, { transaction });
  }

  return {
    inspectionId: inspection.id,
    status,
    processingStatus: resolveProcessingStatus(status),
    pipelineStatus: resolvePipelineStatus(status),
    beforeImageCount: beforeRows.length,
    afterImageCount: afterRows.length,
    avgBeforeScore,
    avgAfterScore,
    improvementScore,
    confidenceAvg,
    reviewRequired,
    inspectionResult,
    beforeIssueTags,
    afterIssueTags,
    resolvedIssues,
    remainingIssues,
    suspiciousFlag,
    suspiciousReasons: suspiciousReasonsUnique,
    validationFailedCount,
    rejectedImageCount,
    comparisonResult,
    supervisorFlags: Array.from(supervisorFlags.values()),
    pipelineCounters: {
      ...lifecycleCounters,
      ai_comparison_result: comparisonResult,
      ai_supervisor_flags: Array.from(supervisorFlags.values()),
    },
  };
};

const listInspectionImages = async (inspectionId, req) => {
  const inspection = await assertInspectionScope(inspectionId, req);
  const includeAdminDiagnostics = canViewAdminDiagnostics(req);
  let rows = await InspectionMedia.findAll({
    where: { inspection_id: inspectionId },
    order: [
      ['capture_stage', 'ASC'],
      ['ordinal', 'ASC'],
      ['captured_at', 'ASC'],
      ['created_at', 'ASC'],
    ],
  });
  rows = await requeueStaleImageAnalysis({
    inspection,
    rows,
    req,
  });
  const mediaUrlCache = new Map();
  const mapped = await Promise.all(
    dedupeInspectionMediaRows(rows).map((row) =>
      mapMediaEvidence(row, { mediaUrlCache, includeAdminDiagnostics })
    )
  );
  return {
    inspectionId,
    beforeImages: mapped.filter((item) => item.stage === 'BEFORE'),
    afterImages: mapped.filter((item) => item.stage === 'AFTER'),
    images: mapped,
  };
};

const summarizeLifecycleCountersFromImages = (images = []) => {
  const counters = {
    valid_scored: 0,
    processing: 0,
    retrying: 0,
    failed_transient: 0,
    failed_permanent: 0,
    manual_review: 0,
    total: Array.isArray(images) ? images.length : 0,
  };
  for (const image of Array.isArray(images) ? images : []) {
    const state = String(image.processingState || '').trim().toLowerCase();
    if (state === IMAGE_PROCESSING_STATES.AI_COMPLETED) counters.valid_scored += 1;
    if (
      state === IMAGE_PROCESSING_STATES.QUEUED_FOR_AI ||
      state === IMAGE_PROCESSING_STATES.AI_PROCESSING
    ) {
      counters.processing += 1;
    }
    if (state === IMAGE_PROCESSING_STATES.AI_RETRYING) counters.retrying += 1;
    if (state === IMAGE_PROCESSING_STATES.AI_FAILED_TRANSIENT) counters.failed_transient += 1;
    if (state === IMAGE_PROCESSING_STATES.AI_FAILED_PERMANENT) counters.failed_permanent += 1;
    if (state === IMAGE_PROCESSING_STATES.UPLOAD_FAILED_PERMANENT) counters.failed_permanent += 1;
    if (state === IMAGE_PROCESSING_STATES.MANUAL_REVIEW_REQUIRED) counters.manual_review += 1;
  }
  return counters;
};

const listInspectionImageJobs = async (inspectionId, req) => {
  const inspection = await assertInspectionScope(inspectionId, req);
  const includeAdminDiagnostics = canViewAdminDiagnostics(req);
  let rows = await InspectionMedia.findAll({
    where: { inspection_id: inspectionId },
    order: [
      ['capture_stage', 'ASC'],
      ['ordinal', 'ASC'],
      ['captured_at', 'ASC'],
      ['created_at', 'ASC'],
    ],
  });
  rows = await requeueStaleImageAnalysis({
    inspection,
    rows,
    req,
  });

  const mediaUrlCache = new Map();
  const mapped = await Promise.all(
    dedupeInspectionMediaRows(rows).map((row) =>
      mapMediaEvidence(row, { mediaUrlCache, includeAdminDiagnostics })
    )
  );
  const pipelineCounters =
    inspection.pipeline_counters && typeof inspection.pipeline_counters === 'object'
      ? inspection.pipeline_counters
      : summarizeLifecycleCountersFromImages(mapped);

  const jobs = mapped.map((image) => ({
    imageId: image.id,
    clientImageId: image.clientImageId,
    stage: image.stage,
    capturedAt: image.capturedAt,
    uploadStatus: image.uploadStatus,
    storageStatus: image.storageVerifiedAt ? 'verified' : image.uploadStatus || 'pending',
    processingState: image.processingState,
    aiStatus: image.aiStatus,
    retryCount: image.retryCount,
    aiAttemptCount: image.aiAttemptCount,
    nextRetryAt: image.nextRetryAt,
    lastRetryAt: image.lastRetryAt,
    score: image.score,
    validationStatus: image.validationStatus,
    validationReason: image.validationReason,
    workerStatusMessage: image.workerStatusMessage,
    ...(includeAdminDiagnostics
      ? {
          lastErrorCode: image.lastErrorCode,
          lastErrorMessage: image.lastErrorMessage,
        }
      : {}),
  }));

  return {
    inspectionId,
    pipelineCounters,
    jobs,
  };
};

const getInspectionImage = async (imageId, req) => {
  const row = await InspectionMedia.findByPk(imageId, {
    include: [{ model: Inspection, attributes: ['id', 'tenant_id', 'toilet_unit_id'] }],
  });
  if (!row || !row.Inspection) {
    throw new AppError('Inspection image not found', 404, { code: 'IMAGE_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && row.Inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection image out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return mapMediaEvidence(row, {
    includeAdminDiagnostics: canViewAdminDiagnostics(req),
  });
};

const triggerInspectionImageAi = async (imageId, req) => {
  const { enqueueInspectionAnalysis } = require('../analysis/analysis.queue');
  const row = await InspectionMedia.findByPk(imageId, {
    include: [{ model: Inspection, attributes: ['id', 'tenant_id', 'toilet_unit_id'] }],
  });
  if (!row || !row.Inspection) {
    throw new AppError('Inspection image not found', 404, { code: 'IMAGE_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && row.Inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection image out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  await row.update({
    ai_status: 'AI_QUEUED',
    processing_state: IMAGE_PROCESSING_STATES.QUEUED_FOR_AI,
    ai_error: null,
    validation_status: 'PENDING',
    validation_reason: null,
    scoring_rejected: false,
    last_error_code: null,
    last_error_message: null,
    next_retry_at: null,
    updated_at: new Date(),
  });

  await InspectionEvent.create({
    tenant_id: row.Inspection.tenant_id,
    inspection_id: row.inspection_id,
    toilet_id: row.toilet_unit_id || row.Inspection.toilet_unit_id || null,
    image_id: row.id,
    event_type: 'inspection.image.ai_queued',
    event_status: 'AI_QUEUED',
    source: 'api',
    actor_user_id: req.user.id,
    payload: {
      imageId: row.id,
    },
    occurred_at: new Date(),
  });

  const queued = await enqueueInspectionAnalysis({
    inspectionId: row.inspection_id,
    imageId: row.id,
    tenantId: row.Inspection.tenant_id,
    jobType: 'AI_ANALYSIS',
    requestContext: {
      requestId: req.requestId,
      ip: req.ip,
      user: {
        id: req.user.id,
        tenantId: req.user.tenantId,
        isSuperAdmin: Boolean(req.user.isSuperAdmin),
      },
    },
  });

  return {
    imageId: row.id,
    inspectionId: row.inspection_id,
    aiStatus: 'AI_QUEUED',
    queue: queued,
  };
};

const listToiletInspections = async (toiletId, req, { page = 1, limit = 20 } = {}) => {
  const unit = await assertToiletScope(toiletId, req);
  const safePage = Math.max(Number(page) || 1, 1);
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const offset = (safePage - 1) * safeLimit;

  const { rows, count } = await Inspection.findAndCountAll({
    where: { toilet_unit_id: toiletId },
    include: [
      {
        model: PlatformUser,
        as: 'inspector',
        attributes: ['id', 'full_name', 'employee_code'],
        required: false,
      },
    ],
    order: [['submitted_at', 'DESC'], ['captured_at', 'DESC']],
    limit: safeLimit,
    offset,
  });

  const inspectionIds = rows.map((row) => row.id);
  const [mediaByInspection, aiByInspection] = await Promise.all([
    buildInspectionMediaMap(inspectionIds),
    buildLatestAiResultMap(inspectionIds),
  ]);

  return {
    toiletId,
    toiletCode: unit.code,
    items: rows.map((row) => {
      const derived = buildInspectionMetrics({
        inspectionType: row.inspection_type,
        persisted: {
          beforeImageCount: row.before_image_count,
          afterImageCount: row.after_image_count,
          avgBeforeScore: row.avg_before_score,
          avgAfterScore: row.avg_after_score,
          improvementScore: row.improvement_score,
          confidenceAvg: row.confidence_avg,
          reviewRequired: row.review_required,
          inspectionResult: row.inspection_result,
          beforeIssueTags: row.before_issue_tags,
          afterIssueTags: row.after_issue_tags,
          resolvedIssues: row.resolved_issues,
          remainingIssues: row.remaining_issues,
          suspiciousFlag: row.suspicious_flag,
          suspiciousReasons: row.suspicious_reasons,
          validationFailedCount: row.validation_failed_count,
          rejectedImageCount: row.rejected_image_count,
        },
        mediaRows: mediaByInspection.get(String(row.id)) || [],
        aiResult: aiByInspection.get(String(row.id)) || null,
      });

      return {
        id: row.id,
        submittedAt: row.submitted_at,
        capturedAt: row.captured_at,
        worker: row.inspector
          ? {
              id: row.inspector.id,
              name: row.inspector.full_name,
              employeeCode: row.inspector.employee_code || null,
            }
          : null,
        beforeImageCount: derived.beforeImageCount,
        afterImageCount: derived.afterImageCount,
        avgBeforeScore: derived.avgBeforeScore,
        avgAfterScore: derived.avgAfterScore,
        improvementScore: derived.improvementScore,
        confidenceAvg: derived.confidenceAvg,
        reviewRequired: derived.reviewRequired,
        inspectionResult: derived.inspectionResult,
        beforeIssueTags: derived.beforeIssueTags,
        afterIssueTags: derived.afterIssueTags,
        resolvedIssues: derived.resolvedIssues,
        remainingIssues: derived.remainingIssues,
        suspiciousFlag: derived.suspiciousFlag,
        suspiciousReasons: derived.suspiciousReasons,
        validationFailedCount: derived.validationFailedCount,
        rejectedImageCount: derived.rejectedImageCount,
        status: row.status || (row.submitted_at ? 'SUBMITTED' : 'IN_PROGRESS'),
        scoreLabel: scoreLabel(derived.avgAfterScore ?? derived.avgBeforeScore),
      };
    }),
    meta: {
      page: safePage,
      limit: safeLimit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / safeLimit)),
    },
  };
};

const getInspectionComparison = async (inspectionId, req) => {
  const inspection = await assertInspectionScope(inspectionId, req, {
    include: [{ model: InspectionMedia }],
  });
  const includeAdminDiagnostics = canViewAdminDiagnostics(req);

  const refreshedRows = await requeueStaleImageAnalysis({
    inspection,
    rows: Array.isArray(inspection.InspectionMedia) ? inspection.InspectionMedia : [],
    req,
  });
  const evidenceRows = dedupeInspectionMediaRows(refreshedRows);
  const beforeRows = evidenceRows.filter((item) => stageOf(item) === 'before');
  const afterRows = evidenceRows.filter((item) => stageOf(item) === 'after');
  const mediaUrlCache = new Map();
  const [beforeImages, afterImages] = await Promise.all([
    Promise.all(
      beforeRows.map((row) =>
        mapMediaEvidence(row, { mediaUrlCache, includeAdminDiagnostics })
      )
    ),
    Promise.all(
      afterRows.map((row) =>
        mapMediaEvidence(row, { mediaUrlCache, includeAdminDiagnostics })
      )
    ),
  ]);

  const beforeByOrdinal = new Map();
  const beforeRawByOrdinal = new Map();
  const afterRawByOrdinal = new Map();
  for (const row of beforeRows) {
    const ordinal = toNumber(row.ordinal, null);
    if (ordinal !== null) beforeRawByOrdinal.set(Number(ordinal), row);
  }
  for (const row of afterRows) {
    const ordinal = toNumber(row.ordinal, null);
    if (ordinal !== null) afterRawByOrdinal.set(Number(ordinal), row);
  }
  for (const image of beforeImages) {
    if (image.ordinal !== null && image.ordinal !== undefined) {
      beforeByOrdinal.set(Number(image.ordinal), image);
    }
  }

  const pairs = [];
  for (const image of afterImages) {
    const ordinal =
      image.ordinal !== null && image.ordinal !== undefined ? Number(image.ordinal) : null;
    if (ordinal === null || !beforeByOrdinal.has(ordinal)) {
      continue;
    }
    const before = beforeByOrdinal.get(ordinal);
    const beforeRaw = beforeRawByOrdinal.get(ordinal) || null;
    const afterRaw = afterRawByOrdinal.get(ordinal) || null;
    const beforeScore = toNumber(before?.score, null);
    const afterScore = toNumber(image?.score, null);
    const delta =
      beforeScore !== null && afterScore !== null ? round2(afterScore - beforeScore) : null;
    const beforeAi = getAiScoringMetadata(beforeRaw);
    const afterAi = getAiScoringMetadata(afterRaw);
    const duplicateDetected =
      String(beforeRaw?.sha256 || '').trim().toLowerCase() &&
      String(beforeRaw?.sha256 || '').trim().toLowerCase() ===
        String(afterRaw?.sha256 || '').trim().toLowerCase();
    const pairEval =
      beforeScore !== null && afterScore !== null
        ? evaluatePairwiseComparison({
            before_score_0_100: beforeScore,
            after_score_0_100: afterScore,
            before_critical_findings: beforeAi?.critical_findings || before?.criticalFindings || null,
            after_critical_findings: afterAi?.critical_findings || image?.criticalFindings || null,
            similarities:
              toNumber(image?.similarityScore, null) !== null
                ? [toNumber(image.similarityScore, 0)]
                : [],
            duplicate_detected: Boolean(duplicateDetected),
            same_toilet_likely: null,
          })
        : null;
    pairs.push({
      ordinal,
      before,
      after: image,
      delta,
      beforeScore,
      afterScore,
      ...(pairEval
        ? {
            imageAngleSimilarity: pairEval.image_angle_similarity,
            cleanlinessDifferenceDetected: pairEval.cleanliness_difference_detected,
            improvementLevel: pairEval.improvement_level,
            shouldAcceptImprovement: pairEval.should_accept_improvement,
            sameToiletLikely: pairEval.same_toilet_likely,
            suspiciousChangeDetected: pairEval.suspicious_change_detected,
            suspiciousReason: pairEval.suspicious_reason || null,
            comparisonReason: pairEval.comparison_reason || null,
            remainingCriticalIssuesAfter: pairEval.remaining_critical_issues_after,
            beforeStarRating0To5: pairEval.before_star_rating_0_5,
            afterStarRating0To5: pairEval.after_star_rating_0_5,
            scoreDelta: pairEval.score_delta,
          }
        : {}),
    });
  }

  const beforeAvg =
    toNumber(inspection.avg_before_score, null) ??
    round2(mean(beforeRows.map((item) => toNumber(item.overall_score, null))));
  const afterAvg =
    toNumber(inspection.avg_after_score, null) ??
    round2(mean(afterRows.map((item) => toNumber(item.overall_score, null))));
  const improvement =
    toNumber(inspection.improvement_score, null) ??
    (beforeAvg !== null && afterAvg !== null ? round2(afterAvg - beforeAvg) : null);
  const pipelineCounters =
    inspection.pipeline_counters && typeof inspection.pipeline_counters === 'object'
      ? inspection.pipeline_counters
      : {};
  const comparisonResult =
    pipelineCounters.ai_comparison_result &&
    typeof pipelineCounters.ai_comparison_result === 'object'
      ? pipelineCounters.ai_comparison_result
      : null;
  const supervisorFlags = Array.isArray(pipelineCounters.ai_supervisor_flags)
    ? pipelineCounters.ai_supervisor_flags
    : [];
  const derivedHygieneRisk = afterImages.reduce((risk, image) => {
    const nextRisk = String(image?.hygieneRisk || '').trim().toLowerCase();
    if (!nextRisk) return risk;
    if (nextRisk === 'severe') return 'severe';
    if (nextRisk === 'high' && risk !== 'severe') return 'high';
    if (nextRisk === 'medium' && !['severe', 'high'].includes(risk)) return 'medium';
    if (nextRisk === 'low' && !risk) return 'low';
    return risk;
  }, '');
  const summaryStarRating =
    afterAvg !== null ? starRatingFromScore(afterAvg) : beforeAvg !== null ? starRatingFromScore(beforeAvg) : null;
  const summaryStatus = scoreStatusFromSignals({
    score: afterAvg ?? beforeAvg,
    hygieneRisk: derivedHygieneRisk || null,
    requiresRetake: afterImages.some((image) => Boolean(image?.requiresRetake)),
    suspicious: Boolean(inspection.suspicious_flag) || supervisorFlags.includes('SUSPICIOUS_IMPROVEMENT'),
  });

  return {
    inspectionId: inspection.id,
    summary: {
      avgBeforeScore: beforeAvg,
      avgAfterScore: afterAvg,
      improvementScore: improvement,
      beforeStarRating0To5: beforeAvg !== null ? starRatingFromScore(beforeAvg) : null,
      afterStarRating0To5: summaryStarRating,
      hygieneRisk: derivedHygieneRisk || null,
      status: summaryStatus,
      scoreLabelBefore: scoreLabel(beforeAvg),
      scoreLabelAfter: scoreLabel(afterAvg),
      inspectionResult: inspection.inspection_result || null,
      confidenceAvg: toNumber(inspection.confidence_avg, null),
      reviewRequired: Boolean(inspection.review_required),
      suspiciousFlag: Boolean(inspection.suspicious_flag),
      suspiciousReasons: Array.isArray(inspection.suspicious_reasons)
        ? inspection.suspicious_reasons
        : [],
      validationFailedCount: Number(inspection.validation_failed_count || 0),
      rejectedImageCount: Number(inspection.rejected_image_count || 0),
      comparisonResult,
      supervisorFlags,
    },
    grouped: {
      beforeImages,
      afterImages,
    },
    pairs,
    issues: {
      before: Array.isArray(inspection.before_issue_tags) ? inspection.before_issue_tags : [],
      after: Array.isArray(inspection.after_issue_tags) ? inspection.after_issue_tags : [],
      resolved: Array.isArray(inspection.resolved_issues) ? inspection.resolved_issues : [],
      remaining: Array.isArray(inspection.remaining_issues) ? inspection.remaining_issues : [],
    },
  };
};

const getToiletLatestInspection = async (toiletId, req) => {
  await assertToiletScope(toiletId, req);
  const includeAdminDiagnostics = canViewAdminDiagnostics(req);
  const latest = await Inspection.findOne({
    where: { toilet_unit_id: toiletId },
    include: [
      {
        model: PlatformUser,
        as: 'inspector',
        attributes: ['id', 'full_name', 'employee_code'],
        required: false,
      },
      {
        model: InspectionMedia,
      },
    ],
    order: [['submitted_at', 'DESC'], ['captured_at', 'DESC']],
  });
  if (!latest) return null;

  const refreshedRows = await requeueStaleImageAnalysis({
    inspection: latest,
    rows: Array.isArray(latest.InspectionMedia) ? latest.InspectionMedia : [],
    req,
  });
  const media = dedupeInspectionMediaRows(refreshedRows);
  const aiByInspection = await buildLatestAiResultMap([latest.id]);
  const derived = buildInspectionMetrics({
    inspectionType: latest.inspection_type,
    persisted: {
      beforeImageCount: latest.before_image_count,
      afterImageCount: latest.after_image_count,
      avgBeforeScore: latest.avg_before_score,
      avgAfterScore: latest.avg_after_score,
      improvementScore: latest.improvement_score,
      confidenceAvg: latest.confidence_avg,
      reviewRequired: latest.review_required,
      inspectionResult: latest.inspection_result,
      beforeIssueTags: latest.before_issue_tags,
      afterIssueTags: latest.after_issue_tags,
      resolvedIssues: latest.resolved_issues,
      remainingIssues: latest.remaining_issues,
      suspiciousFlag: latest.suspicious_flag,
      suspiciousReasons: latest.suspicious_reasons,
      validationFailedCount: latest.validation_failed_count,
      rejectedImageCount: latest.rejected_image_count,
    },
    mediaRows: media,
    aiResult: aiByInspection.get(String(latest.id)) || null,
  });
  const mediaUrlCache = new Map();
  const [beforeImages, afterImages] = await Promise.all([
    Promise.all(
      media
        .filter((item) => stageOf(item) === 'before')
        .map((row) =>
          mapMediaEvidence(row, { mediaUrlCache, includeAdminDiagnostics })
        )
    ),
    Promise.all(
      media
        .filter((item) => stageOf(item) === 'after')
        .map((row) =>
          mapMediaEvidence(row, { mediaUrlCache, includeAdminDiagnostics })
        )
    ),
  ]);

  return {
    id: latest.id,
    submittedAt: latest.submitted_at,
    capturedAt: latest.captured_at,
    worker: latest.inspector
      ? {
          id: latest.inspector.id,
          name: latest.inspector.full_name,
          employeeCode: latest.inspector.employee_code || null,
        }
      : null,
    avgBeforeScore: derived.avgBeforeScore,
    avgAfterScore: derived.avgAfterScore,
    improvementScore: derived.improvementScore,
    scoreLabelBefore: scoreLabel(derived.avgBeforeScore),
    scoreLabelAfter: scoreLabel(derived.avgAfterScore),
    confidenceAvg: derived.confidenceAvg,
    status: latest.status || null,
    inspectionResult: derived.inspectionResult,
    reviewRequired: derived.reviewRequired,
    beforeIssueTags: derived.beforeIssueTags,
    afterIssueTags: derived.afterIssueTags,
    imageCount: beforeImages.length + afterImages.length,
    suspiciousFlag: derived.suspiciousFlag,
    suspiciousReasons: derived.suspiciousReasons,
    validationFailedCount: derived.validationFailedCount,
    rejectedImageCount: derived.rejectedImageCount,
    beforeImages,
    afterImages,
    resolvedIssues: derived.resolvedIssues,
    remainingIssues: derived.remainingIssues,
  };
};

const getToiletInspectionHistory = async (toiletId, req, { page = 1, limit = 30 } = {}) => {
  return listToiletInspections(toiletId, req, { page, limit });
};

const getToiletScoreTrends = async (toiletId, req, { days = 30 } = {}) => {
  await assertToiletScope(toiletId, req);
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 180);

  const rows = await ToiletScoreDaily.findAll({
    where: { toilet_id: toiletId },
    order: [['date', 'DESC']],
    limit: safeDays,
  });

  const points = rows
    .map((row) => ({
      date: row.date,
      avgBeforeScore: toNumber(row.avg_before_score, null),
      avgAfterScore: toNumber(row.avg_after_score, null),
      avgImprovement: toNumber(row.avg_improvement, null),
      inspectionCount: Number(row.inspection_count || 0),
      dirtyCount: Number(row.dirty_count || 0),
      cleanedCount: Number(row.cleaned_count || 0),
    }))
    .reverse();

  const hasInformativePoints = points.some(
    (point) =>
      point.avgBeforeScore !== null ||
      point.avgAfterScore !== null ||
      point.avgImprovement !== null
  );

  if (hasInformativePoints) {
    return {
      toiletId,
      points,
    };
  }

  const fallbackInspections = await Inspection.findAll({
    where: { toilet_unit_id: toiletId },
    attributes: [
      'id',
      'inspection_type',
      'captured_at',
      'submitted_at',
      'before_image_count',
      'after_image_count',
      'avg_before_score',
      'avg_after_score',
      'improvement_score',
      'confidence_avg',
      'inspection_result',
      'review_required',
      'before_issue_tags',
      'after_issue_tags',
      'resolved_issues',
      'remaining_issues',
    ],
    order: [['submitted_at', 'DESC'], ['captured_at', 'DESC']],
    limit: safeDays * 8,
  });

  const inspectionIds = fallbackInspections.map((row) => row.id);
  const [mediaByInspection, aiByInspection] = await Promise.all([
    buildInspectionMediaMap(inspectionIds),
    buildLatestAiResultMap(inspectionIds),
  ]);

  const grouped = new Map();
  for (const row of fallbackInspections) {
    const derived = buildInspectionMetrics({
      inspectionType: row.inspection_type,
      persisted: {
        beforeImageCount: row.before_image_count,
        afterImageCount: row.after_image_count,
        avgBeforeScore: row.avg_before_score,
        avgAfterScore: row.avg_after_score,
        improvementScore: row.improvement_score,
        confidenceAvg: row.confidence_avg,
        reviewRequired: row.review_required,
        inspectionResult: row.inspection_result,
        beforeIssueTags: row.before_issue_tags,
        afterIssueTags: row.after_issue_tags,
        resolvedIssues: row.resolved_issues,
        remainingIssues: row.remaining_issues,
      },
      mediaRows: mediaByInspection.get(String(row.id)) || [],
      aiResult: aiByInspection.get(String(row.id)) || null,
    });

    const dateKey = normalizeDateKey(row.submitted_at || row.captured_at);
    if (!dateKey) continue;
    if (!grouped.has(dateKey)) {
      grouped.set(dateKey, {
        date: dateKey,
        beforeScores: [],
        afterScores: [],
        improvementScores: [],
        inspectionCount: 0,
        dirtyCount: 0,
        cleanedCount: 0,
      });
    }
    const entry = grouped.get(dateKey);
    entry.inspectionCount += 1;
    if (derived.avgBeforeScore !== null) {
      entry.beforeScores.push(derived.avgBeforeScore);
      if (derived.avgBeforeScore <= 50) entry.dirtyCount += 1;
    }
    if (derived.avgAfterScore !== null) {
      entry.afterScores.push(derived.avgAfterScore);
      if (derived.avgAfterScore >= 71) entry.cleanedCount += 1;
    }
    if (derived.improvementScore !== null) {
      entry.improvementScores.push(derived.improvementScore);
    }
  }

  const fallbackPoints = Array.from(grouped.values())
    .sort((left, right) => String(left.date).localeCompare(String(right.date)))
    .slice(-safeDays)
    .map((entry) => ({
      date: entry.date,
      avgBeforeScore: round2(mean(entry.beforeScores)),
      avgAfterScore: round2(mean(entry.afterScores)),
      avgImprovement: round2(mean(entry.improvementScores)),
      inspectionCount: entry.inspectionCount,
      dirtyCount: entry.dirtyCount,
      cleanedCount: entry.cleanedCount,
    }));

  return {
    toiletId,
    points: fallbackPoints,
  };
};

const getToiletDetails = async (toiletId, req) => {
  const unit = await assertToiletScope(toiletId, req);
  await ensureAllQrImagesForToilet({
    toiletUnitId: unit.id,
    appQrCodeValue: unit.qr_code || unit.code,
    feedbackQrValue: getPublicFeedbackUrl({ toiletUnitId: unit.id }),
  }).catch(() => null);
  const latestInspection = await getToiletLatestInspection(toiletId, req);
  const history = await getToiletInspectionHistory(toiletId, req, { page: 1, limit: 50 });
  const trends = await getToiletScoreTrends(toiletId, req, { days: 30 });

  const historyItems = Array.isArray(history.items) ? history.items : [];
  const beforeScores = historyItems
    .map((item) => toNumber(item.avgBeforeScore, null))
    .filter((item) => item !== null);
  const afterScores = historyItems
    .map((item) => toNumber(item.avgAfterScore, null))
    .filter((item) => item !== null);
  const improvementScores = historyItems
    .map((item) => toNumber(item.improvementScore, null))
    .filter((item) => item !== null);

  const historyBeforeAvg = round2(mean(beforeScores));
  const historyAfterAvg = round2(mean(afterScores));
  const historyImprovementAvg = round2(mean(improvementScores));

  const persistedTotalInspections = Number(unit.total_inspections || 0);
  const derivedTotalInspections = historyItems.length;
  const totalInspections =
    persistedTotalInspections > 0 ? persistedTotalInspections : derivedTotalInspections;

  const historyLatest = historyItems[0] || null;
  const latestBeforeFromHistory = toNumber(historyLatest?.avgBeforeScore, null);
  const latestAfterFromHistory = toNumber(historyLatest?.avgAfterScore, null);

  const latestBeforeScore =
    toNumber(unit.latest_before_score, null) ?? latestBeforeFromHistory;
  const latestAfterScore =
    toNumber(unit.latest_after_score, null) ?? latestAfterFromHistory;
  const latestScore =
    toNumber(unit.latest_score, null) ??
    latestAfterScore ??
    latestBeforeScore ??
    toNumber(latestInspection?.avgAfterScore, null) ??
    toNumber(latestInspection?.avgBeforeScore, null);

  const avgBeforeScore =
    (toNumber(unit.avg_before_score, null) === 0 &&
    persistedTotalInspections === 0 &&
    historyBeforeAvg !== null
      ? null
      : toNumber(unit.avg_before_score, null)) ?? historyBeforeAvg;
  const avgAfterScore =
    (toNumber(unit.avg_after_score, null) === 0 &&
    persistedTotalInspections === 0 &&
    historyAfterAvg !== null
      ? null
      : toNumber(unit.avg_after_score, null)) ?? historyAfterAvg;
  const avgImprovementScore =
    (toNumber(unit.avg_improvement_score, null) === 0 &&
    persistedTotalInspections === 0 &&
    historyImprovementAvg !== null
      ? null
      : toNumber(unit.avg_improvement_score, null)) ?? historyImprovementAvg;

  const baselineScore = resolveBaselineScore({
    totalInspections,
    avgAfterScore,
    latestScore,
  });
  const baselineScoreLabel = scoreLabel(baselineScore);
  const baselineConfidence = resolveBaselineConfidence(totalInspections);

  const historyDirtyCount = historyItems.filter((item) => {
    const value = toNumber(item.avgBeforeScore, null);
    return value !== null && value <= 50;
  }).length;
  const historyLowPerformanceCount = historyItems.filter((item) => {
    const value = toNumber(item.improvementScore, null);
    return value !== null && value < IMPROVEMENT_THRESHOLD;
  }).length;

  const derivedDirtyFrequency =
    totalInspections > 0 ? round2((historyDirtyCount / totalInspections) * 100) : 0;
  const derivedLowPerformanceFrequency =
    totalInspections > 0 ? round2((historyLowPerformanceCount / totalInspections) * 100) : 0;

  const dirtyFrequency =
    (toNumber(unit.dirty_frequency, null) === 0 &&
    persistedTotalInspections === 0 &&
    derivedDirtyFrequency !== null
      ? null
      : toNumber(unit.dirty_frequency, null)) ?? derivedDirtyFrequency;
  const lowPerformanceFrequency =
    (toNumber(unit.low_performance_frequency, null) === 0 &&
    persistedTotalInspections === 0 &&
    derivedLowPerformanceFrequency !== null
      ? null
      : toNumber(unit.low_performance_frequency, null)) ??
    derivedLowPerformanceFrequency;

  const suspiciousInspectionCount = historyItems.filter((item) =>
    Boolean(item.suspiciousFlag)
  ).length;
  const rejectedImageCount = historyItems.reduce(
    (sum, item) => sum + Number(item.rejectedImageCount || 0),
    0
  );
  const validationFailedCount = historyItems.reduce(
    (sum, item) => sum + Number(item.validationFailedCount || 0),
    0
  );

  const lastInspectionAt =
    unit.last_inspection_at ||
    latestInspection?.submittedAt ||
    latestInspection?.capturedAt ||
    historyLatest?.submittedAt ||
    historyLatest?.capturedAt ||
    null;

  const lastCleanedAt =
    unit.last_cleaned_at ||
    historyItems.find((item) => toNumber(item.avgAfterScore, null) !== null)?.submittedAt ||
    historyItems.find((item) => toNumber(item.avgAfterScore, null) !== null)?.capturedAt ||
    null;

  const events = await InspectionEvent.findAll({
    where: {
      [Op.or]: [{ toilet_id: toiletId }, { inspection_id: { [Op.in]: history.items.map((item) => item.id) } }],
    },
    include: [
      {
        model: PlatformUser,
        as: 'actor',
        attributes: ['id', 'full_name'],
        required: false,
      },
    ],
    order: [['occurred_at', 'DESC']],
    limit: 300,
  });

  const auditTrail = events.map((event) => ({
    id: event.id,
    inspectionId: event.inspection_id,
    imageId: event.image_id || null,
    eventType: event.event_type,
    eventStatus: event.event_status || null,
    occurredAt: event.occurred_at,
    source: event.source,
    actor: event.actor
      ? {
          id: event.actor.id,
          name: event.actor.full_name,
        }
      : null,
    payload: event.payload || null,
  }));

  return {
    toilet: {
      id: unit.id,
      code: unit.code,
      name: unit.code,
      qrCode: unit.qr_code || unit.code,
      appQrCode: unit.qr_code || unit.code,
      qrImageUrl: getQrImageUrl(unit.id),
      appQrImageUrl: getQrImageUrl(unit.id),
      feedbackQrImageUrl: getFeedbackQrImageUrl(unit.id),
      publicFeedbackUrl: getPublicFeedbackUrl({ toiletUnitId: unit.id }),
      sector:
        unit.sector_code ||
        unit.Facility?.metadata?.sector ||
        unit.Facility?.metadata?.zone ||
        null,
      location:
        unit.location_label ||
        unit.Facility?.address_line ||
        unit.Facility?.name ||
        unit.Facility?.code ||
        null,
      latitude:
        unit.latitude !== null && unit.latitude !== undefined
          ? Number(unit.latitude)
          : unit.Facility?.latitude !== null && unit.Facility?.latitude !== undefined
            ? Number(unit.Facility.latitude)
            : null,
      longitude:
        unit.longitude !== null && unit.longitude !== undefined
          ? Number(unit.longitude)
          : unit.Facility?.longitude !== null && unit.Facility?.longitude !== undefined
            ? Number(unit.Facility.longitude)
            : null,
      contractor: unit.Facility?.metadata?.contractor || null,
      status: unit.status,
      latestScore,
      latestScoreLabel: scoreLabel(latestScore),
      baselineScore,
      baselineScoreLabel,
      baselineConfidence,
      baselineMinInspections: BASELINE_MIN_INSPECTIONS,
      latestBeforeScore,
      latestAfterScore,
      avgBeforeScore,
      avgAfterScore,
      avgImprovementScore,
      latestImprovementScore: toNumber(latestInspection?.improvementScore, null),
      lastInspectionAt,
      lastCleanedAt,
      totalInspections,
      dirtyFrequency,
      lowPerformanceFrequency,
      suspiciousInspectionCount,
      rejectedImageCount,
      validationFailedCount,
      currentCleanlinessStatus: scoreLabel(latestScore),
      lastWorker: latestInspection?.worker || null,
    },
    latestInspection,
    history: history.items,
    trends,
    auditTrail,
  };
};

module.exports = {
  mapMediaEvidence,
  scoreLabel,
  recomputeInspectionAggregates,
  recomputeToiletAggregates,
  listInspectionImages,
  listInspectionImageJobs,
  getInspectionImage,
  triggerInspectionImageAi,
  listToiletInspections,
  getInspectionComparison,
  getToiletLatestInspection,
  getToiletInspectionHistory,
  getToiletScoreTrends,
  getToiletDetails,
};
