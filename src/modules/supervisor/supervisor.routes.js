const express = require('express');
const supervisorController = require('./supervisor.controller');
const taskController = require('../tasks/task.controller');
const {
  protect,
  requireAction,
  requirePermissions,
  requireRoles,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');
const { validate } = require('../../core/middleware/validate');
const { validateTaskReassign } = require('../tasks/task.validator');
const { supervisorApiRateLimit } = require('../../core/security/rateLimit');

const router = express.Router();

router.use('/supervisor', protect);
router.use('/supervisor', supervisorApiRateLimit);
router.use(
  '/supervisor',
  requireRoles('supervisor', 'auditor'),
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
);

router.get(
  '/supervisor/overview',
  requireRouteKey(RouteKeys.SUPERVISOR_OVERVIEW),
  requirePermissions('supervisor.overview.read'),
  supervisorController.getOverview
);

router.get(
  '/supervisor/workers',
  requireRouteKey(RouteKeys.SUPERVISOR_WORKERS),
  requirePermissions('supervisor.workers.read'),
  supervisorController.getWorkers
);

router.get(
  '/supervisor/workers/:workerId',
  requireRouteKey(RouteKeys.SUPERVISOR_WORKERS),
  requirePermissions('supervisor.workers.read'),
  supervisorController.getWorkerDetail
);

router.get(
  '/supervisor/attendance',
  requireRouteKey(RouteKeys.SUPERVISOR_ATTENDANCE),
  requirePermissions('worker.attendance.read'),
  supervisorController.getAttendance
);

router.get(
  '/supervisor/locations/live',
  requireRouteKey(RouteKeys.SUPERVISOR_LIVE_LOCATION),
  requirePermissions('worker.location.read'),
  supervisorController.getLiveLocations
);

router.get(
  '/supervisor/live-map',
  requireRouteKey(RouteKeys.SUPERVISOR_LIVE_LOCATION),
  requirePermissions('worker.location.read'),
  supervisorController.getLiveMap
);

router.get(
  '/supervisor/checkins',
  requireRouteKey(RouteKeys.SUPERVISOR_CHECKIN_CHECKOUT),
  requirePermissions('worker.checkin.read'),
  supervisorController.getCheckins
);

router.get(
  '/supervisor/device-health',
  requireRouteKey(RouteKeys.SUPERVISOR_DEVICE_HEALTH),
  requirePermissions('worker.device_health.read'),
  supervisorController.getDeviceHealth
);

router.get(
  '/supervisor/work-progress',
  requireRouteKey(RouteKeys.SUPERVISOR_WORK_PROGRESS),
  requirePermissions('worker.task_progress.read'),
  supervisorController.getWorkProgress
);

router.post(
  '/supervisor/tasks/:id/reassign',
  requireRouteKey(RouteKeys.SUPERVISOR_WORK_PROGRESS),
  requirePermissions('worker.task_progress.read'),
  requireAction('task.reassign'),
  validate(validateTaskReassign),
  taskController.postTaskReassign
);

router.get(
  '/supervisor/cleanliness',
  requireRouteKey(RouteKeys.SUPERVISOR_CLEANLINESS),
  requirePermissions('cleanliness.verification.read'),
  supervisorController.getCleanliness
);

router.get(
  '/supervisor/alerts',
  requireRouteKey(RouteKeys.SUPERVISOR_ALERTS),
  requirePermissions('supervisor.alerts.read'),
  supervisorController.getAlerts
);

router.post(
  '/supervisor/alerts/:alertId/acknowledge',
  requireRouteKey(RouteKeys.SUPERVISOR_ALERTS),
  requirePermissions('supervisor.alerts.escalate'),
  requireAction('supervisor.alerts.escalate'),
  supervisorController.postAcknowledgeAlert
);

router.get(
  '/supervisor/reports/daily',
  requireRouteKey(RouteKeys.SUPERVISOR_REPORTS),
  requirePermissions('supervisor.reports.read'),
  supervisorController.getDailyReport
);

module.exports = router;
