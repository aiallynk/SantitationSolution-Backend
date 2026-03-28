const { Op } = require('sequelize');
const {
  AuditLog,
  PlatformUser,
  Tenant,
  Facility,
  ToiletUnit,
  Inspection,
  InspectionTask,
  SuperAdminProject,
  SuperAdminSupportTicket,
} = require('../../models');
const { normalizePagination, sanitizeText } = require('../../utils/validators');

const ACTION_LABELS = {
  'auth.login': 'User Logged In',
  'auth.logout': 'User Logged Out',
  'auth.refresh': 'Session Refreshed',
  'auth.forgot_password': 'Password Reset Requested',
  'auth.reset_password': 'Password Reset Completed',
  'tenant.create': 'Tenant Created',
  'tenant.update': 'Tenant Updated',
  'facility.create': 'Facility Added',
  'facility.update': 'Facility Updated',
  'geography.create': 'Geography Added',
  'toilet_block.create': 'Toilet Block Added',
  'toilet_unit.create': 'Toilet Unit Added',
  'users.create': 'User Created',
  'users.update': 'User Updated',
  'task.create': 'Task Created',
  'task.start': 'Task Started',
  'task.complete': 'Task Completed',
  'inspection.create': 'Inspection Started',
  'inspection.media_upload': 'Inspection Media Uploaded',
  'inspection.submit': 'Inspection Submitted',
  'inspection.review': 'Inspection Reviewed',
  'analysis.inspection_run': 'AI Analysis Completed',
  'super_admin.tenant_provision': 'Tenant Provisioned',
  'super_admin.tenant_update': 'Tenant Updated',
  'super_admin.tenant_admin_create': 'Tenant Admin Onboarded',
  'super_admin.project_create': 'Project Created',
  'super_admin.approval_create': 'Approval Requested',
  'super_admin.approval_update': 'Approval Updated',
  'super_admin.feature_flags_update': 'Feature Flags Updated',
  'user.update_me': 'Profile Updated',
};

const ENTITY_LABELS = {
  tenant: 'Tenant',
  platform_user: 'User',
  geography: 'Geography',
  facility: 'Facility',
  toilet_block: 'Toilet Block',
  toilet_unit: 'Toilet Unit',
  inspection: 'Inspection',
  inspection_task: 'Task',
  inspection_media: 'Inspection Media',
  login_session: 'Session',
  super_admin_project: 'Project',
  super_admin_support_ticket: 'Support Ticket',
  super_admin_approval: 'Approval',
};

const toTitleCase = (value) =>
  String(value || '')
    .replace(/[._]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');

const mapActionLabel = (action) => ACTION_LABELS[action] || toTitleCase(action);

const mapEntityLabel = (entityType) => ENTITY_LABELS[entityType] || toTitleCase(entityType);

const summarizeDetails = (details) => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    return null;
  }
  const entries = Object.entries(details).filter(([, value]) => value !== null && value !== undefined);
  if (entries.length === 0) {
    return null;
  }
  return entries
    .slice(0, 3)
    .map(([key, value]) => `${toTitleCase(key)}: ${String(value)}`)
    .join(' | ');
};

const resolveTargetLabels = async (rows) => {
  const idsByType = new Map();

  for (const row of rows) {
    const entityType = row.entity_type;
    const entityId = row.entity_id;
    if (!entityType || !entityId) continue;
    const bucket = idsByType.get(entityType) || new Set();
    bucket.add(String(entityId));
    idsByType.set(entityType, bucket);
  }

  const resolved = new Map();
  const addLabel = (entityType, entityId, label) => {
    resolved.set(`${entityType}:${entityId}`, label);
  };

  const platformUserIds = [...(idsByType.get('platform_user') || [])];
  if (platformUserIds.length > 0) {
    const rowsFound = await PlatformUser.findAll({
      where: { id: { [Op.in]: platformUserIds } },
      attributes: ['id', 'full_name', 'email'],
    });
    rowsFound.forEach((item) => {
      addLabel('platform_user', item.id, `${item.full_name} (${item.email})`);
    });
  }

  const tenantIds = [...(idsByType.get('tenant') || [])];
  if (tenantIds.length > 0) {
    const rowsFound = await Tenant.findAll({
      where: { id: { [Op.in]: tenantIds } },
      attributes: ['id', 'name', 'code'],
    });
    rowsFound.forEach((item) => {
      addLabel('tenant', item.id, `${item.name} (${item.code})`);
    });
  }

  const facilityIds = [...(idsByType.get('facility') || [])];
  if (facilityIds.length > 0) {
    const rowsFound = await Facility.findAll({
      where: { id: { [Op.in]: facilityIds } },
      attributes: ['id', 'name', 'code'],
    });
    rowsFound.forEach((item) => {
      addLabel('facility', item.id, `${item.name} (${item.code})`);
    });
  }

  const toiletUnitIds = [...(idsByType.get('toilet_unit') || [])];
  if (toiletUnitIds.length > 0) {
    const rowsFound = await ToiletUnit.findAll({
      where: { id: { [Op.in]: toiletUnitIds } },
      attributes: ['id', 'code'],
    });
    rowsFound.forEach((item) => {
      addLabel('toilet_unit', item.id, `Toilet ${item.code}`);
    });
  }

  const inspectionIds = [...(idsByType.get('inspection') || [])];
  if (inspectionIds.length > 0) {
    const rowsFound = await Inspection.findAll({
      where: { id: { [Op.in]: inspectionIds } },
      attributes: ['id', 'facility_id', 'captured_at'],
      include: [{ model: Facility, attributes: ['name', 'code'] }],
    });
    rowsFound.forEach((item) => {
      const facilityLabel = item.Facility?.name || item.Facility?.code || 'Facility';
      const shortId = String(item.id).slice(0, 8).toUpperCase();
      addLabel('inspection', item.id, `Inspection #${shortId} (${facilityLabel})`);
    });
  }

  const taskIds = [...(idsByType.get('inspection_task') || [])];
  if (taskIds.length > 0) {
    const rowsFound = await InspectionTask.findAll({
      where: { id: { [Op.in]: taskIds } },
      attributes: ['id', 'task_type'],
      include: [{ model: Facility, attributes: ['name', 'code'] }],
    });
    rowsFound.forEach((item) => {
      const facilityLabel = item.Facility?.name || item.Facility?.code || 'Facility';
      addLabel('inspection_task', item.id, `${toTitleCase(item.task_type)} Task (${facilityLabel})`);
    });
  }

  const projectIds = [...(idsByType.get('super_admin_project') || [])];
  if (projectIds.length > 0) {
    const rowsFound = await SuperAdminProject.findAll({
      where: { id: { [Op.in]: projectIds } },
      attributes: ['id', 'name', 'code'],
    });
    rowsFound.forEach((item) => {
      addLabel('super_admin_project', item.id, `${item.name} (${item.code})`);
    });
  }

  const ticketIds = [...(idsByType.get('super_admin_support_ticket') || [])];
  if (ticketIds.length > 0) {
    const rowsFound = await SuperAdminSupportTicket.findAll({
      where: { id: { [Op.in]: ticketIds } },
      attributes: ['id', 'subject'],
    });
    rowsFound.forEach((item) => {
      addLabel('super_admin_support_ticket', item.id, item.subject);
    });
  }

  return resolved;
};

const mapAuditRow = ({ row, targetLabelMap }) => {
  const entityType = row.entity_type;
  const entityId = row.entity_id;
  const actorName = row.actor?.full_name || 'System';
  const actorEmail = row.actor?.email || null;
  const tenantName = row.tenant?.name || null;
  const tenantCode = row.tenant?.code || null;
  const resolvedTargetLabel =
    entityType && entityId ? targetLabelMap.get(`${entityType}:${entityId}`) : null;

  const outcomeRaw = String(row.details?.outcome || '').toLowerCase();
  const outcome =
    outcomeRaw === 'failed' || row.action?.includes('.failed')
      ? 'failed'
      : outcomeRaw === 'warning'
        ? 'warning'
        : 'success';

  return {
    id: row.id,
    timestamp: row.created_at,
    action: row.action,
    actionLabel: mapActionLabel(row.action),
    entityType,
    entityTypeLabel: mapEntityLabel(entityType),
    entityId,
    targetLabel: resolvedTargetLabel || (entityId ? `${mapEntityLabel(entityType)} ${entityId}` : mapEntityLabel(entityType)),
    actorUserId: row.actor_user_id,
    actorName,
    actorEmail,
    tenantId: row.tenant_id,
    tenantName,
    tenantCode,
    outcome,
    detailsSummary: summarizeDetails(row.details),
    details: row.details,
    requestId: row.request_id,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
  };
};

const createAuditLog = async ({
  req,
  actorUserId = null,
  tenantId = null,
  action,
  entityType,
  entityId = null,
  details = null,
}) => {
  try {
    await AuditLog.create({
      tenant_id: tenantId || req?.user?.tenantId || null,
      actor_user_id: actorUserId || req?.user?.id || null,
      action,
      entity_type: entityType,
      entity_id: entityId ? String(entityId) : null,
      request_id: req?.requestId || null,
      ip_address: req?.ip || req?.headers['x-forwarded-for'] || null,
      user_agent: req?.headers['user-agent'] || null,
      details,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to persist audit log:', error.message);
  }
};

const listAuditLogs = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const where = {};

  if (!req.user?.isSuperAdmin) {
    where.tenant_id = req.user?.tenantId || null;
  } else if (req.query.tenantId) {
    where.tenant_id = req.query.tenantId;
  }

  if (req.query.action) {
    where.action = req.query.action;
  }
  if (req.query.entityType) {
    where.entity_type = req.query.entityType;
  }
  if (req.query.actorUserId) {
    where.actor_user_id = req.query.actorUserId;
  }
  if (req.query.search) {
    const q = sanitizeText(req.query.search, 120);
    where[Op.or] = [
      { action: { [Op.iLike]: `%${q}%` } },
      { entity_type: { [Op.iLike]: `%${q}%` } },
      { entity_id: { [Op.iLike]: `%${q}%` } },
    ];
  }

  const { rows, count } = await AuditLog.findAndCountAll({
    where,
    include: [
      {
        model: PlatformUser,
        as: 'actor',
        attributes: ['id', 'full_name', 'email', 'employee_code'],
        required: false,
      },
      {
        model: Tenant,
        as: 'tenant',
        attributes: ['id', 'name', 'code'],
        required: false,
      },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  const targetLabelMap = await resolveTargetLabels(rows);

  return {
    items: rows.map((row) => mapAuditRow({ row, targetLabelMap })),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

module.exports = {
  createAuditLog,
  listAuditLogs,
};
