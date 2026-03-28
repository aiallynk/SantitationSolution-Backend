const express = require('express');
const alertController = require('./alert.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/alerts', requirePermissions('alerts.manage'), alertController.getAlerts);
router.get('/alerts/summary', requirePermissions('alerts.manage'), alertController.getAlertSummary);
router.get('/alerts/:id', requirePermissions('alerts.manage'), alertController.getAlertById);
router.patch('/alerts/:id/acknowledge', requirePermissions('alerts.manage'), alertController.patchAcknowledge);
router.patch('/alerts/:id/resolve', requirePermissions('alerts.manage'), alertController.patchResolve);

module.exports = router;
