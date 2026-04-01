const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const { Alert, Facility, PlatformUser } = require('../../models');
const { normalizePagination } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const { eventBus, EVENTS } = require('../../core/live/eventBus');

const scopedWhere = (req) => {
  const result = {};
  if (!req.user.isSuperAdmin) {
    result.tenant_id = req.user.tenantId;
  } else if (req.query.tenantId) {
    result.tenant_id = req.query.tenantId;
  }

  if (req.query.status) result.status = req.query.status;
  if (req.query.severity) result.severity = req.query.severity;
  if (req.query.facilityId) result.facility_id = req.query.facilityId;
  if (req.query.sourceType) result.source_type = req.query.sourceType;
  return result;
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
  const tenantFilter = scopedWhere(req);
  const geoFilter = req.scope?.geographyFilter || {};

  const { rows, count } = await Alert.findAndCountAll({
    where: tenantFilter,
    include: geoFilter.geography_id ? [{ model: Facility, where: geoFilter, required: true }] : [],
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
  const alert = await Alert.findByPk(req.params.id, {
    include: [{ model: Facility }],
  });
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && alert.tenant_id !== req.user.tenantId) {
    throw new AppError('Alert out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  
  // Verify geography scope if applicable
  const geoFilter = req.scope?.geographyFilter || {};
  if (geoFilter.geography_id && !geoFilter.geography_id.includes(alert.Facility?.geography_id)) {
    throw new AppError('Alert out of geography scope', 403, { code: 'GEOGRAPHY_SCOPE_FORBIDDEN' });
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
  const tenantFilter = scopedWhere(req);
  const geoFilter = req.scope?.geographyFilter || {};
  const include = geoFilter.geography_id ? [{ model: Facility, where: geoFilter, required: true }] : [];

  const [open, acknowledged, critical] = await Promise.all([
    Alert.count({ where: { ...tenantFilter, status: 'open' }, include }),
    Alert.count({ where: { ...tenantFilter, status: 'acknowledged' }, include }),
    Alert.count({ where: { ...tenantFilter, severity: 'critical', status: { [Op.ne]: 'resolved' } }, include }),
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
