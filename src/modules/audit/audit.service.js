const { Op } = require('sequelize');
const {
  AuditLog,
  PlatformUser,
  Tenant,
  Facility,
  ToiletBlock,
  ToiletUnit,
  Inspection,
  InspectionMedia,
  InspectionTask,
  Alert,
  Complaint,
  SensorDevice,
  WorkerAssignment,
  SuperAdminProject,
  SuperAdminSupportTicket,
} = require('../../models');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const {
  EMPTY_SCOPE_UUID,
  uniqueIds,
  buildAccessContextFromUser,
  applyScopeToQuery,
} = require('../../core/rbac/scopeWhere');
const notificationService = require('../notifications/notification.service');

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
  'auth.activate_account': 'Account Activated',
  'worker.import.template_downloaded': 'Worker Import Template Downloaded',
  'worker.import.validation_completed': 'Worker Import Validation Completed',
  'worker.import.confirmed': 'Worker Import Confirmed',
  'worker.import.worker_created': 'Imported Worker Created',
  'worker.import.activation_generated': 'Worker Activation Generated',
};

const ENTITY_LABELS = {
  tenant: 'Tenant',
  platform_user: 'User',
  worker_import_job: 'Worker Import Job',
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

const addEntityIds = (bucketMap, entityType, values = []) => {
  const ids = uniqueIds(values);
  if (!entityType || ids.length === 0) return;
  const bucket = bucketMap.get(entityType) || new Set();
  ids.forEach((id) => bucket.add(String(id)));
  bucketMap.set(entityType, bucket);
};

const buildScopedAuditEntityClauses = async (req) => {
  if (req?.user?.isSuperAdmin) return [];

  const accessContext = buildAccessContextFromUser(req?.user || {});
  const scopeLevel = String(accessContext.scopeLevel || '').trim().toLowerCase();
  const tenantId = String(req?.user?.tenantId || '').trim() || null;
  const tenantWhere = tenantId ? { tenant_id: tenantId } : {};

  let geographyIds = uniqueIds(accessContext.geographyIds || []);
  let facilityIds = uniqueIds(accessContext.facilityIds || []);

  // Fallback: derive facilities from scoped geographies when facility scope ids are not pre-populated.
  if (facilityIds.length === 0 && geographyIds.length > 0) {
    const derivedFacilityRows = await Facility.findAll({
      where: {
        ...tenantWhere,
        [Op.or]: [
          { geography_id: { [Op.in]: geographyIds } },
          { zone_geography_id: { [Op.in]: geographyIds } },
          { ward_geography_id: { [Op.in]: geographyIds } },
        ],
      },
      attributes: ['id'],
      raw: true,
    });
    facilityIds = uniqueIds(derivedFacilityRows.map((row) => row.id));
  }

  const enforceGeographyScope =
    geographyIds.length > 0 || (scopeLevel && !['organization', 'facility', 'platform'].includes(scopeLevel));
  const enforceFacilityScope =
    facilityIds.length > 0 || scopeLevel === 'facility';

  if (!enforceGeographyScope && !enforceFacilityScope) {
    return [];
  }

  if (enforceGeographyScope && geographyIds.length === 0) {
    geographyIds = [EMPTY_SCOPE_UUID];
  }
  if (enforceFacilityScope && facilityIds.length === 0) {
    facilityIds = [EMPTY_SCOPE_UUID];
  }

  const entityIdsByType = new Map();
  addEntityIds(entityIdsByType, 'geography', geographyIds);
  addEntityIds(entityIdsByType, 'facility', facilityIds);

  if (facilityIds.length > 0) {
    const [
      blockRows,
      unitRows,
      inspectionRows,
      taskRows,
      alertRows,
      complaintRows,
      sensorRows,
    ] = await Promise.all([
      ToiletBlock.findAll({
        where: { facility_id: { [Op.in]: facilityIds } },
        attributes: ['id'],
        raw: true,
      }),
      ToiletUnit.findAll({
        where: { facility_id: { [Op.in]: facilityIds } },
        attributes: ['id'],
        raw: true,
      }),
      Inspection.findAll({
        where: { ...tenantWhere, facility_id: { [Op.in]: facilityIds } },
        attributes: ['id'],
        raw: true,
      }),
      InspectionTask.findAll({
        where: { ...tenantWhere, facility_id: { [Op.in]: facilityIds } },
        attributes: ['id'],
        raw: true,
      }),
      Alert.findAll({
        where: { ...tenantWhere, facility_id: { [Op.in]: facilityIds } },
        attributes: ['id'],
        raw: true,
      }),
      Complaint.findAll({
        where: { ...tenantWhere, facility_id: { [Op.in]: facilityIds } },
        attributes: ['id'],
        raw: true,
      }),
      SensorDevice.findAll({
        where: { ...tenantWhere, facility_id: { [Op.in]: facilityIds } },
        attributes: ['id'],
        raw: true,
      }),
    ]);

    const inspectionIds = uniqueIds(inspectionRows.map((row) => row.id));
    const inspectionMediaRows =
      inspectionIds.length > 0
        ? await InspectionMedia.findAll({
            where: { inspection_id: { [Op.in]: inspectionIds } },
            attributes: ['id'],
            raw: true,
          })
        : [];

    addEntityIds(entityIdsByType, 'toilet_block', blockRows.map((row) => row.id));
    addEntityIds(entityIdsByType, 'toilet_unit', unitRows.map((row) => row.id));
    addEntityIds(entityIdsByType, 'inspection', inspectionIds);
    addEntityIds(entityIdsByType, 'inspection_task', taskRows.map((row) => row.id));
    addEntityIds(entityIdsByType, 'inspection_media', inspectionMediaRows.map((row) => row.id));
    addEntityIds(entityIdsByType, 'alert', alertRows.map((row) => row.id));
    addEntityIds(entityIdsByType, 'complaint', complaintRows.map((row) => row.id));
    addEntityIds(entityIdsByType, 'sensor_device', sensorRows.map((row) => row.id));
  }

  const platformUserIds = new Set();
  if (geographyIds.length > 0) {
    const geographyUsers = await PlatformUser.findAll({
      where: {
        ...tenantWhere,
        geography_id: { [Op.in]: geographyIds },
      },
      attributes: ['id'],
      raw: true,
    });
    geographyUsers.forEach((row) => platformUserIds.add(String(row.id)));
  }

  const assignmentScopeClauses = [];
  if (geographyIds.length > 0) {
    assignmentScopeClauses.push({ geography_id: { [Op.in]: geographyIds } });
  }
  if (facilityIds.length > 0) {
    assignmentScopeClauses.push({ facility_id: { [Op.in]: facilityIds } });
  }
  if (assignmentScopeClauses.length > 0) {
    const assignmentRows = await WorkerAssignment.findAll({
      where: {
        ...tenantWhere,
        status: 'active',
        [Op.or]: assignmentScopeClauses,
      },
      attributes: ['user_id'],
      raw: true,
    });
    assignmentRows.forEach((row) => {
      if (row.user_id) {
        platformUserIds.add(String(row.user_id));
      }
    });
  }
  addEntityIds(entityIdsByType, 'platform_user', [...platformUserIds]);

  const clauses = [];
  if (req?.user?.id) {
    clauses.push({ actor_user_id: req.user.id });
  }
  for (const [entityType, ids] of entityIdsByType.entries()) {
    const normalizedIds = uniqueIds([...ids]);
    if (normalizedIds.length === 0) continue;
    clauses.push({
      entity_type: entityType,
      entity_id: { [Op.in]: normalizedIds },
    });
  }

  return clauses;
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
    const row = await AuditLog.create({
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

    try {
      await notificationService.publishFromAuditLog({
        action,
        entityType,
        entityId,
        tenantId: row.tenant_id || tenantId || req?.user?.tenantId || null,
        actorUserId: row.actor_user_id || actorUserId || req?.user?.id || null,
        details,
        requestId: row.request_id || req?.requestId || null,
      });
    } catch (notificationError) {
      // eslint-disable-next-line no-console
      console.error('Failed to publish audit notification:', notificationError.message);
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to persist audit log:', error.message);
  }
};

const listAuditLogs = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const where = applyScopeToQuery(
    {},
    buildAccessContextFromUser(req?.user || {}),
    'tenant',
    {
      tenantKey: 'tenant_id',
    },
  );
  const andClauses = [];

  if (req.user?.isSuperAdmin && req.query.tenantId) {
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
    andClauses.push({
      [Op.or]: [
        { action: { [Op.iLike]: `%${q}%` } },
        { entity_type: { [Op.iLike]: `%${q}%` } },
        { entity_id: { [Op.iLike]: `%${q}%` } },
      ],
    });
  }

  const scopedEntityClauses = await buildScopedAuditEntityClauses(req);
  if (scopedEntityClauses.length > 0) {
    andClauses.push({
      [Op.or]: scopedEntityClauses,
    });
  }

  if (andClauses.length > 0) {
    where[Op.and] = [...(Array.isArray(where[Op.and]) ? where[Op.and] : []), ...andClauses];
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
