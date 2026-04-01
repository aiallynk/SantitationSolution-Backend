const express = require('express');
const alertController = require('./alert.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const requireScope = require('../../core/rbac/requireScope');

const router = express.Router();

router.use(protect);

router.get('/alerts', requirePermissions('alerts.manage'), requireScope(), alertController.getAlerts);
router.get('/alerts/summary', requirePermissions('alerts.manage'), requireScope(), alertController.getAlertSummary);
router.get('/alerts/:id', requirePermissions('alerts.manage'), requireScope(), alertController.getAlertById);
router.patch('/alerts/:id/acknowledge', requirePermissions('alerts.manage'), alertController.patchAcknowledge);
router.patch('/alerts/:id/resolve', requirePermissions('alerts.manage'), alertController.patchResolve);

module.exports = router;
