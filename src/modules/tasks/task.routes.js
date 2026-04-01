const express = require('express');
const taskController = require('./task.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const requireScope = require('../../core/rbac/requireScope');
const { validate } = require('../../core/middleware/validate');
const { validateTaskCreate } = require('./task.validator');

const router = express.Router();

router.use(protect);

router.get('/tasks', requirePermissions('task.manage'), requireScope(), taskController.getTasks);
router.post('/tasks', requirePermissions('task.manage'), validate(validateTaskCreate), taskController.postTask);
router.get('/tasks/my', requirePermissions('inspection.create'), requireScope(), taskController.getMyTasks);
router.patch('/tasks/:id/start', requirePermissions('inspection.create'), taskController.patchTaskStart);
router.patch('/tasks/:id/complete', requirePermissions('inspection.create'), taskController.patchTaskComplete);

module.exports = router;
