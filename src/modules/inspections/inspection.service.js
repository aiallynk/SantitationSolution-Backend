const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  Inspection,
  InspectionMedia,
  Facility,
  ToiletUnit,
  InspectionTask,
  AiAnalysisResult,
  PlatformUser,
  AuditLog,
} = require('../../models');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const { uploadImage, removeTempFile } = require('../media/storage.service');
const { getObjectDataUrlFromS3 } = require('../media/s3.service');
const { enqueueInspectionAnalysis } = require('../analysis/analysis.queue');
const { createAuditLog } = require('../audit/audit.service');
const { eventBus, EVENTS } = require('../../core/live/eventBus');

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

const scopedWhere = (req, where = {}) => {
  if (!req.user.isSuperAdmin) {
    return { ...where, tenant_id: req.user.tenantId };
  }
  return where;
};

const includeInspectionRelations = () => [
  { model: InspectionMedia },
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

const normalizeMediaUrl = (url) => {
  const value = String(url || '').trim();
  if (!value) return null;
  if (value.startsWith('/static/uploads/')) {
    return value.replace('/static/uploads/', '/static/');
  }
  return value;
};

const hydrateInspectionMediaForDisplay = async (inspection, { forceS3DataUrl = false } = {}) => {
  const mediaRows = inspection?.InspectionMedia || [];
  for (const media of mediaRows) {
    const normalizedUrl = normalizeMediaUrl(media.file_url);
    if (normalizedUrl && normalizedUrl !== media.file_url) {
      media.file_url = normalizedUrl;
    }
    const normalizedThumbnail = normalizeMediaUrl(media.thumbnail_url || media.file_url);
    if (normalizedThumbnail && normalizedThumbnail !== media.thumbnail_url) {
      media.thumbnail_url = normalizedThumbnail;
    }

    const storageKey = String(media.storage_key || '').trim();
    if (!storageKey) continue;

    const currentUrl = String(media.file_url || '').trim();
    const looksLikeS3 =
      currentUrl.includes('.amazonaws.com/') ||
      currentUrl.includes('s3.') ||
      currentUrl.includes('amazonaws.com');

    if (!forceS3DataUrl && !looksLikeS3) {
      continue;
    }

    const dataUrl = await getObjectDataUrlFromS3(storageKey);
    if (dataUrl) {
      media.file_url = dataUrl;
      media.thumbnail_url = dataUrl;
    }
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

const mapInspection = (
  inspection,
  { withAnalysis = true, reviewByInspectionId = new Map() } = {}
) => {
  const media = inspection.InspectionMedia || [];
  const beforeMedia = media.filter((item) => item.capture_stage === 'before');
  const afterMedia = media.filter((item) => item.capture_stage === 'after');
  const result = withAnalysis ? (inspection.AiAnalysisResults || [])[0] : null;
  const review = reviewByInspectionId.get(String(inspection.id)) || null;
  const reviewStatus = review?.action || null;
  const facilityName = inspection.Facility?.name || null;
  const facilityCode = inspection.Facility?.code || null;
  const toiletUnitCode = inspection.ToiletUnit?.code || null;
  const inspectorName = inspection.inspector?.full_name || null;
  const shortId = String(inspection.id || '').slice(0, 8).toUpperCase();

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
    overallStatus: inspection.overall_status,
    evidence: {
      beforeCount: beforeMedia.length,
      afterCount: afterMedia.length,
      totalCount: media.length,
      hasEvidence: beforeMedia.length + afterMedia.length > 0,
    },
    review,
    reviewStatus,
    reviewStatusLabel: reviewStatus ? REVIEW_LABELS[reviewStatus] : null,
    requiresManualReview:
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
    beforeMedia: beforeMedia.map((item) => ({
      id: item.id,
      captureStage: item.capture_stage,
      fileUrl: normalizeMediaUrl(item.file_url),
      thumbnailUrl: normalizeMediaUrl(item.thumbnail_url || item.file_url),
      uploadedAt: item.uploaded_at,
      metadata: item.metadata,
    })),
    afterMedia: afterMedia.map((item) => ({
      id: item.id,
      captureStage: item.capture_stage,
      fileUrl: normalizeMediaUrl(item.file_url),
      thumbnailUrl: normalizeMediaUrl(item.thumbnail_url || item.file_url),
      uploadedAt: item.uploaded_at,
      metadata: item.metadata,
    })),
    media: media.map((item) => ({
      id: item.id,
      captureStage: item.capture_stage,
      fileUrl: normalizeMediaUrl(item.file_url),
      thumbnailUrl: normalizeMediaUrl(item.thumbnail_url || item.file_url),
      uploadedAt: item.uploaded_at,
      metadata: item.metadata,
    })),
    analysisResult: result
      ? {
          id: result.id,
          modelName: result.model_name,
          modelVersion: result.model_version,
          cleanlinessScore: Number(result.cleanliness_score),
          hygieneScore: Number(result.hygiene_score),
          odorRiskScore: Number(result.odor_risk_score),
          wetnessScore: Number(result.wetness_score),
          stainScore: Number(result.stain_score),
          litterScore: Number(result.litter_score),
          anomalyFlags: result.anomaly_flags || {},
          processedAt: result.processed_at,
        }
      : null,
  };
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
  if (req.body.toiletUnitId) {
    const unit = await ToiletUnit.findByPk(req.body.toiletUnitId);
    if (!unit || unit.facility_id !== facility.id) {
      throw new AppError('Invalid toiletUnitId for facility', 400, { code: 'UNIT_INVALID' });
    }
  }
  if (req.body.taskId) {
    const task = await InspectionTask.findByPk(req.body.taskId);
    if (!task || task.facility_id !== facility.id) {
      throw new AppError('Invalid task for facility', 400, { code: 'TASK_INVALID' });
    }
  }

  const fallbackLatitude = req.body.latitude ?? facility.latitude ?? null;
  const fallbackLongitude = req.body.longitude ?? facility.longitude ?? null;

  const inspection = await Inspection.create({
    tenant_id: facility.tenant_id,
    task_id: req.body.taskId || null,
    facility_id: facility.id,
    toilet_unit_id: req.body.toiletUnitId || null,
    inspector_user_id: req.user.id,
    inspection_type: inspectionType,
    notes: req.body.notes ? sanitizeText(req.body.notes, 1000) : null,
    latitude: fallbackLatitude,
    longitude: fallbackLongitude,
    captured_at: req.body.capturedAt ? new Date(req.body.capturedAt) : new Date(),
    processing_status: 'draft',
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
  if (!req.file?.path) {
    throw new AppError('file is required', 400, { code: 'FILE_REQUIRED' });
  }
  const captureStage = req.body.captureStage || 'evidence';

  const folder = `sanitation/${inspection.tenant_id}/inspections/${inspection.id}`;
  let uploaded;
  try {
    uploaded = await uploadImage(req.file.path, folder);
  } finally {
    await removeTempFile(req.file.path);
  }

  const media = await InspectionMedia.create({
    inspection_id: inspection.id,
    media_type: 'image',
    capture_stage: captureStage,
    file_url: uploaded.fileUrl,
    storage_key: uploaded.storageKey,
    thumbnail_url: uploaded.fileUrl,
    metadata: {
      ...uploaded.metadata,
      source: 'inspection-media-upload',
      originalFileName: req.file.originalname,
      mimeType: req.file.mimetype,
    },
    uploaded_at: new Date(),
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
    mediaUploaded: true,
  });

  return {
    id: media.id,
    inspectionId: inspection.id,
    captureStage: media.capture_stage,
    fileUrl: media.file_url,
    uploadedAt: media.uploaded_at,
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

  const hasBefore = inspection.InspectionMedia.some((item) => item.capture_stage === 'before');
  const hasAfter = inspection.InspectionMedia.some((item) => item.capture_stage === 'after');
  if (!hasBefore || !hasAfter) {
    throw new AppError('Before and after media are required before submission', 400, {
      code: 'MEDIA_INCOMPLETE',
    });
  }

  await inspection.update({
    submitted_at: new Date(),
    processing_status: 'queued',
    updated_at: new Date(),
  });

  await enqueueInspectionAnalysis({
    inspectionId: inspection.id,
    requestContext: {
      user: req.user,
      requestId: req.requestId,
      headers: req.headers,
      ip: req.ip,
    },
  });

  await createAuditLog({
    req,
    tenantId: inspection.tenant_id,
    action: 'inspection.submit',
    entityType: 'inspection',
    entityId: inspection.id,
  });

  eventBus.emit(EVENTS.INSPECTION_UPDATED, {
    inspectionId: inspection.id,
    tenantId: inspection.tenant_id,
    processingStatus: 'queued',
  });

  return {
    inspectionId: inspection.id,
    processingStatus: 'queued',
  };
};

const reviewInspection = async (req) => {
  const inspection = await Inspection.findByPk(req.params.id, {
    include: includeInspectionRelations(),
  });
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const action = normalizeReviewAction(req.body.action);
  const note = req.body.note ? sanitizeText(req.body.note, 800) : null;

  if (
    (action === 'accepted' || action === 'reviewed') &&
    ['queued', 'processing'].includes(String(inspection.processing_status || '').toLowerCase())
  ) {
    await inspection.update({
      processing_status: 'completed',
      updated_at: new Date(),
    });
  } else {
    await inspection.update({ updated_at: new Date() });
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
    reviewAction: action,
  });

  const reviewMap = await loadLatestReviewByInspectionIds([inspection.id]);
  const refreshed = await Inspection.findByPk(inspection.id, {
    include: includeInspectionRelations(),
  });
  await hydrateInspectionMediaForDisplay(refreshed, { forceS3DataUrl: true });
  return mapInspection(refreshed, {
    withAnalysis: true,
    reviewByInspectionId: reviewMap,
  });
};

const listInspections = async (req, myOnly = false) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const where = scopedWhere(req);
  if (req.query.status) {
    where.processing_status = req.query.status;
  }
  if (myOnly) {
    where.inspector_user_id = req.user.id;
  }
  if (req.query.facilityId) {
    where.facility_id = req.query.facilityId;
  }

  const { rows, count } = await Inspection.findAndCountAll({
    where,
    include: includeInspectionRelations(),
    order: [['captured_at', 'DESC']],
    limit,
    offset,
  });

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
    include: includeInspectionRelations(),
  });
  if (!inspection) {
    throw new AppError('Inspection not found', 404, { code: 'INSPECTION_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && inspection.tenant_id !== req.user.tenantId) {
    throw new AppError('Inspection out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  await hydrateInspectionMediaForDisplay(inspection, { forceS3DataUrl: true });
  const reviewMap = await loadLatestReviewByInspectionIds([inspection.id]);
  return mapInspection(inspection, { withAnalysis: true, reviewByInspectionId: reviewMap });
};

module.exports = {
  createInspection,
  uploadInspectionMedia,
  submitInspection,
  reviewInspection,
  listInspections,
  getInspectionById,
};
