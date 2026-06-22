const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  Inspection,
  InspectionMedia,
  InspectionSubmission,
  InspectionEvent,
  Facility,
  ToiletUnit,
  InspectionTask,
  AiAnalysisResult,
  PlatformUser,
  AuditLog,
  SensorReading,
  SensorDevice,
} = require('../../models');
const { normalizePagination, sanitizeText, isUuid } = require('../../utils/validators');
const { uploadImage, removeTempFile } = require('../media/storage.service');
const {
  normalizeMediaUrl,
  resolveMediaUrl,
  resolveMediaPairUrls,
} = require('../media/mediaUrl.service');
const { enqueueInspectionAnalysis } = require('../analysis/analysis.queue');
const { createAuditLog } = require('../audit/audit.service');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
  isFacilityAccessibleForInspection,
  hasFieldInspectionRole,
} = require('../../core/rbac/scopeWhere');
const {
  resolveDateRange,
  applyDateRangeToWhere,
} = require('../../utils/dateRange');
const {
  recomputeInspectionAggregates,
  listInspectionImages,
  listInspectionImageJobs,
  getInspectionImage,
  triggerInspectionImageAi,
  listToiletInspections,
  getInspectionComparison,
  getToiletDetails,
  getToiletLatestInspection,
  getToiletScoreTrends,
  getToiletInspectionHistory,
} = require('./inspectionEvidence.service');
const {
  IMAGE_PROCESSING_STATES,
} = require('./imageLifecycle.constants');
const { runtimeConfig } = require('../../config/runtime');

const uniqueIds = (values = []) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];

const REVIEW_LABELS = {
  reviewed: 'Reviewed',
  accepted: 'Accepted',
  rejected: 'Rejected',
  reinspection_required: 'Reinspection Required',
};

const INSPECTION_TYPE_ALIASES = {
  routine: 'after_cleaning',
  regular: 'after_cleaning',
  after: 'after_cleaning',
  before: 'before_cleaning',
  complaint: 'complaint_based',
  complaint_based: 'complaint_based',
  surprise: 'surprise_audit',
};

const ALLOWED_INSPECTION_TYPES = new Set([
  'before_cleaning',
  'after_cleaning',
  'surprise_audit',
  'complaint_based',
]);
const PROCESSING_STATUSES = new Set(['draft', 'queued', 'processing', 'completed', 'failed']);
const INSPECTION_STATUSES = new Set([
  'DRAFT',
  'IN_PROGRESS',
  'SUBMITTED',
  'PARTIALLY_SCORED',
  'FULLY_SCORED',
  'REVIEW_REQUIRED',
  'COMPLETED',
]);

const isToiletDeletedForInspection = (unit) => Boolean(unit?.deleted_at || unit?.deletedAt);

const isToiletInactiveForInspection = (unit, facility = null) => {
  const unitStatus = String(unit?.status || '').trim().toLowerCase();
  const facilityStatus = String(facility?.status || '').trim().toLowerCase();
  if (facilityStatus && facilityStatus !== 'active') return true;
  return unitStatus === 'out_of_service' || unitStatus === 'inactive';
};

const assertToiletAvailableForInspection = (unit, facility = null) => {
  if (!unit) return;
  if (isToiletDeletedForInspection(unit)) {
    throw new AppError('This toilet is no longer available for inspection.', 410, {
      code: 'TOILET_DELETED',
    });
  }
  if (isToiletInactiveForInspection(unit, facility)) {
    throw new AppError('This toilet is inactive.', 409, {
      code: 'TOILET_INACTIVE',
    });
  }
};

const normalizeInspectionType = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    throw new AppError('inspectionType is required', 400, { code: 'VALIDATION_ERROR' });
  }

  const resolved = INSPECTION_TYPE_ALIASES[raw] || raw;
  if (!ALLOWED_INSPECTION_TYPES.has(resolved)) {
    throw new AppError(
      'inspectionType must be one of before_cleaning|after_cleaning|surprise_audit|complaint_based',
      400,
      { code: 'VALIDATION_ERROR' }
    );
  }
  return resolved;
};

const normalizeCaptureStage = (value) => {
  const normalized = String(value || 'evidence').trim().toLowerCase();
  if (normalized === 'before' || normalized === 'after' || normalized === 'evidence') {
    return normalized;
  }
  return 'evidence';
};

const normalizeClientImageId = (value) => {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 120);
  return normalized || null;
};

const parseOptionalDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const parseOptionalNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const normalizeSensorSnapshot = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const readingTime = snapshot.readingTime || snapshot.timestamp || snapshot.linkedAt || null;
  return {
    ...snapshot,
    // Field 1 is firmware-provided sensor channel (legacy "sensor toilet score"), NOT final cleanliness score.
    field1: toNumberOrNull(snapshot.field1 ?? snapshot.field_1 ?? snapshot.score ?? snapshot.sensorToiletScore),
    field2: toNumberOrNull(snapshot.field2 ?? snapshot.field_2 ?? snapshot.mq135),
    field3: toNumberOrNull(snapshot.field3 ?? snapshot.field_3 ?? snapshot.mq137),
    temperature: toNumberOrNull(snapshot.temperature),
    humidity: toNumberOrNull(snapshot.humidity),
    sensorToiletScore: toNumberOrNull(snapshot.sensorToiletScore ?? snapshot.score ?? snapshot.field1 ?? snapshot.field_1),
    readingTime: readingTime || null,
  };
};

const starFromScore = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const clamped = Math.min(Math.max(parsed, 0), 100);
  return Number((clamped / 20).toFixed(1));
};

const inspectionAiStatusFromSignals = ({
  score = null,
  hygieneRisk = null,
  requiresRetake = false,
  suspiciousFlag = false,
}) => {
  if (requiresRetake) return 'Retake Required';
  if (suspiciousFlag) return 'Suspicious Improvement';
  const risk = String(hygieneRisk || '').trim().toLowerCase();
  if (risk === 'severe') return 'Severe Hygiene Issue';
  const parsedScore = parseOptionalNumber(score);
  if (parsedScore === null) return 'Pending Analysis';
  if (parsedScore < 40) return 'Needs Cleaning';
  return 'Clean';
};

const parseOptionalObject = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
};

const isUniqueConstraintError = (error) => {
  const code = String(error?.original?.code || error?.parent?.code || '').trim();
  return error?.name === 'SequelizeUniqueConstraintError' || code === '23505';
};

const scopedWhere = (req, where = {}) => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'inspection', {
    tenantKey: 'tenant_id',
    facilityKey: 'facility_id',
  });
};

const scopedWhereForMyInspections = (req, where = {}) => {
  const next = { ...where };
  if (!req.user?.isSuperAdmin && req.user?.tenantId) {
    next.tenant_id = req.user.tenantId;
  }
  return next;
};

const assertWorkerInspectionOwnership = (req, inspection) => {
  if (!inspection || req.user?.isSuperAdmin || !hasFieldInspectionRole(req)) {
    return;
  }
  const inspectorId = String(inspection.inspector_user_id || '').trim();
  const actorId = String(req.user?.id || '').trim();
  if (inspectorId && actorId && inspectorId !== actorId) {
    throw new AppError('This inspection belongs to another worker', 403, {
      code: 'INSPECTOR_MISMATCH',
      details: {
        inspectionId: inspection.id,
        inspectorUserId: inspectorId,
      },
    });
  }
};

const assertInspectionScope = (req, inspection) => {
  if (!inspection) return;
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (
    !hasFieldInspectionRole(req) &&
    req.user?.scopeLevel === 'facility' &&
    uniqueIds(req.user?.scopeFacilityIds || []).length === 0
  ) {
    throw new AppError('Worker scope is not loaded for facility-level access', 403, {
      code: 'SCOPE_NOT_LOADED',
      details: {
        reason: 'worker_scope_not_loaded',
        facilityId: inspection.facility_id || null,
      },
    });
  }
  if (
    !isFacilityAccessibleForInspection(req, inspection.facility_id || null, {
      facilityTenantId: inspection.tenant_id,
    })
  ) {
    throw new AppError('Inspection out of scope', 403, {
      code: 'SCOPE_FORBIDDEN',
      details: {
        reason: 'facility_outside_assigned_scope',
        facilityId: inspection.facility_id || null,
      },
    });
  }
  assertWorkerInspectionOwnership(req, inspection);
};

const createInspectionEvent = async ({
  inspection,
  req = null,
  eventType,
  eventStatus = null,
  source = 'api',
  imageId = null,
  toiletId = null,
  payload = null,
}) => {
  if (!inspection?.id || !eventType) {
    return null;
  }
  return InspectionEvent.create({
    tenant_id: inspection.tenant_id || null,
    inspection_id: inspection.id,
    toilet_id: toiletId || inspection.toilet_unit_id || null,
    image_id: imageId || null,
    event_type: eventType,
    event_status: eventStatus,
    source,
    actor_user_id: req?.user?.id || null,
    payload: payload || null,
    occurred_at: new Date(),
  });
};

const includeInspectionRelations = ({ includeEvents = false } = {}) => [
  { model: InspectionMedia },
  {
    model: InspectionSubmission,
    as: 'inspectionSubmissions',
    attributes: ['id', 'status', 'submitted_at'],
    required: false,
  },
  ...(includeEvents
    ? [
        {
          model: InspectionEvent,
          as: 'events',
          attributes: ['id', 'event_type', 'event_status', 'source', 'occurred_at', 'payload'],
        },
      ]
    : []),
  { model: AiAnalysisResult, limit: 1, order: [['processed_at', 'DESC']] },
  { model: Facility, attributes: ['id', 'name', 'code', 'facility_type'] },
  { model: ToiletUnit, attributes: ['id', 'code', 'qr_code', 'unit_type'] },
  {
    model: PlatformUser,
    as: 'inspector',
    attributes: ['id', 'full_name', 'email', 'employee_code'],
  },
];

const normalizeReviewAction = (value) => {
  const action = String(value || '').trim().toLowerCase();
  if (!REVIEW_LABELS[action]) {
    throw new AppError('Invalid review action', 400, { code: 'INVALID_REVIEW_ACTION' });
  }
  return action;
};

const MEDIA_AI_STATUS_PRIORITY = {
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

const mediaTimestamp = (value) => {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

const mediaPriority = (row) => {
  const aiStatus = String(row?.ai_status || '').trim().toUpperCase();
  const uploadStatus = String(row?.upload_status || '').trim().toLowerCase();
  const confirmedUpload = uploadStatus === 'confirmed' || uploadStatus === 'uploaded';
  let score = 0;
  if (hasRenderableImage(row)) score += 1000;
  if (confirmedUpload) score += 120;
  score += MEDIA_AI_STATUS_PRIORITY[aiStatus] || 0;
  if (
    aiStatus === 'AI_COMPLETED' &&
    row?.overall_score !== null &&
    row?.overall_score !== undefined
  ) {
    score += 500;
  }
  return score;
};

const mediaStage = (row) => String(row?.capture_stage || 'evidence').trim().toLowerCase();

const mediaKey = (row, index = 0) => {
  const stage = mediaStage(row);
  const clientImageId = String(row?.client_image_id || '').trim();
  if (clientImageId) return `client:${stage}:${clientImageId}`;
  const hash = String(row?.sha256 || '').trim().toLowerCase();
  if (hash) return `sha:${stage}:${hash}`;
  const fileUrl = String(row?.file_url || '').trim();
  if (fileUrl) return `url:${stage}:${fileUrl}`;
  return `id:${row?.id || index}`;
};

const choosePreferredMedia = (left, right) => {
  if (!left) return right;
  if (!right) return left;

  const leftPriority = mediaPriority(left);
  const rightPriority = mediaPriority(right);
  if (leftPriority !== rightPriority) {
    return rightPriority > leftPriority ? right : left;
  }

  const leftUpdated = mediaTimestamp(left.updated_at || left.created_at || left.captured_at);
  const rightUpdated = mediaTimestamp(right.updated_at || right.created_at || right.captured_at);
  return rightUpdated > leftUpdated ? right : left;
};

const sortMediaRows = (rows = []) =>
  [...rows].sort((left, right) => {
    const stageComparison = mediaStage(left).localeCompare(mediaStage(right));
    if (stageComparison !== 0) return stageComparison;

    const leftOrdinal = Number.isFinite(Number(left?.ordinal))
      ? Number(left.ordinal)
      : Number.MAX_SAFE_INTEGER;
    const rightOrdinal = Number.isFinite(Number(right?.ordinal))
      ? Number(right.ordinal)
      : Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;

    const leftCaptured = mediaTimestamp(left?.captured_at);
    const rightCaptured = mediaTimestamp(right?.captured_at);
    if (leftCaptured !== rightCaptured) return leftCaptured - rightCaptured;

    const leftCreated = mediaTimestamp(left?.created_at);
    const rightCreated = mediaTimestamp(right?.created_at);
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;

    return String(left?.id || '').localeCompare(String(right?.id || ''));
  });

const removePlaceholderRows = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const hasRenderableByStage = new Map();
  for (const row of rows) {
    const stage = mediaStage(row);
    if (hasRenderableImage(row)) {
      hasRenderableByStage.set(stage, true);
    } else if (!hasRenderableByStage.has(stage)) {
      hasRenderableByStage.set(stage, false);
    }
  }

  return rows.filter((row) => {
    const stage = mediaStage(row);
    if (!hasRenderableByStage.get(stage)) return true;
    if (hasRenderableImage(row)) return true;

    const aiStatus = String(row?.ai_status || '').trim().toUpperCase();
    const uploadStatus = String(row?.upload_status || '').trim().toLowerCase();
    const placeholder =
      PLACEHOLDER_AI_STATUSES.has(aiStatus) ||
      PLACEHOLDER_UPLOAD_STATUSES.has(uploadStatus);
    return !placeholder;
  });
};

const dedupeInspectionMedia = (rows = []) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const selected = new Map();
  rows.forEach((row, index) => {
    if (!row) return;
    const key = mediaKey(row, index);
    selected.set(key, choosePreferredMedia(selected.get(key), row));
  });
  return sortMediaRows(removePlaceholderRows(Array.from(selected.values())));
};

const hydrateInspectionMediaForDisplay = async (
  inspection,
  { mediaUrlCache = null } = {}
) => {
  const mediaRows = dedupeInspectionMedia(inspection?.InspectionMedia || []);
  if (inspection) {
    inspection.InspectionMedia = mediaRows;
  }
  for (const media of mediaRows) {
    const urls = await resolveMediaPairUrls(
      {
        fileUrl: media.file_url,
        thumbnailUrl: media.thumbnail_url || media.file_url,
        storageKey: media.storage_key || null,
      },
      { cache: mediaUrlCache }
    );
    media.file_url = urls.fileUrl || normalizeMediaUrl(media.file_url);
    media.thumbnail_url =
      urls.thumbnailUrl || normalizeMediaUrl(media.thumbnail_url || media.file_url);
  }
};

const loadLatestReviewByInspectionIds = async (inspectionIds) => {
  if (!Array.isArray(inspectionIds) || inspectionIds.length === 0) {
    return new Map();
  }

  const rows = await AuditLog.findAll({
    where: {
      action: 'inspection.review',
      entity_type: 'inspection',
      entity_id: { [Op.in]: inspectionIds.map(String) },
    },
    include: [
      {
        model: PlatformUser,
        as: 'actor',
        attributes: ['id', 'full_name', 'email'],
        required: false,
      },
    ],
    order: [['created_at', 'DESC']],
  });

  const map = new Map();
  for (const row of rows) {
    if (!row.entity_id || map.has(String(row.entity_id))) {
      continue;
    }
    const action = String(row.details?.reviewAction || '').toLowerCase();
    const reviewAction = REVIEW_LABELS[action] ? action : 'reviewed';
    map.set(String(row.entity_id), {
      action: reviewAction,
      actionLabel: REVIEW_LABELS[reviewAction],
      note: row.details?.note || null,
      reviewedAt: row.created_at,
      reviewedByUserId: row.actor_user_id,
      reviewedByName: row.actor?.full_name || row.actor?.email || 'Reviewer',
    });
  }
  return map;
};

const mapInspectionMediaItem = (item) => {
  const aiScoring =
    item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
      ? item.metadata.ai_scoring || null
      : null;
  const score =
    item.overall_score !== null && item.overall_score !== undefined
      ? Number(item.overall_score)
      : aiScoring?.score_0_100 !== undefined
        ? Number(aiScoring.score_0_100)
        : null;
  const starRating =
    aiScoring?.star_rating_0_5 !== undefined
      ? Number(aiScoring.star_rating_0_5)
      : score !== null
        ? Number((score / 20).toFixed(1))
        : null;
  return {
    id: item.id,
    clientImageId: item.client_image_id || null,
    captureStage: item.capture_stage,
    uploadStatus: item.upload_status || null,
    processingState: item.processing_state || null,
    fileUrl: normalizeMediaUrl(item.file_url),
    thumbnailUrl: normalizeMediaUrl(item.thumbnail_url || item.file_url),
    uploadedAt: item.uploaded_at,
    confirmedAt: item.confirmed_at || null,
    capturedAt: item.captured_at || null,
    contentLength: Number(item.content_length || 0) || null,
    etag: item.etag || null,
    aiStatus: item.ai_status || null,
    retryCount: Number(item.retry_count || 0),
    aiAttemptCount: Number(item.ai_attempt_count || 0),
    nextRetryAt: item.next_retry_at || null,
    lastRetryAt: item.last_retry_at || null,
    storageVerifiedAt: item.storage_verified_at || null,
    lastErrorCode: item.last_error_code || null,
    lastErrorMessage: item.last_error_message || null,
    manualReviewRequiredAt: item.manual_review_required_at || null,
    imageQualityStatus: item.image_quality_status || null,
    imageQualityScore:
      item.image_quality_score !== null && item.image_quality_score !== undefined
        ? Number(item.image_quality_score)
        : null,
    validationStatus: item.validation_status || null,
    validationReason: item.validation_reason || null,
    toiletDetected:
      item.toilet_detected !== null && item.toilet_detected !== undefined
        ? Boolean(item.toilet_detected)
        : null,
    visibilityScore:
      item.visibility_score !== null && item.visibility_score !== undefined
        ? Number(item.visibility_score)
        : null,
    score,
    score0To100: score,
    starRating0To5: starRating,
    confidenceScore:
      item.confidence_score !== null && item.confidence_score !== undefined
        ? Number(item.confidence_score)
        : null,
    aiConfidence:
      aiScoring?.confidence !== undefined
        ? Number(aiScoring.confidence)
        : aiScoring?.confidence_score !== undefined
          ? Number(aiScoring.confidence_score)
          : item.confidence_score !== null && item.confidence_score !== undefined
            ? Number(item.confidence_score)
            : null,
    floorScore:
      item.floor_score !== null && item.floor_score !== undefined
        ? Number(item.floor_score)
        : null,
    commodeScore:
      item.commode_score !== null && item.commode_score !== undefined
        ? Number(item.commode_score)
        : null,
    stainScore:
      item.stain_score !== null && item.stain_score !== undefined
        ? Number(item.stain_score)
        : null,
    garbageScore:
      item.garbage_score !== null && item.garbage_score !== undefined
        ? Number(item.garbage_score)
        : null,
    waterScore:
      item.water_score !== null && item.water_score !== undefined
        ? Number(item.water_score)
        : null,
    issueTags: Array.isArray(item.issue_tags) ? item.issue_tags : [],
    issueSummary: item.issue_summary || null,
    severity: item.severity || null,
    reviewRequired: Boolean(item.review_required),
    hygieneRisk: aiScoring?.hygiene_risk || null,
    cleanlinessLevel: aiScoring?.cleanliness_level || null,
    requiresRetake: Boolean(aiScoring?.requires_retake),
    retakeReason: aiScoring?.retake_reason || null,
    scoreReason: aiScoring?.score_reason || null,
    criticalFindings:
      aiScoring?.critical_findings && typeof aiScoring.critical_findings === 'object'
        ? aiScoring.critical_findings
        : null,
    supervisorFlags: Array.isArray(aiScoring?.supervisor_flags)
      ? aiScoring.supervisor_flags
      : [],
    modelVersion: item.model_version || null,
    promptVersion: item.prompt_version || null,
    scoringVersion: item.scoring_version || null,
    aiProcessedAt: item.ai_processed_at || null,
    aiError: item.ai_error || null,
    scoringRejected: Boolean(item.scoring_rejected),
    similarityScore:
      item.similarity_score !== null && item.similarity_score !== undefined
        ? Number(item.similarity_score)
        : null,
    explanationSummary: item.explanation_summary || null,
    gpsLat: item.gps_lat !== null && item.gps_lat !== undefined ? Number(item.gps_lat) : null,
    gpsLng: item.gps_lng !== null && item.gps_lng !== undefined ? Number(item.gps_lng) : null,
    deviceId: item.device_id || null,
    workerId: item.worker_id || null,
    assignmentId: item.assignment_id || null,
    metadata: item.metadata,
  };
};

const mapInspection = (
  inspection,
  { withAnalysis = true, reviewByInspectionId = new Map() } = {}
) => {
  const media = dedupeInspectionMedia(inspection.InspectionMedia || []);
  const beforeMedia = media.filter((item) => item.capture_stage === 'before');
  const afterMedia = media.filter((item) => item.capture_stage === 'after');
  const result = withAnalysis ? (inspection.AiAnalysisResults || [])[0] : null;
  const review = reviewByInspectionId.get(String(inspection.id)) || null;
  const finalSubmissions = Array.from(
    new Map(
      (Array.isArray(inspection.inspectionSubmissions)
        ? inspection.inspectionSubmissions
        : [])
        .filter((item) => item?.id)
        .map((item) => [String(item.id), item])
    ).values()
  );
  const latestSubmission = finalSubmissions
    .slice()
    .sort((a, b) => mediaTimestamp(b.submitted_at) - mediaTimestamp(a.submitted_at))[0] || null;
  const timeline = Array.isArray(inspection.events)
    ? [...inspection.events]
        .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
        .map((event) => ({
          id: event.id,
          eventType: event.event_type,
          eventStatus: event.event_status,
          source: event.source,
          occurredAt: event.occurred_at,
          payload: event.payload || null,
        }))
    : [];
  const reviewStatus = review?.action || null;
  const facilityName = inspection.Facility?.name || null;
  const facilityCode = inspection.Facility?.code || null;
  const toiletUnitCode = inspection.ToiletUnit?.code || null;
  const inspectorName = inspection.inspector?.full_name || null;
  const shortId = String(inspection.id || '').slice(0, 8).toUpperCase();
  const pipelineCounters =
    inspection.pipeline_counters && typeof inspection.pipeline_counters === 'object'
      ? inspection.pipeline_counters
      : {};
  const aiComparisonResult =
    pipelineCounters.ai_comparison_result &&
    typeof pipelineCounters.ai_comparison_result === 'object'
      ? pipelineCounters.ai_comparison_result
      : null;
  const aiSupervisorFlags = Array.isArray(pipelineCounters.ai_supervisor_flags)
    ? pipelineCounters.ai_supervisor_flags
    : [];
  const beforeScoreValue =
    inspection.avg_before_score !== null && inspection.avg_before_score !== undefined
      ? Number(inspection.avg_before_score)
      : null;
  const afterScoreValue =
    inspection.avg_after_score !== null && inspection.avg_after_score !== undefined
      ? Number(inspection.avg_after_score)
      : null;
  const afterStageAiScoring = afterMedia
    .map((item) =>
      item?.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
        ? item.metadata.ai_scoring || null
        : null
    )
    .filter((item) => item && typeof item === 'object');
  const derivedHygieneRisk = afterStageAiScoring.reduce((risk, item) => {
    const next = String(item?.hygiene_risk || '').trim().toLowerCase();
    if (!next) return risk;
    if (next === 'severe') return 'severe';
    if (next === 'high' && risk !== 'severe') return 'high';
    if (next === 'medium' && !['severe', 'high'].includes(risk)) return 'medium';
    if (next === 'low' && !risk) return 'low';
    return risk;
  }, '');
  const requiresRetake = afterStageAiScoring.some((item) => item?.requires_retake === true);
  const aiStatus = inspectionAiStatusFromSignals({
    score: afterScoreValue ?? beforeScoreValue,
    hygieneRisk: derivedHygieneRisk || null,
    requiresRetake,
    suspiciousFlag: Boolean(inspection.suspicious_flag),
  });

  return {
    id: inspection.id,
    inspectionCode: shortId ? `INS-${shortId}` : null,
    tenantId: inspection.tenant_id,
    taskId: inspection.task_id,
    facilityId: inspection.facility_id,
    facilityName,
    facilityCode,
    toiletUnitId: inspection.toilet_unit_id,
    toiletUnitCode,
    inspectorUserId: inspection.inspector_user_id,
    inspectorName,
    inspectorEmail: inspection.inspector?.email || null,
    inspectionType: inspection.inspection_type,
    notes: inspection.notes,
    latitude: inspection.latitude,
    longitude: inspection.longitude,
    capturedAt: inspection.captured_at,
    submittedAt: inspection.submitted_at,
    processingStatus: inspection.processing_status,
    pipelineStatus: inspection.pipeline_status || inspection.processing_status,
    pipelineCounters:
      inspection.pipeline_counters && typeof inspection.pipeline_counters === 'object'
        ? inspection.pipeline_counters
        : null,
    inspectionStatus: inspection.status || null,
    reviewRequired: Boolean(inspection.review_required),
    lastProcessingError: inspection.last_processing_error || null,
    overallStatus: inspection.overall_status,
    sensorSnapshot: normalizeSensorSnapshot(inspection.sensor_snapshot),
    beforeImageCount:
      beforeMedia.length > 0
        ? beforeMedia.length
        : Number(inspection.before_image_count || 0),
    afterImageCount:
      afterMedia.length > 0
        ? afterMedia.length
        : Number(inspection.after_image_count || 0),
    avgBeforeScore:
      beforeScoreValue,
    avgAfterScore:
      afterScoreValue,
    avgBeforeStarRating0To5: starFromScore(beforeScoreValue),
    avgAfterStarRating0To5: starFromScore(afterScoreValue),
    aiHygieneRisk: derivedHygieneRisk || null,
    aiStatus,
    requiresRetake,
    improvementScore:
      inspection.improvement_score !== null && inspection.improvement_score !== undefined
        ? Number(inspection.improvement_score)
        : null,
    confidenceAvg:
      inspection.confidence_avg !== null && inspection.confidence_avg !== undefined
        ? Number(inspection.confidence_avg)
        : null,
    inspectionResult: inspection.inspection_result || null,
    beforeIssueTags: Array.isArray(inspection.before_issue_tags) ? inspection.before_issue_tags : [],
    afterIssueTags: Array.isArray(inspection.after_issue_tags) ? inspection.after_issue_tags : [],
    resolvedIssues: Array.isArray(inspection.resolved_issues) ? inspection.resolved_issues : [],
    remainingIssues: Array.isArray(inspection.remaining_issues) ? inspection.remaining_issues : [],
    suspiciousFlag: Boolean(inspection.suspicious_flag),
    suspiciousReasons: Array.isArray(inspection.suspicious_reasons) ? inspection.suspicious_reasons : [],
    aiSupervisorFlags,
    aiComparisonResult,
    validationFailedCount: Number(inspection.validation_failed_count || 0),
    rejectedImageCount: Number(inspection.rejected_image_count || 0),
    evidence: {
      beforeCount: beforeMedia.length,
      afterCount: afterMedia.length,
      totalCount: media.length,
      hasEvidence: beforeMedia.length + afterMedia.length > 0,
    },
    review,
    reviewStatus,
    reviewStatusLabel: reviewStatus ? REVIEW_LABELS[reviewStatus] : null,
    finalSubmissionCompleted: finalSubmissions.length > 0,
    submissionCount: finalSubmissions.length,
    latestSubmissionStatus: latestSubmission?.status || null,
    requiresManualReview:
      Boolean(inspection.review_required) ||
      inspection.processing_status !== 'completed' ||
      !review ||
      reviewStatus === 'rejected' ||
      reviewStatus === 'reinspection_required',
    facility: inspection.Facility
      ? {
          id: inspection.Facility.id,
          name: inspection.Facility.name,
          code: inspection.Facility.code,
          facilityType: inspection.Facility.facility_type,
        }
      : null,
    toiletUnit: inspection.ToiletUnit
      ? {
          id: inspection.ToiletUnit.id,
          code: inspection.ToiletUnit.code,
          qrCode: inspection.ToiletUnit.qr_code || inspection.ToiletUnit.code,
          unitType: inspection.ToiletUnit.unit_type,
        }
      : null,
    inspector: inspection.inspector
      ? {
          id: inspection.inspector.id,
          fullName: inspection.inspector.full_name,
          email: inspection.inspector.email,
          employeeCode: inspection.inspector.employee_code,
        }
      : null,
    beforeMedia: beforeMedia.map(mapInspectionMediaItem),
    afterMedia: afterMedia.map(mapInspectionMediaItem),
    media: media.map(mapInspectionMediaItem),
    timeline,
    analysisResult: result
      ? {
          strictJson:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? result.raw_result.strictJson
              : null,
          id: result.id,
          modelName: result.model_name,
          modelVersion: result.model_version,
          provider: result.provider || null,
          schemaVersion: result.schema_version || null,
          cleanlinessScore: Number(result.cleanliness_score),
          hygieneScore: Number(result.hygiene_score),
          odorRiskScore: Number(result.odor_risk_score),
          wetnessScore: Number(result.wetness_score),
          stainScore: Number(result.stain_score),
          litterScore: Number(result.litter_score),
          confidenceScore:
            result.confidence_score !== null && result.confidence_score !== undefined
              ? Number(result.confidence_score)
              : null,
          reviewRequired: Boolean(result.review_required),
          subScores: result.sub_scores || null,
          issueTags: Array.isArray(result.issue_tags) ? result.issue_tags : [],
          severityLabel: result.severity_label || null,
          score0To100:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? Number(result.raw_result.strictJson.score_0_100 ?? result.cleanliness_score)
              : Number(result.cleanliness_score),
          starRating0To5:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? Number(result.raw_result.strictJson.star_rating_0_5 ?? starFromScore(result.cleanliness_score))
              : starFromScore(result.cleanliness_score),
          hygieneRisk:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? result.raw_result.strictJson.hygiene_risk || null
              : null,
          sensorImpact:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? Number(result.raw_result.strictJson.sensor_impact || 0)
              : 0,
          environmentalScore:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? (result.raw_result.strictJson.environmental_score ?? null)
              : null,
          visualScore:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? Number(
                  result.raw_result.strictJson.visual_score ??
                    result.raw_result.strictJson.overall_cleanliness_score ??
                    result.cleanliness_score
                )
              : Number(result.cleanliness_score),
          requiresRetake:
            result.raw_result &&
            typeof result.raw_result === 'object' &&
            result.raw_result.strictJson &&
            typeof result.raw_result.strictJson === 'object'
              ? Boolean(result.raw_result.strictJson.requires_retake)
              : false,
          explanationText: result.explanation_text || null,
          processingMs: Number(result.processing_ms || 0) || null,
          anomalyFlags: result.anomaly_flags || {},
          processedAt: result.processed_at,
        }
      : null,
  };
};

const buildAnalysisRequestContext = (req) => {
  const safeHeaders = {};
  const userAgent = req?.headers?.['user-agent'];
  const forwardedFor = req?.headers?.['x-forwarded-for'];
  if (userAgent) {
    safeHeaders['user-agent'] = String(userAgent).slice(0, 300);
  }
  if (forwardedFor) {
    safeHeaders['x-forwarded-for'] = String(forwardedFor).slice(0, 200);
  }

  return {
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
    headers: Object.keys(safeHeaders).length > 0 ? safeHeaders : null,
  };
};

const isAutoAnalysisOnUploadEnabled = () => runtimeConfig.analysis.triggerOnUpload;

const findResumableOngoingInspection = async ({
  inspectorUserId,
  facilityId,
  toiletUnitId,
}) => {
  const where = {
    inspector_user_id: inspectorUserId,
    facility_id: facilityId,
    submitted_at: null,
  };
  if (toiletUnitId) {
    where.toilet_unit_id = toiletUnitId;
  }

  const candidates = await Inspection.findAll({
    where,
    order: [['captured_at', 'DESC']],
    limit: 20,
  });
  if (candidates.length === 0) {
    return null;
  }

  const candidateIds = candidates.map((row) => row.id);
  const beforeRows = await InspectionMedia.findAll({
    attributes: ['inspection_id'],
    where: {
      inspection_id: { [Op.in]: candidateIds },
      capture_stage: 'before',
      upload_status: { [Op.in]: ['confirmed', 'uploaded'] },
    },
    group: ['inspection_id'],
    raw: true,
  });
  const beforeIds = new Set(beforeRows.map((row) => row.inspection_id));
  if (beforeIds.size === 0) {
    return null;
  }

  const submittedRows = await InspectionSubmission.findAll({
    attributes: ['inspection_id'],
    where: { inspection_id: { [Op.in]: [...beforeIds] } },
    group: ['inspection_id'],
    raw: true,
  });
  const submittedIds = new Set(submittedRows.map((row) => row.inspection_id));

  return candidates.find((row) => beforeIds.has(row.id) && !submittedIds.has(row.id)) || null;
};

const createInspection = async (req) => {
  const inspectionType = normalizeInspectionType(req.body.inspectionType);
  const facility = await Facility.findByPk(req.body.facilityId);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (
    !hasFieldInspectionRole(req) &&
    req.user?.scopeLevel === 'facility' &&
    uniqueIds(req.user?.scopeFacilityIds || []).length === 0
  ) {
    throw new AppError('Worker scope is not loaded for facility-level access', 403, {
      code: 'SCOPE_NOT_LOADED',
      details: {
        reason: 'worker_scope_not_loaded',
        facilityId: facility.id,
      },
    });
  }
  if (
    !isFacilityAccessibleForInspection(req, facility.id, {
      facilityTenantId: facility.tenant_id,
    })
  ) {
    throw new AppError('Facility out of scope', 403, {
      code: 'SCOPE_FORBIDDEN',
      details: {
        reason: 'facility_outside_assigned_scope',
        facilityId: facility.id,
      },
    });
  }
  if (req.body.toiletUnitId) {
    const unit = await ToiletUnit.findByPk(req.body.toiletUnitId);
    if (!unit || unit.facility_id !== facility.id) {
      throw new AppError('Invalid toiletUnitId for facility', 400, { code: 'UNIT_INVALID' });
    }
    assertToiletAvailableForInspection(unit, facility);
  }
  if (req.body.taskId) {
    const task = await InspectionTask.findByPk(req.body.taskId);
    if (!task || task.facility_id !== facility.id) {
      throw new AppError('Invalid task for facility', 400, { code: 'TASK_INVALID' });
    }
  }

  const fallbackLatitude = req.body.latitude ?? facility.latitude ?? null;
  const fallbackLongitude = req.body.longitude ?? facility.longitude ?? null;

  const resumableInspection = await findResumableOngoingInspection({
    inspectorUserId: req.user.id,
    facilityId: facility.id,
    toiletUnitId: req.body.toiletUnitId || null,
  });
  if (resumableInspection) {
    return mapInspection(resumableInspection, { withAnalysis: false });
  }

  const inspection = await Inspection.create({
    tenant_id: facility.tenant_id,
    task_id: req.body.taskId || null,
    assignment_id: req.body.assignmentId || null,
    facility_id: facility.id,
    toilet_unit_id: req.body.toiletUnitId || null,
    inspector_user_id: req.user.id,
    inspection_type: inspectionType,
    notes: req.body.notes ? sanitizeText(req.body.notes, 1000) : null,
    latitude: fallbackLatitude,
    longitude: fallbackLongitude,
    captured_at: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(),
    processing_status: 'draft',
    pipeline_status: 'draft_local',
    status: 'DRAFT',
    review_required: false,
    submitted_at: null,
  });

  await createAuditLog({
    req,
    tenantId: facility.tenant_id,
    action: 'inspection.create',
    entityType: 'inspection',
    entityId: inspection.id,
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: facility.tenant_id,
    processingStatus: inspection.processing_status,
    pipelineStatus: inspection.pipeline_status,
  });

  await createInspectionEvent({
    inspection,
    req,
    eventType: 'inspection.created',
    eventStatus: inspection.pipeline_status,
    payload: {
      taskId: inspection.task_id || null,
    },
  });

  return mapInspection(inspection, { withAnalysis: false });
};

const uploadInspectionMedia = async (req) => {
  const inspection = await Inspection.findByPk(req.params.id);
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  assertInspectionScope(req, inspection);
  if (inspection.toilet_unit_id) {
    try {
      const unit = await ToiletUnit.findByPk(inspection.toilet_unit_id);
      const facility = await Facility.findByPk(inspection.facility_id);
      assertToiletAvailableForInspection(unit, facility);
    } catch (error) {
      if (req.file?.path) {
        await removeTempFile(req.file.path).catch(() => null);
      }
      throw error;
    }
  }
  if (!req.file?.path) {
    throw new AppError('file is required', 400, { code: 'FILE_REQUIRED' });
  }
  const captureStage = normalizeCaptureStage(req.body.captureStage);
  const clientImageId = normalizeClientImageId(req.body.clientImageId);
  const capturedAt = parseOptionalDate(req.body.capturedAt);
  const ordinal = parseOptionalNumber(req.body.ordinal);
  const gpsLat = parseOptionalNumber(req.body.gpsLat ?? req.body.gps_lat);
  const gpsLng = parseOptionalNumber(req.body.gpsLng ?? req.body.gps_lng);
  const watermarkMeta = parseOptionalObject(req.body.watermarkMeta);
  const now = new Date();

  const folder = `sanitation/${inspection.tenant_id}/inspections/${inspection.id}`;
  let uploaded;
  try {
    uploaded = await uploadImage(req.file.path, folder);
  } finally {
    await removeTempFile(req.file.path);
  }

  const metadataPayload = {
    ...uploaded.metadata,
    source: 'inspection-media-upload',
    originalFileName: req.file.originalname,
    mimeType: req.file.mimetype,
  };

  const mediaPayload = {
    inspection_id: inspection.id,
    toilet_unit_id: inspection.toilet_unit_id || null,
    worker_id: inspection.inspector_user_id || req.user?.id || null,
    assignment_id: inspection.assignment_id || null,
    client_image_id: clientImageId,
    media_type: 'image',
    capture_stage: captureStage,
    upload_status: 'confirmed',
    processing_state: isAutoAnalysisOnUploadEnabled()
      ? IMAGE_PROCESSING_STATES.QUEUED_FOR_AI
      : IMAGE_PROCESSING_STATES.STORAGE_VERIFIED,
    ai_status: isAutoAnalysisOnUploadEnabled() ? 'AI_QUEUED' : 'UPLOADED',
    etag: uploaded.metadata?.eTag || null,
    sha256: String(req.body.sha256 || '').trim() || null,
    content_length: uploaded.metadata?.bytes || null,
    width: uploaded.metadata?.width || null,
    height: uploaded.metadata?.height || null,
    gps_lat: gpsLat,
    gps_lng: gpsLng,
    device_id: req.body.deviceId || req.body.device_id || null,
    watermark_meta: watermarkMeta,
    captured_at: capturedAt,
    confirmed_at: now,
    ordinal,
    file_url: uploaded.fileUrl,
    storage_key: uploaded.storageKey,
    thumbnail_url: uploaded.fileUrl,
    uploaded_at: now,
    storage_verified_at: now,
    last_error_code: null,
    last_error_message: null,
    next_retry_at: null,
    ai_error: null,
    validation_status: 'PENDING',
    validation_reason: null,
    scoring_rejected: false,
    overall_score: null,
    confidence_score: null,
    floor_score: null,
    commode_score: null,
    stain_score: null,
    garbage_score: null,
    water_score: null,
    issue_tags: null,
    issue_summary: null,
    severity: null,
    model_version: null,
    prompt_version: null,
    scoring_version: null,
    image_quality_status: 'unknown',
    image_quality_score: null,
    toilet_detected: false,
    visibility_score: null,
    perceptual_hash: null,
    similarity_score: null,
    explanation_summary: null,
    ai_processed_at: null,
  };

  let media = null;
  if (clientImageId) {
    media = await InspectionMedia.findOne({
      where: {
        inspection_id: inspection.id,
        client_image_id: clientImageId,
      },
      order: [['updated_at', 'DESC']],
    });
  }

  if (media) {
    await media.update({
      ...mediaPayload,
      metadata: {
        ...(media.metadata || {}),
        ...metadataPayload,
      },
      updated_at: now,
    });
  } else {
    try {
      media = await InspectionMedia.create({
        ...mediaPayload,
        metadata: metadataPayload,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error) || !clientImageId) {
        throw error;
      }
      media = await InspectionMedia.findOne({
        where: {
          inspection_id: inspection.id,
          client_image_id: clientImageId,
        },
        order: [['updated_at', 'DESC']],
      });
      if (!media) {
        throw error;
      }
      await media.update({
        ...mediaPayload,
        metadata: {
          ...(media.metadata || {}),
          ...metadataPayload,
        },
        updated_at: now,
      });
    }
  }

  await inspection.update({
    pipeline_status: 'uploaded',
    status: 'IN_PROGRESS',
    updated_at: now,
  });

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.media_upload',
    entityType: 'inspection_media',
    entityId: media.id,
    details: { inspectionId: inspection.id, captureStage },
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    processingStatus: inspection.processing_status,
    pipelineStatus: inspection.pipeline_status,
    mediaUploaded: true,
  });

  await createInspectionEvent({
    inspection,
    req,
    eventType: 'inspection.media.uploaded_legacy',
    eventStatus: 'uploaded',
    imageId: media.id,
    payload: { mediaId: media.id, captureStage },
  });

  let analysisQueue = null;
  if (isAutoAnalysisOnUploadEnabled()) {
    await inspection.update({
      processing_status: 'queued',
      pipeline_status: 'queued_for_ai',
      status: inspection.submitted_at ? 'SUBMITTED' : 'IN_PROGRESS',
      updated_at: now,
    });

    analysisQueue = await enqueueInspectionAnalysis({
      inspectionId: inspection.id,
      imageId: media.id,
      tenantId: inspection.tenant_id,
      requestContext: buildAnalysisRequestContext(req),
    });

    await createInspectionEvent({
      inspection,
      req,
      eventType: 'inspection.media.analysis_queued',
      eventStatus: 'queued_for_ai',
      imageId: media.id,
      payload: {
        mediaId: media.id,
        queueJobId: analysisQueue?.queueJobId || null,
        queued: Boolean(analysisQueue?.queued),
        type: analysisQueue?.type || 'AI_ANALYSIS',
      },
    });

    eventBus.emit(EVENTS.INSPECTION_UPDATED, {
      inspectionId: inspection.id,
      tenantId: inspection.tenant_id,
      processingStatus: 'queued',
      pipelineStatus: 'queued_for_ai',
      mediaUploaded: true,
      analysisQueued: true,
    });
  }

  await recomputeInspectionAggregates(inspection.id, { updateToilet: false });

  const mediaFileUrl = await resolveMediaUrl({
    fileUrl: media.file_url,
    storageKey: media.storage_key || null,
  });

  return {
    id: media.id,
    inspectionId: inspection.id,
    captureStage: media.capture_stage,
    fileUrl: mediaFileUrl || normalizeMediaUrl(media.file_url),
    uploadedAt: media.uploaded_at,
    aiStatus: media.ai_status,
    analysisQueue,
  };
};

const submitInspection = async (req) => {
  const inspection = await Inspection.findByPk(req.params.id, {
    include: [{ model: InspectionMedia }],
  });
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  assertInspectionScope(req, inspection);
  if (inspection.toilet_unit_id) {
    const unit = await ToiletUnit.findByPk(inspection.toilet_unit_id);
    const facility = await Facility.findByPk(inspection.facility_id);
    assertToiletAvailableForInspection(unit, facility);
  }

  const hasBefore = inspection.InspectionMedia.some(
    (item) => item.capture_stage === 'before'
  );
  const hasAfter = inspection.InspectionMedia.some(
    (item) => item.capture_stage === 'after'
  );
  const confirmedMedia = inspection.InspectionMedia.filter(
    (item) =>
      item.upload_status === 'confirmed' ||
      item.upload_status === 'uploaded'
  );
  const hasConfirmedBefore = confirmedMedia.some(
    (item) => item.capture_stage === 'before'
  );
  const hasConfirmedAfter = confirmedMedia.some(
    (item) => item.capture_stage === 'after'
  );
  if (!hasBefore || !hasAfter || !hasConfirmedBefore || !hasConfirmedAfter) {
    throw new AppError('Before and after media are required before submission', 400, {
      code: 'MEDIA_INCOMPLETE',
      details: {
        reason: 'evidence_upload_incomplete',
        hasBefore,
        hasAfter,
        hasConfirmedBefore,
        hasConfirmedAfter,
      },
    });
  }

  const confirmedCount = confirmedMedia.length;
  const pendingUploadCount = Math.max(inspection.InspectionMedia.length - confirmedCount, 0);

  const clientSubmissionId = String(req.body.clientSubmissionId || '').trim() || null;
  const idempotencyKey = String(req.header('Idempotency-Key') || '').trim() || null;
  let existingSubmission = null;
  if (clientSubmissionId) {
    existingSubmission = await InspectionSubmission.findOne({
      where: {
        inspection_id: inspection.id,
        client_submission_id: clientSubmissionId,
      },
      order: [['created_at', 'DESC']],
    });
  } else if (idempotencyKey) {
    existingSubmission = await InspectionSubmission.findOne({
      where: {
        inspection_id: inspection.id,
        idempotency_key: idempotencyKey,
      },
      order: [['created_at', 'DESC']],
    });
  }

  if (existingSubmission) {
    return {
      inspectionId: inspection.id,
      submissionId: existingSubmission.id,
      processingStatus: existingSubmission.status || inspection.pipeline_status || 'queued_for_ai',
      reviewRequired: Boolean(inspection.review_required),
    };
  }

  const now = req.body.submittedAt ? new Date(req.body.submittedAt) : new Date();
  const pipelineStatus = pendingUploadCount > 0 ? 'pending_upload' : 'queued_for_ai';
  await inspection.update({
    submitted_at: now,
    processing_status: 'queued',
    pipeline_status: pipelineStatus,
    status: 'SUBMITTED',
    updated_at: new Date(),
  });

  const submission = await InspectionSubmission.create({
    tenant_id: inspection.tenant_id,
    inspection_id: inspection.id,
    client_submission_id: clientSubmissionId,
    idempotency_key: idempotencyKey,
    status: pipelineStatus,
    submitted_at: now,
    acknowledged_at: new Date(),
    metadata: {
      beforeCount: inspection.InspectionMedia.filter((item) => item.capture_stage === 'before').length,
      afterCount: inspection.InspectionMedia.filter((item) => item.capture_stage === 'after').length,
      totalCount: inspection.InspectionMedia.length,
      confirmedCount,
      pendingUploadCount,
    },
  });

  let enqueueResult = null;
  if (isAutoAnalysisOnUploadEnabled()) {
    enqueueResult = {
      queued: false,
      skipped: true,
      reason: 'IMAGE_LEVEL_PIPELINE_ACTIVE',
    };
  } else if (confirmedCount === 0) {
    enqueueResult = {
      queued: false,
      skipped: true,
      reason: 'NO_CONFIRMED_MEDIA_YET',
    };
  } else {
    enqueueResult = await enqueueInspectionAnalysis({
      inspectionId: inspection.id,
      submissionId: submission.id,
      tenantId: inspection.tenant_id,
      requestContext: buildAnalysisRequestContext(req),
    });
  }

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.submit',
    entityType: 'inspection',
    entityId: inspection.id,
  });

  await createInspectionEvent({
    inspection,
    req,
    eventType: 'inspection.submitted',
    eventStatus: pipelineStatus,
    payload: {
      submissionId: submission.id,
      queued: Boolean(enqueueResult?.queued),
      skipped: Boolean(enqueueResult?.skipped),
      reason: enqueueResult?.reason || null,
    },
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    processingStatus: 'queued',
    pipelineStatus,
    inspectionStatus: 'SUBMITTED',
  });

  await recomputeInspectionAggregates(inspection.id, { updateToilet: false });

  return {
    inspectionId: inspection.id,
    submissionId: submission.id,
    processingStatus: pipelineStatus,
    inspectionStatus: 'SUBMITTED',
    reviewRequired: Boolean(inspection.review_required),
  };
};

const reviewInspection = async (req) => {
  const inspection = await Inspection.findByPk(req.params.id, {
    include: includeInspectionRelations({ includeEvents: true }),
  });
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  assertInspectionScope(req, inspection);

  const action = normalizeReviewAction(req.body.action);
  const note = req.body.note ? sanitizeText(req.body.note, 800) : null;

  if (
    (action === 'accepted' || action === 'reviewed') &&
    ['queued', 'processing'].includes(String(inspection.processing_status || '').toLowerCase())
  ) {
    await inspection.update({
      processing_status: 'completed',
      pipeline_status: 'completed',
      status: 'COMPLETED',
      review_required: false,
      updated_at: new Date(),
    });
  } else {
    await inspection.update({
      review_required: action === 'reinspection_required' || action === 'rejected',
      status:
        action === 'reinspection_required' || action === 'rejected'
          ? 'REVIEW_REQUIRED'
          : inspection.status || 'FULLY_SCORED',
      updated_at: new Date(),
    });
  }

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.review',
    entityType: 'inspection',
    entityId: inspection.id,
    details: {
      reviewAction: action,
      note,
      outcome: action === 'rejected' || action === 'reinspection_required' ? 'warning' : 'success',
    },
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    processingStatus: inspection.processing_status,
    pipelineStatus: inspection.pipeline_status,
    reviewAction: action,
  });

  await createInspectionEvent({
    inspection,
    req,
    eventType: 'inspection.reviewed',
    eventStatus: action,
    payload: { note },
  });

  const reviewMap = await loadLatestReviewByInspectionIds([inspection.id]);
  const refreshed = await Inspection.findByPk(inspection.id, {
    include: includeInspectionRelations({ includeEvents: true }),
  });
  await hydrateInspectionMediaForDisplay(refreshed);
  return mapInspection(refreshed, {
    withAnalysis: true,
    reviewByInspectionId: reviewMap,
  });
};

const DISPLAY_STATUS_PIPELINE = {
  'queued for ai': 'queued_for_ai',
  queued_for_ai: 'queued_for_ai',
  queued: 'queued_for_ai',
  processing: 'processing',
  'low confidence': 'low_confidence',
  low_confidence: 'low_confidence',
};

const findInspectionIdsByLatestReviewActions = async (actions = []) => {
  const normalizedActions = (Array.isArray(actions) ? actions : [actions])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (normalizedActions.length === 0) {
    return [];
  }

  const rows = await AuditLog.findAll({
    attributes: ['entity_id', 'details', 'created_at'],
    where: {
      action: 'inspection.review',
      entity_type: 'inspection',
    },
    order: [['created_at', 'DESC']],
    raw: true,
  });

  const latestByInspection = new Map();
  for (const row of rows) {
    const id = String(row.entity_id || '').trim();
    if (!id || latestByInspection.has(id)) {
      continue;
    }
    let details = row.details || {};
    if (typeof details === 'string') {
      try {
        details = JSON.parse(details);
      } catch (_) {
        details = {};
      }
    }
    const action = String(details.reviewAction || details.action || 'reviewed').toLowerCase();
    latestByInspection.set(id, action);
  }

  return Array.from(latestByInspection.entries())
    .filter(([, action]) => normalizedActions.includes(action))
    .map(([id]) => id);
};

const applyInspectionStatusFilters = async (where, query = {}) => {
  const displayStatus = String(query.displayStatus || query.uiStatus || '')
    .trim()
    .toLowerCase();
  if (displayStatus && displayStatus !== 'all') {
    if (displayStatus === 'pending-review') {
      const rejectedIds = await findInspectionIdsByLatestReviewActions([
        'rejected',
        'reinspection_required',
      ]);
      const pendingClauses = [
        { pipeline_status: { [Op.in]: ['needs_review', 'low_confidence'] } },
        { status: 'REVIEW_REQUIRED' },
        { review_required: true },
        { overall_status: { [Op.in]: ['critical', 'poor'] } },
      ];
      if (rejectedIds.length > 0) {
        pendingClauses.push({ id: { [Op.in]: rejectedIds } });
      }
      return {
        ...where,
        [Op.or]: pendingClauses,
      };
    }

    if (displayStatus === 'accepted') {
      const ids = await findInspectionIdsByLatestReviewActions(['accepted']);
      if (ids.length === 0) {
        return { empty: true };
      }
      return { ...where, id: { [Op.in]: ids } };
    }

    if (displayStatus === 'rejected') {
      const ids = await findInspectionIdsByLatestReviewActions(['rejected', 'reinspection_required']);
      if (ids.length === 0) {
        return { empty: true };
      }
      return { ...where, id: { [Op.in]: ids } };
    }

    const pipelineStatus = DISPLAY_STATUS_PIPELINE[displayStatus];
    if (pipelineStatus) {
      return { ...where, pipeline_status: pipelineStatus };
    }
  }

  if (!query.status) {
    return where;
  }

  const requestedStatus = String(query.status).trim().toLowerCase();
  const requestedUpper = String(query.status).trim().toUpperCase();
  if (PROCESSING_STATUSES.has(requestedStatus)) {
    return { ...where, processing_status: requestedStatus };
  }
  if (INSPECTION_STATUSES.has(requestedUpper)) {
    return { ...where, status: requestedUpper };
  }
  return { ...where, pipeline_status: requestedStatus };
};

const resolveOngoingInspectionFilter = async (where, { myOnly = false, userId = null } = {}) => {
  const submittedQuery = {
    attributes: ['inspection_id'],
    raw: true,
  };
  if (myOnly && userId) {
    submittedQuery.include = [
      {
        model: Inspection,
        attributes: [],
        where: {
          inspector_user_id: userId,
          ...(where.tenant_id ? { tenant_id: where.tenant_id } : {}),
        },
        required: true,
      },
    ];
  }

  const submittedRows = await InspectionSubmission.findAll(submittedQuery);
  const submittedIds = uniqueIds(submittedRows.map((row) => row.inspection_id));

  const candidateWhere = {
    ...where,
    submitted_at: null,
  };
  if (submittedIds.length > 0) {
    candidateWhere.id = { [Op.notIn]: submittedIds };
  }

  const candidates = await Inspection.findAll({
    attributes: ['id', 'processing_status'],
    where: candidateWhere,
    include: [
      {
        model: InspectionMedia,
        attributes: ['id', 'capture_stage', 'upload_status'],
        required: false,
      },
    ],
  });

  const ongoingIds = uniqueIds(
    candidates
      .filter((inspection) => {
        const media = inspection.InspectionMedia || [];
        const hasBefore = media.some((item) => item.capture_stage === 'before');
        if (hasBefore) {
          return true;
        }
        return String(inspection.processing_status || '').trim().toLowerCase() === 'draft';
      })
      .map((inspection) => inspection.id)
  );

  if (ongoingIds.length === 0) {
    return { empty: true };
  }

  return { id: { [Op.in]: ongoingIds } };
};

const listInspections = async (req, myOnly = false) => {
  const { page, limit, offset } = normalizePagination(req.query);
  let where =
    myOnly && hasFieldInspectionRole(req)
      ? scopedWhereForMyInspections(req)
      : scopedWhere(req);
  const ongoingOnly = ['1', 'true', 'yes'].includes(
    String(req.query.ongoing || '').trim().toLowerCase()
  );
  where = await applyInspectionStatusFilters(where, req.query);
  if (where?.empty) {
    return {
      items: [],
      meta: {
        page,
        limit,
        total: 0,
        totalPages: 1,
      },
    };
  }
  delete where.empty;
  if (myOnly) {
    where.inspector_user_id = req.user.id;
  }
  if (req.query.facilityId) {
    const facilityFilterAllowed = myOnly && hasFieldInspectionRole(req)
      ? true
      : isFacilityInScope(req, req.query.facilityId);
    if (!facilityFilterAllowed) {
      throw new AppError('facilityId is outside scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }
  if (ongoingOnly) {
    const ongoingFilter = await resolveOngoingInspectionFilter(where, {
      myOnly,
      userId: req.user?.id || null,
    });
    if (ongoingFilter.empty) {
      return {
        items: [],
        meta: {
          page,
          limit,
          total: 0,
          totalPages: 1,
        },
      };
    }
    delete ongoingFilter.empty;
    where = { ...where, ...ongoingFilter };
  }
  where = applyDateRangeToWhere(
    where,
    'captured_at',
    resolveDateRange(req.query, { maxDays: 90 })
  );

  const { rows, count } = await Inspection.findAndCountAll({
    where,
    include: includeInspectionRelations(),
    order: [['captured_at', 'DESC']],
    distinct: true,
    limit,
    offset,
  });

  const mediaUrlCache = new Map();
  await Promise.all(
    rows.map((inspection) =>
      hydrateInspectionMediaForDisplay(inspection, { mediaUrlCache })
    )
  );

  const reviewMap = await loadLatestReviewByInspectionIds(rows.map((row) => row.id));

  return {
    items: rows.map((inspection) =>
      mapInspection(inspection, { withAnalysis: true, reviewByInspectionId: reviewMap })
    ),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getInspectionById = async (req) => {
  const inspection = await Inspection.findByPk(req.params.id, {
    include: includeInspectionRelations({ includeEvents: true }),
  });
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  assertInspectionScope(req, inspection);
  await hydrateInspectionMediaForDisplay(inspection);
  const reviewMap = await loadLatestReviewByInspectionIds([inspection.id]);
  return mapInspection(inspection, { withAnalysis: true, reviewByInspectionId: reviewMap });
};

/* -------------------------------------------------------------------------- */
/* Sensor snapshot link — attach an optional BLE reading snapshot to an        */
/* inspection. Purely additive metadata: it never blocks or alters submit/AI   */
/* scoring. Validates tenant/facility scope and, when a persisted              */
/* sensorReadingId is supplied, that the reading is same-tenant and (if the    */
/* device is commissioned) belongs to this inspection's toilet.                */
/* -------------------------------------------------------------------------- */
const linkInspectionSensorReading = async (req) => {
  const inspection = await Inspection.findByPk(req.params.id);
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  assertInspectionScope(req, inspection);

  const snapshotInput =
    req.body.sensorSnapshot && typeof req.body.sensorSnapshot === 'object'
      ? req.body.sensorSnapshot
      : {};
  const sensorReadingId =
    sanitizeText(req.body.sensorReadingId, 80) || snapshotInput.sensorReadingId || null;
  let resolvedDeviceId =
    sanitizeText(req.body.sensorDeviceId, 140) || snapshotInput.sensorDeviceId || null;

  // When a persisted reading id is given, enforce cross-tenant + toilet mapping.
  if (sensorReadingId && isUuid(String(sensorReadingId))) {
    const reading = await SensorReading.findByPk(sensorReadingId);
    if (reading) {
      const device = await SensorDevice.findByPk(reading.device_id);
      if (device) {
        if (!req.user.isSuperAdmin && device.tenant_id !== req.user.tenantId) {
          throw new AppError('Sensor reading belongs to another tenant', 403, {
            code: 'SCOPE_FORBIDDEN',
          });
        }
        if (
          inspection.toilet_unit_id &&
          device.toilet_unit_id &&
          String(device.toilet_unit_id) !== String(inspection.toilet_unit_id)
        ) {
          throw new AppError('Sensor is attached to a different toilet than this inspection', 409, {
            code: 'SENSOR_TOILET_MISMATCH',
          });
        }
        resolvedDeviceId = resolvedDeviceId || device.id;
      }
    }
  }

  const snapshot = {
    ...snapshotInput,
    sensorReadingId: sensorReadingId || null,
    sensorDeviceId: resolvedDeviceId || null,
    linkedAt: new Date().toISOString(),
    linkedByUserId: req.user.id || null,
  };

  await inspection.update({ sensor_snapshot: snapshot, updated_at: new Date() });

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.sensor_link',
    entityType: 'inspection',
    entityId: inspection.id,
    details: { sensorReadingId: snapshot.sensorReadingId, sensorDeviceId: snapshot.sensorDeviceId },
  });

  return { inspectionId: inspection.id, sensorSnapshot: snapshot };
};

const startInspection = async (req) => createInspection(req);

const getInspectionImages = async (req) => {
  return listInspectionImages(req.params.id, req);
};

const getInspectionImageJobs = async (req) => {
  return listInspectionImageJobs(req.params.id, req);
};

const getInspectionImageById = async (req) => {
  return getInspectionImage(req.params.imageId || req.params.id, req);
};

const triggerInspectionImageAnalysis = async (req) => {
  return triggerInspectionImageAi(req.params.imageId || req.params.id, req);
};

const getToiletInspections = async (req) => {
  return listToiletInspections(req.params.toiletId, req, {
    page: req.query.page,
    limit: req.query.limit,
  });
};

const getInspectionComparisonById = async (req) => {
  return getInspectionComparison(req.params.id, req);
};

const getToiletDetailsById = async (req) => {
  return getToiletDetails(req.params.id, req);
};

const getToiletLatestInspectionById = async (req) => {
  return getToiletLatestInspection(req.params.id, req);
};

const getToiletScoreTrendsById = async (req) => {
  return getToiletScoreTrends(req.params.id, req, { days: req.query.days });
};

const getToiletInspectionHistoryById = async (req) => {
  return getToiletInspectionHistory(req.params.id, req, {
    page: req.query.page,
    limit: req.query.limit,
  });
};

module.exports = {
  createInspection,
  startInspection,
  uploadInspectionMedia,
  submitInspection,
  reviewInspection,
  listInspections,
  getInspectionById,
  linkInspectionSensorReading,
  getInspectionImages,
  getInspectionImageJobs,
  getInspectionImageById,
  triggerInspectionImageAnalysis,
  getToiletInspections,
  getInspectionComparisonById,
  getToiletDetailsById,
  getToiletLatestInspectionById,
  getToiletScoreTrendsById,
  getToiletInspectionHistoryById,
};
