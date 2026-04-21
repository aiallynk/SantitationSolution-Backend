const express = require('express');
const taskController = require('./task.controller');
const {
  protect,
  requirePermissions,
  requireAnyPermissions,
  requireAction,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');
const { validate } = require('../../core/middleware/validate');
const { validateTaskCreate } = require('./task.validator');

const router = express.Router();

router.use('/tasks', protect);
router.use(
  '/tasks',
  requireSurface(
    SurfaceTypes.OPS_WEB,
    SurfaceTypes.OPS_WEB_AND_MOBILE,
    SurfaceTypes.MOBILE_ONLY,
  ),
  requireRouteKey(RouteKeys.OPS_TASKS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
);

router.get(
  '/tasks',
  requireAnyPermissions('task.manage', 'inspection.create', 'dashboard.read'),
  taskController.getTasks
);
router.post(
  '/tasks',
  requirePermissions('task.manage'),
  requireAction('task.manage'),
  validate(validateTaskCreate),
  taskController.postTask
);
router.get(
  '/tasks/my',
  requireAnyPermissions('inspection.create', 'task.manage', 'dashboard.read'),
  taskController.getMyTasks
);
router.get(
  '/tasks/:id',
  requireAnyPermissions('task.manage', 'inspection.create', 'dashboard.read'),
  taskController.getTaskById
);
router.patch(
  '/tasks/:id/start',
  requireAnyPermissions('inspection.create', 'task.manage'),
  requireAction('task.execute'),
  taskController.patchTaskStart
);
router.patch(
  '/tasks/:id/complete',
  requireAnyPermissions('inspection.create', 'task.manage'),
  requireAction('task.execute'),
  taskController.patchTaskComplete
);

module.exports = router;
