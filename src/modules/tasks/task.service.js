const { InspectionTask, Facility, ToiletUnit } = require('../../models');
const AppError = require('../../core/errors/AppError');
const { normalizePagination } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const {
  applyTenantScope,
  applyFacilityScope,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');

const scopedWhere = (req, extra = {}) => {
  let where = { ...extra };
  where = applyTenantScope(where, req);
  where = applyFacilityScope(where, req);
  return where;
};

const hasPermission = (req, code) =>
  Boolean((req.user?.permissionCodes || []).includes(code));

const mapTask = (task) => ({
  id: task.id,
  tenantId: task.tenant_id,
  facilityId: task.facility_id,
  toiletUnitId: task.toilet_unit_id,
  assignedToUserId: task.assigned_to_user_id,
  taskType: task.task_type,
  scheduledAt: task.scheduled_at,
  slaMinutes: task.sla_minutes,
  status: task.status,
  startedAt: task.started_at,
  completedAt: task.completed_at,
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
    include: [{ model: Facility }, { model: ToiletUnit }],
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
    include: [{ model: Facility }, { model: ToiletUnit }],
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
    include: [{ model: Facility }, { model: ToiletUnit }],
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
    include: [{ model: Facility }, { model: ToiletUnit }],
  });

  await createAuditLog({
    req,
    tenantId: facility.tenant_id,
    action: 'task.create',
    entityType: 'inspection_task',
    entityId: row.id,
  });

  return mapTask(task);
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

  return mapTask(task);
};

module.exports = {
  listTasks,
  getTaskById,
  getMyTasks,
  createTask,
  startTask,
  completeTask,
};
