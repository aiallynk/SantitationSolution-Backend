const { Op } = require('sequelize');
const { runtimeConfig } = require('../../config/runtime');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { logger } = require('../../core/logging/logger');
const { sequelize, Complaint, Facility, InspectionTask, PlatformUser, TaskAssignmentLog, ToiletUnit } = require('../../models');
const { createAuditLog } = require('../audit/audit.service');
const notificationService = require('../notifications/notification.service');
const { NotificationAudienceKinds, NotificationPriorities, NotificationTypes } = require('../notifications/notification.constants');
const {
  ACTIVE_TASK_STATUSES,
  CRITICAL_COMPLAINT_TASK_TYPE,
  SYSTEM_ASSIGNMENT_SOURCE,
  addMinutes,
  getCriticalComplaintValueSet,
  normalizeToken,
  toNumberOrNull,
} = require('./automation.constants');
const {
  findNearestEligibleWorker,
  resolveSupervisorIds,
} = require('./workerAssignment.service');

const complaintInclude = () => [
  {
    model: Facility,
    attributes: [
      'id',
      'tenant_id',
      'geography_id',
      'zone_geography_id',
      'ward_geography_id',
      'supervisor_user_id',
      'name',
      'code',
      'address_line',
      'latitude',
      'longitude',
    ],
    required: false,
  },
  {
    model: ToiletUnit,
    attributes: [
      'id',
      'facility_id',
      'code',
      'qr_code',
      'status',
      'sector_code',
      'location_label',
      'latitude',
      'longitude',
    ],
    include: [
      {
        model: Facility,
        attributes: [
          'id',
          'tenant_id',
          'geography_id',
          'zone_geography_id',
          'ward_geography_id',
          'supervisor_user_id',
          'name',
          'code',
          'address_line',
          'latitude',
          'longitude',
        ],
        required: false,
      },
    ],
    required: false,
  },
];

const isValueCritical = (value) => {
  const text = String(value || '').trim();
  if (!text) return false;
  const values = getCriticalComplaintValueSet();
  return values.has(text.toLowerCase()) || values.has(normalizeToken(text));
};

const getComplaintLocation = ({ complaint, toilet, facility }) => {
  const latitude =
    toNumberOrNull(toilet?.latitude) ??
    toNumberOrNull(facility?.latitude) ??
    toNumberOrNull(complaint?.latitude);
  const longitude =
    toNumberOrNull(toilet?.longitude) ??
    toNumberOrNull(facility?.longitude) ??
    toNumberOrNull(complaint?.longitude);
  return { latitude, longitude };
};

const getFacility = (complaint) => complaint.Facility || complaint.ToiletUnit?.Facility || null;

const getToilet = (complaint) => complaint.ToiletUnit || null;

const isComplaintCriticalByFields = (complaint) => {
  const toilet = getToilet(complaint);
  return [
    complaint.priority,
    complaint.status,
    complaint.complaint_type,
    toilet?.status,
  ].some(isValueCritical);
};

const isRepeatedUnresolvedComplaint = async (complaint) => {
  if (!complaint.toilet_unit_id) return false;
  const windowMinutes = Number(runtimeConfig.automation.repeatedComplaintWindowMinutes || 0);
  const threshold = Number(runtimeConfig.automation.repeatedComplaintThreshold || 0);
  if (windowMinutes <= 0 || threshold <= 1) return false;

  const since = new Date(Date.now() - windowMinutes * 60000);
  const count = await Complaint.count({
    where: {
      tenant_id: complaint.tenant_id,
      toilet_unit_id: complaint.toilet_unit_id,
      status: { [Op.notIn]: ['resolved', 'rejected'] },
      created_at: { [Op.gte]: since },
    },
  });
  return count >= threshold;
};

const resolveCriticalReason = async (complaint) => {
  if (isComplaintCriticalByFields(complaint)) {
    return 'Complaint priority/status matched critical severity configuration';
  }
  if (await isRepeatedUnresolvedComplaint(complaint)) {
    return 'Repeated unresolved complaints crossed the configured window threshold';
  }
  return null;
};

const findActiveTaskForComplaint = async (complaintId, options = {}) =>
  InspectionTask.findOne({
    where: {
      complaint_id: complaintId,
      task_type: CRITICAL_COMPLAINT_TASK_TYPE,
      status: { [Op.in]: ACTIVE_TASK_STATUSES },
    },
    order: [['created_at', 'DESC']],
    ...options,
  });

const mapTaskForResponse = (task) => ({
  id: task.id,
  complaintId: task.complaint_id,
  tenantId: task.tenant_id,
  facilityId: task.facility_id,
  toiletUnitId: task.toilet_unit_id,
  assignedToUserId: task.assigned_to_user_id,
  taskType: task.task_type,
  priority: task.priority,
  status: task.status,
  title: task.title,
  description: task.description,
  latitude: task.latitude,
  longitude: task.longitude,
  dueAt: task.due_at,
  slaMinutes: task.sla_minutes,
  assignmentSource: task.assignment_source,
  assignmentReason: task.assignment_reason,
  distanceKm: task.distance_km,
  createdAt: task.created_at,
});

const safePublishNotification = async (payload) => {
  try {
    return await notificationService.publishNotification(payload);
  } catch (error) {
    logger.error('Automation notification failed', {
      eventType: payload?.eventType,
      entityId: payload?.entityId,
      error: error.message,
    });
    return [];
  }
};

const notifyAssignedWorker = async ({ task, complaint, toilet, facility, selectedWorker }) => {
  if (!selectedWorker?.worker?.id) return;
  const dueText = task.due_at ? new Date(task.due_at).toISOString() : null;
  const distanceKm = selectedWorker.distanceKm !== null ? Number(selectedWorker.distanceKm).toFixed(2) : null;
  await safePublishNotification({
    recipients: [selectedWorker.worker.id],
    eventType: 'task.critical_complaint.assigned',
    notificationType: NotificationTypes.TASK,
    priority: NotificationPriorities.CRITICAL,
    title: 'Urgent toilet complaint assigned',
    body: `Critical complaint at ${toilet?.code || facility?.name || 'assigned toilet'}. Accept and start the task.`,
    shortBody: `Urgent task | ${toilet?.code || facility?.code || 'Toilet'}${distanceKm ? ` | ${distanceKm} km` : ''}`,
    entityType: 'inspection_task',
    entityId: task.id,
    route: `/ops/tasks/${task.id}`,
    iconKey: 'task',
    severity: 'critical',
    tenantId: task.tenant_id,
    geographyId: facility?.geography_id || null,
    facilityId: task.facility_id,
    audienceKind: NotificationAudienceKinds.TARGETED_LIST,
    createdByUserId: null,
    dedupeKey: `critical-task-worker:${task.id}`,
    metadata: { source: SYSTEM_ASSIGNMENT_SOURCE },
    payload: {
      taskId: task.id,
      complaintId: complaint.id,
      toiletUnitId: toilet?.id || null,
      toiletCode: toilet?.code || null,
      facilityId: facility?.id || null,
      facilityName: facility?.name || null,
      severity: complaint.priority,
      priority: task.priority,
      dueAt: dueText,
      slaMinutes: task.sla_minutes,
      distanceKm,
      latitude: task.latitude,
      longitude: task.longitude,
      actions: ['accept', 'start', 'complete', 'navigate'],
    },
  });
};

const notifySupervisorNoWorker = async ({ task, complaint, toilet, facility, reason }) => {
  const supervisorIds = await resolveSupervisorIds({
    tenantId: complaint.tenant_id,
    facility,
    toilet,
  });
  if (supervisorIds.length === 0) return;
  await safePublishNotification({
    recipients: supervisorIds,
    eventType: 'task.critical_complaint.unassigned',
    notificationType: NotificationTypes.ALERT,
    priority: NotificationPriorities.CRITICAL,
    title: 'Critical complaint is unassigned',
    body: `No eligible worker was available for ${toilet?.code || facility?.name || 'a critical toilet complaint'}.`,
    shortBody: `Unassigned critical complaint | ${toilet?.code || facility?.code || 'Toilet'}`,
    entityType: 'inspection_task',
    entityId: task.id,
    route: `/ops/supervisor/live-map`,
    iconKey: 'alert',
    severity: 'critical',
    tenantId: complaint.tenant_id,
    geographyId: facility?.geography_id || null,
    facilityId: facility?.id || null,
    audienceKind: NotificationAudienceKinds.TARGETED_LIST,
    createdByUserId: null,
    dedupeKey: `critical-task-unassigned:${task.id}`,
    metadata: { source: SYSTEM_ASSIGNMENT_SOURCE, reason },
    payload: {
      taskId: task.id,
      complaintId: complaint.id,
      toiletUnitId: toilet?.id || null,
      toiletCode: toilet?.code || null,
      facilityId: facility?.id || null,
      reason,
    },
  });
};

const createTaskAndAssignmentLog = async ({ complaint, criticalReason, assignment, req = null }) => {
  const toilet = getToilet(complaint);
  const facility = getFacility(complaint);
  if (!facility?.id && !complaint.facility_id) {
    logger.warn('Critical complaint automation skipped because facility is missing', {
      complaintId: complaint.id,
    });
    return { task: null, created: false, reason: 'Complaint has no facility mapping' };
  }

  const now = new Date();
  const priority = isValueCritical(complaint.priority) ? 'critical' : complaint.priority || 'critical';
  const slaMinutes =
    runtimeConfig.automation.slaMinutesByPriority?.[priority] ||
    runtimeConfig.automation.slaMinutesByPriority?.critical ||
    60;
  const location = getComplaintLocation({ complaint, toilet, facility });
  const selected = assignment.selected || null;
  const taskStatus = selected?.worker?.id ? 'assigned' : 'unassigned';
  const title = `Critical complaint - ${toilet?.code || facility?.code || 'toilet'}`;
  const reason = selected?.worker?.id
    ? `${criticalReason}; nearest eligible worker selected`
    : `${criticalReason}; ${assignment.reason || 'no eligible worker found'}`;

  let taskResult;
  try {
    taskResult = await sequelize.transaction(async (transaction) => {
      const existing = await findActiveTaskForComplaint(complaint.id, { transaction });
      if (existing) {
        return { task: existing, created: false };
      }

      const row = await InspectionTask.create(
        {
          tenant_id: complaint.tenant_id,
          facility_id: facility?.id || complaint.facility_id,
          toilet_unit_id: toilet?.id || complaint.toilet_unit_id || null,
          complaint_id: complaint.id,
          assigned_to_user_id: selected?.worker?.id || null,
          assigned_by_user_id: null,
          task_type: CRITICAL_COMPLAINT_TASK_TYPE,
          title,
          description: complaint.description || 'Critical toilet complaint requires immediate action.',
          priority,
          scheduled_at: now,
          sla_minutes: slaMinutes,
          status: taskStatus,
          latitude: location.latitude,
          longitude: location.longitude,
          due_at: addMinutes(now, slaMinutes),
          assignment_source: SYSTEM_ASSIGNMENT_SOURCE,
          assignment_reason: reason,
          distance_km: selected?.distanceKm !== null && selected?.distanceKm !== undefined ? Number(selected.distanceKm.toFixed(3)) : null,
          worker_location_snapshot: selected?.heartbeatSnapshot || null,
          critical_detected_at: now,
          metadata: {
            criticalReason,
            candidateCount: assignment.candidates?.length || 0,
            selectedWorkerId: selected?.worker?.id || null,
            automationVersion: '2026-05-14',
          },
          created_at: now,
          updated_at: now,
        },
        { transaction }
      );

      await TaskAssignmentLog.create(
        {
          tenant_id: complaint.tenant_id,
          task_id: row.id,
          complaint_id: complaint.id,
          toilet_unit_id: toilet?.id || complaint.toilet_unit_id || null,
          worker_id: selected?.worker?.id || null,
          supervisor_user_id: facility?.supervisor_user_id || null,
          assigned_by_user_id: null,
          assignment_source: SYSTEM_ASSIGNMENT_SOURCE,
          reason,
          status: taskStatus,
          distance_km: row.distance_km,
          worker_location_snapshot: selected?.heartbeatSnapshot || null,
          metadata: {
            candidateCount: assignment.candidates?.length || 0,
            lowBatteryFallback: Boolean(selected?.lowBattery),
            noWorkerReason: selected ? null : assignment.reason,
          },
        },
        { transaction }
      );

      await complaint.update(
        {
          assigned_to_user_id: selected?.worker?.id || complaint.assigned_to_user_id || null,
          status: selected?.worker?.id ? 'assigned' : complaint.status,
          dispatch_requested_at: complaint.dispatch_requested_at || now,
          dispatch_requested_by_user_id: complaint.dispatch_requested_by_user_id || null,
          updated_at: now,
        },
        { transaction }
      );

      return { task: row, created: true };
    });
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      const existing = await findActiveTaskForComplaint(complaint.id);
      if (existing) {
        return {
          task: existing,
          created: false,
          reason: 'Active critical complaint task already exists',
        };
      }
    }
    throw error;
  }

  const createdTask = taskResult.task;
  if (!taskResult.created) {
    return {
      task: createdTask,
      created: false,
      reason: 'Active critical complaint task already exists',
    };
  }

  await createAuditLog({
    req,
    actorUserId: null,
    tenantId: complaint.tenant_id,
    action: 'complaint.critical_detected',
    entityType: 'complaint',
    entityId: complaint.id,
    details: {
      taskId: createdTask.id,
      assignedWorkerId: selected?.worker?.id || null,
      reason,
      source: SYSTEM_ASSIGNMENT_SOURCE,
    },
  });

  if (selected?.worker?.id) {
    await notifyAssignedWorker({
      task: createdTask,
      complaint,
      toilet,
      facility,
      selectedWorker: selected,
    });
  } else {
    await notifySupervisorNoWorker({
      task: createdTask,
      complaint,
      toilet,
      facility,
      reason: assignment.reason,
    });
  }

  eventBus.emit(EVENTS.TASK_UPDATED, {
    tenantId: createdTask.tenant_id,
    taskId: createdTask.id,
    complaintId: complaint.id,
    status: createdTask.status,
    assignedToUserId: createdTask.assigned_to_user_id || null,
  });

  return { task: createdTask, created: true, reason };
};

const handleComplaintCriticality = async ({ complaintId, req = null } = {}) => {
  const complaint = await Complaint.findByPk(complaintId, { include: complaintInclude() });
  if (!complaint) {
    return { triggered: false, reason: 'Complaint not found' };
  }
  if (['resolved', 'rejected'].includes(String(complaint.status || '').toLowerCase())) {
    return { triggered: false, reason: 'Complaint is already terminal' };
  }

  const criticalReason = await resolveCriticalReason(complaint);
  if (!criticalReason) {
    return { triggered: false, reason: 'Complaint is not critical' };
  }

  const existing = await findActiveTaskForComplaint(complaint.id);
  if (existing) {
    return {
      triggered: true,
      deduped: true,
      task: mapTaskForResponse(existing),
      reason: 'Active critical complaint task already exists',
    };
  }

  const toilet = getToilet(complaint);
  const facility = getFacility(complaint);
  const location = getComplaintLocation({ complaint, toilet, facility });
  const assignment = await findNearestEligibleWorker({
    tenantId: complaint.tenant_id,
    facility,
    toilet,
    location,
  });
  const { task, created, reason } = await createTaskAndAssignmentLog({
    complaint,
    criticalReason,
    assignment,
    req,
  });

  return {
    triggered: Boolean(task),
    created,
    task: task ? mapTaskForResponse(task) : null,
    assignment: {
      workerId: assignment.selected?.worker?.id || null,
      workerName: assignment.selected?.worker?.full_name || null,
      distanceKm: assignment.selected?.distanceKm ?? null,
      candidateCount: assignment.candidates?.length || 0,
    },
    reason,
  };
};

const getAssignableWorkerSummaries = async ({ tenantId, workerIds }) => {
  if (!Array.isArray(workerIds) || workerIds.length === 0) return [];
  const rows = await PlatformUser.findAll({
    where: {
      tenant_id: tenantId,
      id: { [Op.in]: workerIds },
      status: 'active',
    },
    attributes: ['id', 'full_name', 'email', 'employee_code'],
    order: [['full_name', 'ASC']],
  });
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    employeeCode: row.employee_code || null,
  }));
};

module.exports = {
  CRITICAL_COMPLAINT_TASK_TYPE,
  getAssignableWorkerSummaries,
  handleComplaintCriticality,
  isComplaintCriticalByFields,
  resolveCriticalReason,
};
