const { Op } = require('sequelize');
const { runtimeConfig } = require('../../config/runtime');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { logger } = require('../../core/logging/logger');
const { Facility, InspectionTask, PlatformUser, TaskReminderLog, ToiletUnit } = require('../../models');
const notificationService = require('../notifications/notification.service');
const { NotificationAudienceKinds, NotificationPriorities, NotificationTypes } = require('../notifications/notification.constants');
const { ACTIVE_TASK_STATUSES, CRITICAL_COMPLAINT_TASK_TYPE } = require('./automation.constants');
const { getLatestHeartbeatsByWorkerId, resolveSupervisorIds } = require('./workerAssignment.service');

let reminderTimer = null;
let reminderRunning = false;

const reminderTypes = Object.freeze({
  ACCEPTANCE_PENDING: 'acceptance_pending',
  START_PENDING: 'start_pending',
  SLA_WARNING: 'sla_warning',
  SLA_BREACHED: 'sla_breached',
  WORKER_OFFLINE: 'worker_offline',
});

const minutesSince = (value) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - ts) / 60000));
};

const minutesUntil = (value) => {
  if (!value) return Number.POSITIVE_INFINITY;
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Math.floor((ts - Date.now()) / 60000);
};

const hasReminder = async ({ taskId, reminderType }) =>
  TaskReminderLog.findOne({
    where: {
      task_id: taskId,
      reminder_type: reminderType,
      status: { [Op.in]: ['sent', 'queued'] },
    },
    attributes: ['id'],
    raw: true,
  });

const createReminderLog = async ({ task, reminderType, workerId = null, status = 'sent', channel = 'in_app', metadata = null }) =>
  TaskReminderLog.create({
    tenant_id: task.tenant_id,
    task_id: task.id,
    worker_id: workerId,
    reminder_type: reminderType,
    sent_at: new Date(),
    status,
    channel,
    metadata,
  });

const safePublish = async (payload) => {
  try {
    await notificationService.publishNotification(payload);
    return 'sent';
  } catch (error) {
    logger.error('Task reminder notification failed', {
      eventType: payload?.eventType,
      entityId: payload?.entityId,
      error: error.message,
    });
    return 'failed';
  }
};

const publishWorkerReminder = async ({ task, reminderType, title, body }) => {
  if (!task.assigned_to_user_id) return 'skipped';
  return safePublish({
    recipients: [task.assigned_to_user_id],
    eventType: `task.reminder.${reminderType}`,
    notificationType: NotificationTypes.TASK,
    priority: task.priority === 'critical' ? NotificationPriorities.CRITICAL : NotificationPriorities.HIGH,
    title,
    body,
    shortBody: title,
    entityType: 'inspection_task',
    entityId: task.id,
    route: `/ops/tasks/${task.id}`,
    iconKey: 'task',
    severity: task.priority || 'warning',
    tenantId: task.tenant_id,
    facilityId: task.facility_id || null,
    audienceKind: NotificationAudienceKinds.TARGETED_LIST,
    dedupeKey: `task-reminder:${task.id}:${reminderType}`,
    metadata: { reminderType },
    payload: {
      taskId: task.id,
      complaintId: task.complaint_id || null,
      reminderType,
      dueAt: task.due_at || null,
      priority: task.priority,
    },
  });
};

const publishSupervisorEscalation = async ({ task, reminderType, title, body }) => {
  const supervisorIds = await resolveSupervisorIds({
    tenantId: task.tenant_id,
    facility: task.Facility || null,
    toilet: task.ToiletUnit || null,
    workerId: task.assigned_to_user_id || null,
  });
  if (supervisorIds.length === 0) return 'skipped';
  return safePublish({
    recipients: supervisorIds,
    eventType: `task.escalation.${reminderType}`,
    notificationType: NotificationTypes.ALERT,
    priority: NotificationPriorities.CRITICAL,
    title,
    body,
    shortBody: title,
    entityType: 'inspection_task',
    entityId: task.id,
    route: '/ops/supervisor/live-map',
    iconKey: 'alert',
    severity: 'critical',
    tenantId: task.tenant_id,
    facilityId: task.facility_id || null,
    audienceKind: NotificationAudienceKinds.TARGETED_LIST,
    dedupeKey: `task-escalation:${task.id}:${reminderType}`,
    metadata: { reminderType },
    payload: {
      taskId: task.id,
      complaintId: task.complaint_id || null,
      workerId: task.assigned_to_user_id || null,
      reminderType,
      dueAt: task.due_at || null,
    },
  });
};

const maybeSendReminder = async ({ task, reminderType, workerId, send }) => {
  if (await hasReminder({ taskId: task.id, reminderType })) {
    return false;
  }
  const status = await send();
  await createReminderLog({
    task,
    reminderType,
    workerId,
    status,
    metadata: { generatedBy: 'automation_reminder_job' },
  });
  return true;
};

const processTaskReminder = async ({ task, latestHeartbeat = null }) => {
  const acceptReminderMinutes = Number(runtimeConfig.automation.acceptReminderMinutes || 10);
  const startReminderMinutes = Number(runtimeConfig.automation.startReminderMinutes || 20);
  const slaWarningMinutes = Number(runtimeConfig.automation.slaWarningMinutes || 15);
  const offlineEscalationMinutes = Number(runtimeConfig.automation.offlineEscalationMinutes || 45);
  const status = String(task.status || '').toLowerCase();
  const workerId = task.assigned_to_user_id || null;

  if (status === 'assigned' && !task.accepted_at && minutesSince(task.created_at) >= acceptReminderMinutes) {
    await maybeSendReminder({
      task,
      reminderType: reminderTypes.ACCEPTANCE_PENDING,
      workerId,
      send: () =>
        publishWorkerReminder({
          task,
          reminderType: reminderTypes.ACCEPTANCE_PENDING,
          title: 'Please accept urgent task',
          body: task.title || 'A critical sanitation task is waiting for your acceptance.',
        }),
    });
  }

  if (['assigned', 'accepted', 'pending'].includes(status) && task.accepted_at && !task.started_at && minutesSince(task.accepted_at) >= startReminderMinutes) {
    await maybeSendReminder({
      task,
      reminderType: reminderTypes.START_PENDING,
      workerId,
      send: () =>
        publishWorkerReminder({
          task,
          reminderType: reminderTypes.START_PENDING,
          title: 'Please start urgent task',
          body: task.title || 'A critical sanitation task has not been started yet.',
        }),
    });
  }

  if (task.due_at && minutesUntil(task.due_at) <= slaWarningMinutes && minutesUntil(task.due_at) > 0) {
    await maybeSendReminder({
      task,
      reminderType: reminderTypes.SLA_WARNING,
      workerId,
      send: () =>
        publishWorkerReminder({
          task,
          reminderType: reminderTypes.SLA_WARNING,
          title: 'Task nearing SLA deadline',
          body: task.title || 'A critical sanitation task is close to its SLA deadline.',
        }),
    });
  }

  if (task.due_at && minutesUntil(task.due_at) <= 0 && !['completed', 'cancelled'].includes(status)) {
    if (task.status !== 'overdue') {
      await task.update({ status: 'overdue', updated_at: new Date() });
      eventBus.emit(EVENTS.TASK_UPDATED, {
        tenantId: task.tenant_id,
        taskId: task.id,
        status: 'overdue',
        assignedToUserId: task.assigned_to_user_id || null,
        complaintId: task.complaint_id || null,
      });
    }
    await maybeSendReminder({
      task,
      reminderType: reminderTypes.SLA_BREACHED,
      workerId,
      send: () =>
        publishSupervisorEscalation({
          task,
          reminderType: reminderTypes.SLA_BREACHED,
          title: 'Critical task breached SLA',
          body: task.title || 'A critical sanitation task has breached its SLA.',
        }),
    });
  }

  if (workerId && latestHeartbeat) {
    const heartbeatAge = minutesSince(latestHeartbeat.captured_at);
    if (heartbeatAge >= offlineEscalationMinutes) {
      await maybeSendReminder({
        task,
        reminderType: reminderTypes.WORKER_OFFLINE,
        workerId,
        send: () =>
          publishSupervisorEscalation({
            task,
            reminderType: reminderTypes.WORKER_OFFLINE,
            title: 'Assigned worker location is stale',
            body: 'A worker assigned to a critical task has not sent a recent heartbeat.',
          }),
      });
    }
  }
};

const runReminderSweep = async () => {
  if (reminderRunning) return { skipped: true };
  reminderRunning = true;
  try {
    const tasks = await InspectionTask.findAll({
      where: {
        status: { [Op.in]: ACTIVE_TASK_STATUSES },
        [Op.or]: [
          { task_type: CRITICAL_COMPLAINT_TASK_TYPE },
          { priority: 'critical' },
        ],
      },
      include: [
        { model: Facility, required: false },
        { model: ToiletUnit, required: false },
        {
          model: PlatformUser,
          as: 'assignee',
          required: false,
          attributes: ['id', 'full_name', 'email', 'employee_code'],
        },
      ],
      limit: 250,
      order: [['due_at', 'ASC'], ['created_at', 'ASC']],
    });
    const workerIds = [...new Set(tasks.map((task) => task.assigned_to_user_id).filter(Boolean))];
    const tenantIds = [...new Set(tasks.map((task) => task.tenant_id).filter(Boolean))];
    const heartbeatMaps = new Map();
    for (const tenantId of tenantIds) {
      heartbeatMaps.set(
        tenantId,
        await getLatestHeartbeatsByWorkerId({
          tenantId,
          workerIds,
        })
      );
    }

    for (const task of tasks) {
      const latestHeartbeat = heartbeatMaps.get(task.tenant_id)?.get(String(task.assigned_to_user_id || '')) || null;
      await processTaskReminder({ task, latestHeartbeat });
    }
    return { processed: tasks.length };
  } catch (error) {
    logger.error('Task reminder sweep failed', { error: error.message });
    return { error: error.message };
  } finally {
    reminderRunning = false;
  }
};

const startReminderScheduler = () => {
  if (reminderTimer) return;
  const intervalMs = Number(runtimeConfig.automation.reminderJobIntervalMs || 60000);
  reminderTimer = setInterval(() => {
    void runReminderSweep();
  }, intervalMs);
  reminderTimer.unref?.();
  logger.info('Task reminder scheduler started', { intervalMs });
};

const stopReminderScheduler = () => {
  if (!reminderTimer) return;
  clearInterval(reminderTimer);
  reminderTimer = null;
};

module.exports = {
  reminderTypes,
  processTaskReminder,
  runReminderSweep,
  startReminderScheduler,
  stopReminderScheduler,
};
