const { Op } = require('sequelize');
const {
  InspectionTask,
  Facility,
  ToiletBlock,
  ToiletUnit,
  PlatformUser,
  TaskAssignmentLog,
} = require('../../models');
const AppError = require('../../core/errors/AppError');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const { logger } = require('../../core/logging/logger');
const platformService = require('../platform/platform.service');
const notificationService = require('../notifications/notification.service');
const { NotificationAudienceKinds, NotificationPriorities, NotificationTypes } = require('../notifications/notification.constants');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');

const scopedWhere = (req, extra = {}) => {
  return applyScopeToQuery(
    { ...extra },
    buildAccessContextFromUser(req?.user || {}),
    'task',
    { tenantKey: 'tenant_id', facilityKey: 'facility_id' },
  );
};

const hasPermission = (req, code) =>
  Boolean((req.user?.permissionCodes || []).includes(code));

const mapTask = (task) => ({
  id: task.id,
  tenantId: task.tenant_id,
  facilityId: task.facility_id,
  toiletUnitId: task.toilet_unit_id,
  complaintId: task.complaint_id || null,
  assignedToUserId: task.assigned_to_user_id,
  assignedByUserId: task.assigned_by_user_id || null,
  taskType: task.task_type,
  title: task.title || null,
  description: task.description || null,
  priority: task.priority || 'medium',
  scheduledAt: task.scheduled_at,
  dueAt: task.due_at || null,
  slaMinutes: task.sla_minutes,
  status: task.status,
  acceptedAt: task.accepted_at || null,
  startedAt: task.started_at,
  completedAt: task.completed_at,
  cancelledAt: task.cancelled_at || null,
  assignmentSource: task.assignment_source || null,
  assignmentReason: task.assignment_reason || null,
  distanceKm: task.distance_km || null,
  latitude: task.latitude || null,
  longitude: task.longitude || null,
  assignee: task.assignee
    ? {
        id: task.assignee.id,
        fullName: task.assignee.full_name,
        email: task.assignee.email,
        employeeCode: task.assignee.employee_code || null,
      }
    : null,
  facility: task.Facility
    ? {
        id: task.Facility.id,
        code: task.Facility.code,
        name: task.Facility.name,
      }
    : null,
  toiletUnit: task.ToiletUnit
    ? {
        id: task.ToiletUnit.id,
        code: task.ToiletUnit.code,
        qrCode: task.ToiletUnit.qr_code || task.ToiletUnit.code,
        unitType: task.ToiletUnit.unit_type,
      }
    : null,
});

const listTasks = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query, {
    page: 1,
    limit: 20,
    maxLimit: 100,
  });
  const where = scopedWhere(req);
  if (req.query.status) {
    where.status = req.query.status;
  }
  if (req.query.assignedToUserId) {
    where.assigned_to_user_id = req.query.assignedToUserId;
  }
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }

  const canManageTasks = hasPermission(req, 'task.manage');
  if (!req.user.isSuperAdmin && !canManageTasks) {
    where.assigned_to_user_id = req.user.id;
  }

  const { rows, count } = await InspectionTask.findAndCountAll({
    where,
    include: [
      { model: Facility },
      { model: ToiletUnit },
      {
        model: PlatformUser,
        as: 'assignee',
        attributes: ['id', 'full_name', 'email', 'employee_code'],
        required: false,
      },
    ],
    order: [['scheduled_at', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map(mapTask),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getTaskById = async (req) => {
  const task = await InspectionTask.findByPk(req.params.id, {
    include: [
      { model: Facility },
      { model: ToiletUnit },
      {
        model: PlatformUser,
        as: 'assignee',
        attributes: ['id', 'full_name', 'email', 'employee_code'],
        required: false,
      },
    ],
  });
  if (!task) {
    throw new AppError('Task not found', 404, { code: 'TASK_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && task.tenant_id !== req.user.tenantId) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, task.facility_id || null)) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const canManageTasks = hasPermission(req, 'task.manage');
  if (!req.user.isSuperAdmin && !canManageTasks && task.assigned_to_user_id !== req.user.id) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  return mapTask(task);
};

const getMyTasks = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query, {
    page: 1,
    limit: 20,
    maxLimit: 100,
  });
  const where = scopedWhere(req, { assigned_to_user_id: req.user.id });
  if (req.query.status) {
    where.status = req.query.status;
  }

  const { rows, count } = await InspectionTask.findAndCountAll({
    where,
    include: [
      { model: Facility },
      { model: ToiletUnit },
      {
        model: PlatformUser,
        as: 'assignee',
        attributes: ['id', 'full_name', 'email', 'employee_code'],
        required: false,
      },
    ],
    order: [['scheduled_at', 'ASC']],
    limit,
    offset,
  });

  return {
    items: rows.map(mapTask),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const createTask = async (req) => {
  const facility = await Facility.findByPk(req.body.facilityId);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  let toiletUnit = null;
  if (req.body.toiletUnitId) {
    toiletUnit = await ToiletUnit.findByPk(req.body.toiletUnitId);
    if (!toiletUnit) {
      throw new AppError('Toilet unit not found', 404, { code: 'TOILET_UNIT_NOT_FOUND' });
    }
  }

  const row = await InspectionTask.create({
    tenant_id: facility.tenant_id,
    facility_id: facility.id,
    toilet_unit_id: toiletUnit?.id || null,
    assigned_to_user_id: req.body.assignedToUserId,
    task_type: req.body.taskType,
    scheduled_at: req.body.scheduledAt ? new Date(req.body.scheduledAt) : new Date(),
    sla_minutes: req.body.slaMinutes || null,
    status: req.body.status || 'pending',
  });

  const task = await InspectionTask.findByPk(row.id, {
    include: [
      { model: Facility },
      { model: ToiletUnit },
      {
        model: PlatformUser,
        as: 'assignee',
        attributes: ['id', 'full_name', 'email', 'employee_code'],
        required: false,
      },
    ],
  });

  await createAuditLog({
    req,
    tenantId: facility.tenant_id,
    action: 'task.create',
    entityType: 'inspection_task',
    entityId: row.id,
    details: {
      assignedToUserId: row.assigned_to_user_id,
      taskType: row.task_type,
      facilityId: row.facility_id,
      toiletUnitId: row.toilet_unit_id || null,
      scheduledAt: row.scheduled_at,
    },
  });

  return mapTask(task);
};

const ensureAssigneeInTenantScope = async ({ req, assignedToUserId }) => {
  const assignee = await PlatformUser.findByPk(assignedToUserId, {
    attributes: ['id', 'tenant_id', 'status'],
  });
  if (!assignee || assignee.status !== 'active') {
    throw new AppError('assignedToUserId is invalid', 400, {
      code: 'ASSIGNEE_NOT_FOUND',
    });
  }
  if (!req.user.isSuperAdmin && assignee.tenant_id !== req.user.tenantId) {
    throw new AppError('assignedToUserId is out of tenant scope', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  return assignee;
};

const toBlockToken = (value, fallback = 'AUTO') => {
  const token = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return token || fallback;
};

const resolveDispatchBlockForFacility = async ({
  req,
  facility,
  requestedToiletBlockId = null,
}) => {
  if (requestedToiletBlockId) {
    const block = await ToiletBlock.findByPk(requestedToiletBlockId, {
      attributes: ['id', 'facility_id'],
    });
    if (!block) {
      throw new AppError('Toilet block not found', 404, { code: 'TOILET_BLOCK_NOT_FOUND' });
    }
    if (String(block.facility_id || '') !== String(facility.id || '')) {
      throw new AppError('toiletBlockId does not belong to facilityId', 400, {
        code: 'BLOCK_FACILITY_MISMATCH',
      });
    }
    return block.id;
  }

  const existing = await ToiletBlock.findOne({
    where: { facility_id: facility.id },
    attributes: ['id'],
    order: [['created_at', 'ASC']],
  });
  if (existing) return existing.id;

  const blockBaseCode = `${toBlockToken(facility.code || facility.name || 'AUTO')}-AUTO`.slice(
    0,
    110
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidateCode =
      attempt === 0 ? blockBaseCode : `${blockBaseCode}-${String(attempt + 1)}`.slice(0, 120);
    const duplicate = await ToiletBlock.findOne({
      where: {
        facility_id: facility.id,
        code: { [Op.iLike]: candidateCode },
      },
      attributes: ['id'],
    });
    if (duplicate) continue;

    const row = await ToiletBlock.create({
      facility_id: facility.id,
      code: candidateCode,
      name: attempt === 0 ? 'Auto Block' : `Auto Block ${attempt + 1}`,
      gender_type: null,
      status: 'active',
    });

    await createAuditLog({
      req,
      tenantId: facility.tenant_id,
      action: 'toilet_block.create.auto_dispatch',
      entityType: 'toilet_block',
      entityId: row.id,
      details: {
        facilityId: facility.id,
        source: 'dispatch_board',
      },
    });

    return row.id;
  }

  throw new AppError('Unable to allocate a toilet block for this facility', 409, {
    code: 'TOILET_BLOCK_ALLOCATION_FAILED',
  });
};

const createToiletAndDispatchTask = async (req) => {
  const facility = await Facility.findByPk(req.body.facilityId, {
    attributes: ['id', 'tenant_id', 'code', 'name'],
  });
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    throw new AppError('Facility out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  await ensureAssigneeInTenantScope({
    req,
    assignedToUserId: req.body.assignedToUserId,
  });

  const toiletBlockId = await resolveDispatchBlockForFacility({
    req,
    facility,
    requestedToiletBlockId: req.body.toiletBlockId || null,
  });

  const unitType = sanitizeText(req.body.unitType, 40) || 'wc';
  const toiletCode = sanitizeText(req.body.toiletCode, 120);
  const locationLabel = sanitizeText(req.body.locationLabel, 300);
  const taskType = sanitizeText(req.body.taskType, 80) || 'routine_cleaning';
  const slaMinutesRaw = req.body.slaMinutes;
  const slaMinutes =
    slaMinutesRaw === undefined || slaMinutesRaw === null || String(slaMinutesRaw).trim() === ''
      ? null
      : Number(slaMinutesRaw);
  if (slaMinutes !== null && !Number.isFinite(slaMinutes)) {
    throw new AppError('slaMinutes must be a valid number when provided', 400, {
      code: 'VALIDATION_ERROR',
    });
  }

  const toiletUnit = await platformService.createUnit({
    ...req,
    body: {
      facilityId: facility.id,
      toiletBlockId,
      code: toiletCode,
      unitType,
      locationLabel: locationLabel || undefined,
      sectorCode: req.body.sectorCode,
      latitude: req.body.latitude,
      longitude: req.body.longitude,
    },
  });

  const task = await createTask({
    ...req,
    body: {
      facilityId: facility.id,
      toiletUnitId: toiletUnit.id,
      assignedToUserId: req.body.assignedToUserId,
      taskType,
      slaMinutes,
      scheduledAt: req.body.scheduledAt || new Date().toISOString(),
      status: 'pending',
    },
  });

  await TaskAssignmentLog.create({
    tenant_id: task.tenantId,
    task_id: task.id,
    complaint_id: null,
    toilet_unit_id: task.toiletUnitId || toiletUnit.id,
    worker_id: task.assignedToUserId,
    supervisor_user_id: req.user.id,
    assigned_by_user_id: req.user.id,
    assignment_source: 'dispatch_toilet_create',
    reason: 'Toilet created from dispatch board and assigned to worker',
    status: 'assigned',
  });

  return {
    toiletUnit,
    task,
  };
};

const emitTaskUpdated = (task) => {
  eventBus.emit(EVENTS.TASK_UPDATED, {
    tenantId: task.tenant_id,
    taskId: task.id,
    status: task.status,
    assignedToUserId: task.assigned_to_user_id || null,
    complaintId: task.complaint_id || null,
  });
};

const ensureTaskVisible = (req, task) => {
  if (!req.user.isSuperAdmin && task.tenant_id !== req.user.tenantId) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, task.facility_id || null)) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
};

const acceptTask = async (req) => {
  const task = await InspectionTask.findByPk(req.params.id);
  if (!task) {
    throw new AppError('Task not found', 404, { code: 'TASK_NOT_FOUND' });
  }
  ensureTaskVisible(req, task);
  if (task.assigned_to_user_id !== req.user.id && !req.user.isSuperAdmin) {
    throw new AppError('Task can only be accepted by assigned user', 403, {
      code: 'TASK_NOT_ASSIGNEE',
    });
  }
  if (['completed', 'cancelled'].includes(task.status)) {
    throw new AppError('Completed or cancelled task cannot be accepted', 409, {
      code: 'TASK_TERMINAL',
    });
  }
  if (!task.assigned_to_user_id) {
    throw new AppError('Unassigned task must be assigned before it can be accepted', 409, {
      code: 'TASK_UNASSIGNED',
    });
  }

  await task.update({
    status: 'accepted',
    accepted_at: task.accepted_at || new Date(),
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    tenantId: task.tenant_id,
    action: 'task.accept',
    entityType: 'inspection_task',
    entityId: task.id,
  });
  emitTaskUpdated(task);

  return getTaskById(req);
};

const startTask = async (req) => {
  const task = await InspectionTask.findByPk(req.params.id);
  if (!task) {
    throw new AppError('Task not found', 404, { code: 'TASK_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && task.tenant_id !== req.user.tenantId) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, task.facility_id || null)) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (task.assigned_to_user_id !== req.user.id && !req.user.isSuperAdmin) {
    throw new AppError('Task can only be started by assigned user', 403, {
      code: 'TASK_NOT_ASSIGNEE',
    });
  }

  await task.update({
    status: 'in_progress',
    accepted_at: task.accepted_at || new Date(),
    started_at: task.started_at || new Date(),
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    tenantId: task.tenant_id,
    action: 'task.start',
    entityType: 'inspection_task',
    entityId: task.id,
  });
  emitTaskUpdated(task);

  return mapTask(task);
};

const completeTask = async (req) => {
  const task = await InspectionTask.findByPk(req.params.id);
  if (!task) {
    throw new AppError('Task not found', 404, { code: 'TASK_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && task.tenant_id !== req.user.tenantId) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, task.facility_id || null)) {
    throw new AppError('Task out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (task.assigned_to_user_id !== req.user.id && !req.user.isSuperAdmin) {
    throw new AppError('Task can only be completed by assigned user', 403, {
      code: 'TASK_NOT_ASSIGNEE',
    });
  }

  await task.update({
    status: 'completed',
    completed_at: new Date(),
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    tenantId: task.tenant_id,
    action: 'task.complete',
    entityType: 'inspection_task',
    entityId: task.id,
  });
  emitTaskUpdated(task);

  return mapTask(task);
};

const notifyReassignedWorker = async ({ task, req }) => {
  if (!task.assigned_to_user_id) return;
  try {
    await notificationService.publishNotification({
      recipients: [task.assigned_to_user_id],
      eventType: 'task.reassign',
      notificationType: NotificationTypes.TASK,
      priority: task.priority === 'critical' ? NotificationPriorities.CRITICAL : NotificationPriorities.HIGH,
      title: task.priority === 'critical' ? 'Urgent task reassigned to you' : 'Task reassigned to you',
      body: task.title || 'A sanitation task has been assigned to you.',
      shortBody: task.title || 'Task assigned',
      entityType: 'inspection_task',
      entityId: task.id,
      route: `/ops/tasks/${task.id}`,
      iconKey: 'task',
      severity: task.priority || 'info',
      tenantId: task.tenant_id,
      facilityId: task.facility_id || null,
      audienceKind: NotificationAudienceKinds.TARGETED_LIST,
      createdByUserId: req.user.id,
      dedupeKey: `task-reassign:${task.id}:${task.assigned_to_user_id}:${Math.floor(Date.now() / 60000)}`,
      metadata: { source: 'manual_reassign' },
      payload: {
        taskId: task.id,
        complaintId: task.complaint_id || null,
        priority: task.priority,
        dueAt: task.due_at || null,
      },
    });
  } catch (error) {
    logger.warn('Failed to notify reassigned worker', {
      taskId: task.id,
      workerId: task.assigned_to_user_id,
      error: error.message,
    });
  }
};

const reassignTask = async (req) => {
  const task = await InspectionTask.findByPk(req.params.id);
  if (!task) {
    throw new AppError('Task not found', 404, { code: 'TASK_NOT_FOUND' });
  }
  ensureTaskVisible(req, task);
  if (['completed', 'cancelled'].includes(task.status)) {
    throw new AppError('Completed or cancelled task cannot be reassigned', 409, {
      code: 'TASK_TERMINAL',
    });
  }

  const assignedToUserId = req.body.assignedToUserId || null;
  let assignee = null;
  if (assignedToUserId) {
    assignee = await PlatformUser.findByPk(assignedToUserId, {
      attributes: ['id', 'tenant_id', 'status'],
    });
    if (!assignee || assignee.status !== 'active') {
      throw new AppError('assignedToUserId is invalid', 400, {
        code: 'ASSIGNEE_NOT_FOUND',
      });
    }
    if (!req.user.isSuperAdmin && assignee.tenant_id !== req.user.tenantId) {
      throw new AppError('assignedToUserId is out of tenant scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }
  }

  const nextStatus = assignedToUserId ? 'assigned' : 'unassigned';
  await task.update({
    assigned_to_user_id: assignedToUserId,
    assigned_by_user_id: req.user.id,
    status: nextStatus,
    accepted_at: null,
    started_at: nextStatus === 'unassigned' ? null : task.started_at,
    assignment_source: assignedToUserId ? 'manual_reassign' : 'manual_unassign',
    assignment_reason: req.body.reason || task.assignment_reason || null,
    updated_at: new Date(),
  });

  await TaskAssignmentLog.create({
    tenant_id: task.tenant_id,
    task_id: task.id,
    complaint_id: task.complaint_id || null,
    toilet_unit_id: task.toilet_unit_id || null,
    worker_id: assignedToUserId,
    supervisor_user_id: req.user.id,
    assigned_by_user_id: req.user.id,
    assignment_source: assignedToUserId ? 'manual_reassign' : 'manual_unassign',
    reason: req.body.reason || 'Manual task assignment update',
    status: nextStatus,
  });

  await createAuditLog({
    req,
    tenantId: task.tenant_id,
    action: 'task.reassign',
    entityType: 'inspection_task',
    entityId: task.id,
    details: {
      assignedToUserId,
      reason: req.body.reason || null,
    },
  });

  await notifyReassignedWorker({ task, req });
  emitTaskUpdated(task);
  return getTaskById(req);
};

module.exports = {
  listTasks,
  getTaskById,
  getMyTasks,
  createTask,
  createToiletAndDispatchTask,
  acceptTask,
  startTask,
  completeTask,
  reassignTask,
};
