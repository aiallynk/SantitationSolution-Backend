const express = require('express');
const taskController = require('./task.controller');
const {
  protect,
  requirePermissions,
  requireAnyPermissions,
} = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const { validateTaskCreate } = require('./task.validator');

const router = express.Router();

router.use(protect);

router.get(
  '/tasks',
  requireAnyPermissions('task.manage', 'inspection.create', 'dashboard.read'),
  taskController.getTasks
);
router.post('/tasks', requirePermissions('task.manage'), validate(validateTaskCreate), taskController.postTask);
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
  taskController.patchTaskStart
);
router.patch(
  '/tasks/:id/complete',
  requireAnyPermissions('inspection.create', 'task.manage'),
  taskController.patchTaskComplete
);

module.exports = router;
