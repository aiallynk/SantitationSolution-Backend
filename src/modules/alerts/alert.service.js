const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const { Alert } = require('../../models');
const { normalizePagination } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const { eventBus, EVENTS } = require('../../core/live/eventBus');

const scopedWhere = (req) => {
  const where = {};
  if (!req.user.isSuperAdmin) {
    where.tenant_id = req.user.tenantId;
  } else if (req.query.tenantId) {
    where.tenant_id = req.query.tenantId;
  }
  if (req.query.status) where.status = req.query.status;
  if (req.query.severity) where.severity = req.query.severity;
  if (req.query.facilityId) where.facility_id = req.query.facilityId;
  if (req.query.sourceType) where.source_type = req.query.sourceType;
  return where;
};

const mapAlert = (alert) => ({
  id: alert.id,
  tenantId: alert.tenant_id,
  alertType: alert.alert_type,
  severity: alert.severity,
  sourceType: alert.source_type,
  sourceId: alert.source_id,
  facilityId: alert.facility_id,
  message: alert.message,
  status: alert.status,
  assignedToUserId: alert.assigned_to_user_id,
  createdAt: alert.created_at,
  acknowledgedAt: alert.acknowledged_at,
  resolvedAt: alert.resolved_at,
});

const listAlerts = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const { rows, count } = await Alert.findAndCountAll({
    where: scopedWhere(req),
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map(mapAlert),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getAlertById = async (req) => {
  const alert = await Alert.findByPk(req.params.id);
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && alert.tenant_id !== req.user.tenantId) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return mapAlert(alert);
};

const acknowledgeAlert = async (req) => {
  const alert = await Alert.findByPk(req.params.id);
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && alert.tenant_id !== req.user.tenantId) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  await alert.update({
    status: 'acknowledged',
    acknowledged_at: new Date(),
    assigned_to_user_id: req.body.assignedToUserId || alert.assigned_to_user_id,
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    tenantId: alert.tenant_id,
    action: 'alert.acknowledge',
    entityType: 'alert',
    entityId: alert.id,
  });

  eventBus.emit(EVENTS.ALERT_UPDATED, {
    id: alert.id,
    tenantId: alert.tenant_id,
    status: alert.status,
    severity: alert.severity,
  });

  return mapAlert(alert);
};

const resolveAlert = async (req) => {
  const alert = await Alert.findByPk(req.params.id);
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && alert.tenant_id !== req.user.tenantId) {
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

  return mapAlert(alert);
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
