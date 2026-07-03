const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const { Alert, Inspection, Facility, ToiletUnit } = require('../../models');
const { normalizePagination } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');
const {
  resolveDateRange,
  applyDateRangeToWhere,
} = require('../../utils/dateRange');

const scopedWhere = (req) => {
  let where = applyScopeToQuery(
    {},
    buildAccessContextFromUser(req?.user || {}),
    'alert',
    { tenantKey: 'tenant_id', facilityKey: 'facility_id' },
  );
  if (req.query.status) where.status = req.query.status;
  if (req.query.severity) where.severity = req.query.severity;
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }
  if (req.query.sourceType) where.source_type = req.query.sourceType;
  where = applyDateRangeToWhere(where, 'created_at', resolveDateRange(req.query, { maxDays: 90 }));
  return where;
};

const toInspectionCode = (value) => {
  const text = String(value || '').replace(/-/g, '').trim().toUpperCase();
  if (!text) return null;
  return `INS-${text.slice(0, 8)}`;
};

const isInspectionLinkedAlert = (alert = {}) => {
  if (alert?.source_type === 'ai_analysis') return true;
  if (!alert?.source_id) return false;
  const alertType = String(alert?.alert_type || '').trim().toLowerCase();
  return alertType.startsWith('inspection_');
};

const resolveInspectionMetadata = async (alerts = []) => {
  const inspectionIds = alerts
    .filter((alert) => isInspectionLinkedAlert(alert))
    .map((alert) => String(alert.source_id));

  const uniqueInspectionIds = [...new Set(inspectionIds)];
  if (uniqueInspectionIds.length === 0) {
    return new Map();
  }

  const inspections = await Inspection.findAll({
    where: {
      id: {
        [Op.in]: uniqueInspectionIds,
      },
    },
    attributes: [
      'id',
      'facility_id',
      'toilet_unit_id',
      'inspection_type',
      'status',
      'processing_status',
      'review_required',
      'inspection_result',
      'captured_at',
      'submitted_at',
    ],
    include: [
      { model: Facility, attributes: ['id', 'name', 'code'], required: false },
      { model: ToiletUnit, attributes: ['id', 'code'], required: false },
    ],
  });

  return new Map(inspections.map((inspection) => [String(inspection.id), inspection]));
};

const mapAlert = (alert, { inspectionById = new Map() } = {}) => {
  const inspection =
    isInspectionLinkedAlert(alert) && alert?.source_id
      ? inspectionById.get(String(alert.source_id)) || null
      : null;

  const linkedFacility = inspection?.Facility || alert?.Facility || null;

  return {
    id: alert.id,
    tenantId: alert.tenant_id,
    alertType: alert.alert_type,
    severity: alert.severity,
    sourceType: alert.source_type,
    sourceId: alert.source_id,
    facilityId: alert.facility_id,
    facilityName: linkedFacility?.name || null,
    facilityCode: linkedFacility?.code || null,
    message: alert.message,
    status: alert.status,
    assignedToUserId: alert.assigned_to_user_id,
    createdAt: alert.created_at,
    acknowledgedAt: alert.acknowledged_at,
    resolvedAt: alert.resolved_at,
    inspectionId: isInspectionLinkedAlert(alert) ? alert.source_id : null,
    inspectionCode: isInspectionLinkedAlert(alert) ? toInspectionCode(alert.source_id) : null,
    inspectionStatus: inspection?.status || null,
    inspectionType: inspection?.inspection_type || null,
    processingStatus: inspection?.processing_status || null,
    reviewRequired: Boolean(inspection?.review_required),
    inspectionResult: inspection?.inspection_result || null,
    inspectionCapturedAt: inspection?.captured_at || null,
    inspectionSubmittedAt: inspection?.submitted_at || null,
    toiletUnitId: inspection?.toilet_unit_id || null,
    toiletUnitCode: inspection?.ToiletUnit?.code || null,
    toiletLabel: inspection?.ToiletUnit?.code || null,
  };
};

const listAlerts = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const { rows, count } = await Alert.findAndCountAll({
    where: scopedWhere(req),
    include: [{ model: Facility, attributes: ['id', 'name', 'code'], required: false }],
    order: [['created_at', 'DESC']],
    distinct: true,
    limit,
    offset,
  });
  const inspectionById = await resolveInspectionMetadata(rows);
  return {
    items: rows.map((alert) => mapAlert(alert, { inspectionById })),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getAlertById = async (req) => {
  const alert = await Alert.findByPk(req.params.id, {
    include: [{ model: Facility, attributes: ['id', 'name', 'code'], required: false }],
  });
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && alert.tenant_id !== req.user.tenantId) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, alert.facility_id || null)) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const inspectionById = await resolveInspectionMetadata([alert]);
  return mapAlert(alert, { inspectionById });
};

const acknowledgeAlert = async (req) => {
  const alert = await Alert.findByPk(req.params.id, {
    include: [{ model: Facility, attributes: ['id', 'name', 'code'], required: false }],
  });
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && alert.tenant_id !== req.user.tenantId) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, alert.facility_id || null)) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const assignedToUserId = req.body.assignedToUserId || alert.assigned_to_user_id || null;

  await alert.update({
    status: 'acknowledged',
    acknowledged_at: new Date(),
    assigned_to_user_id: assignedToUserId,
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    tenantId: alert.tenant_id,
    action: 'alert.acknowledge',
    entityType: 'alert',
    entityId: alert.id,
    details: {
      assignedToUserId,
      facilityId: alert.facility_id || null,
      severity: alert.severity,
      alertType: alert.alert_type,
      dispatched: Boolean(assignedToUserId),
    },
  });

  eventBus.emit(EVENTS.ALERT_UPDATED, {
    id: alert.id,
    tenantId: alert.tenant_id,
    status: alert.status,
    severity: alert.severity,
  });

  const inspectionById = await resolveInspectionMetadata([alert]);
  return mapAlert(alert, { inspectionById });
};

const resolveAlert = async (req) => {
  const alert = await Alert.findByPk(req.params.id, {
    include: [{ model: Facility, attributes: ['id', 'name', 'code'], required: false }],
  });
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && alert.tenant_id !== req.user.tenantId) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, alert.facility_id || null)) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  await alert.update({
    status: 'resolved',
    resolved_at: new Date(),
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    tenantId: alert.tenant_id,
    action: 'alert.resolve',
    entityType: 'alert',
    entityId: alert.id,
  });

  eventBus.emit(EVENTS.ALERT_UPDATED, {
    id: alert.id,
    tenantId: alert.tenant_id,
    status: alert.status,
    severity: alert.severity,
  });

  const inspectionById = await resolveInspectionMetadata([alert]);
  return mapAlert(alert, { inspectionById });
};

const getAlertSummary = async (req) => {
  const where = scopedWhere(req);
  const [open, acknowledged, critical] = await Promise.all([
    Alert.count({ where: { ...where, status: 'open' } }),
    Alert.count({ where: { ...where, status: 'acknowledged' } }),
    Alert.count({ where: { ...where, severity: 'critical', status: { [Op.ne]: 'resolved' } } }),
  ]);

  return {
    open,
    acknowledged,
    critical,
    totalActive: open + acknowledged,
  };
};

module.exports = {
  listAlerts,
  getAlertById,
  acknowledgeAlert,
  resolveAlert,
  getAlertSummary,
};
