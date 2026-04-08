const express = require('express');
const alertController = require('./alert.controller');
const {
  protect,
  requirePermissions,
  requireAnyPermissions,
  requireAction,
} = require('../../core/middleware/auth');

const router = express.Router();

router.use(protect);

router.get('/alerts', requireAnyPermissions('alerts.manage', 'dashboard.read'), alertController.getAlerts);
router.get('/alerts/summary', requireAnyPermissions('alerts.manage', 'dashboard.read'), alertController.getAlertSummary);
router.get('/alerts/:id', requireAnyPermissions('alerts.manage', 'dashboard.read'), alertController.getAlertById);
router.patch(
  '/alerts/:id/acknowledge',
  requirePermissions('alerts.manage'),
  requireAction('alert.manage'),
  alertController.patchAcknowledge
);
router.patch(
  '/alerts/:id/resolve',
  requirePermissions('alerts.manage'),
  requireAction('alert.manage'),
  alertController.patchResolve
);

module.exports = router;
