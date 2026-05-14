const express = require('express');
const alertController = require('./alert.controller');
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

const router = express.Router();

router.use('/alerts', protect);
router.use(
  '/alerts',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE),
  requireRouteKey(RouteKeys.OPS_ALERTS, RouteKeys.SUPERVISOR_ALERTS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
);

router.get(
  '/alerts',
  requireAnyPermissions('alerts.manage', 'dashboard.read', 'supervisor.alerts.read'),
  alertController.getAlerts,
);
router.get(
  '/alerts/summary',
  requireAnyPermissions('alerts.manage', 'dashboard.read', 'supervisor.alerts.read'),
  alertController.getAlertSummary,
);
router.get(
  '/alerts/:id',
  requireAnyPermissions('alerts.manage', 'dashboard.read', 'supervisor.alerts.read'),
  alertController.getAlertById,
);
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
