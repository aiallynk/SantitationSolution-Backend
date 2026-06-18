const express = require('express');
const consumptionController = require('./consumption.controller');
const {
  protect,
  requireRoles,
  requireRouteKey,
  requireSurface,
  requirePermissions,
} = require('../../core/middleware/auth');
const { RouteKeys, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

// ─── Super Admin consumption routes ─────────────────────────────────────────
router.get(
  '/super-admin/consumption/overview',
  protect,
  requireRoles('super_admin'),
  requireSurface(SurfaceTypes.PLATFORM_WEB),
  requireRouteKey(RouteKeys.SA_PLATFORM_HEALTH),
  consumptionController.getSaOverview,
);

router.get(
  '/super-admin/consumption/tenants',
  protect,
  requireRoles('super_admin'),
  requireSurface(SurfaceTypes.PLATFORM_WEB),
  requireRouteKey(RouteKeys.SA_PLATFORM_HEALTH),
  consumptionController.getSaTenantConsumption,
);

router.get(
  '/super-admin/consumption/logs',
  protect,
  requireRoles('super_admin'),
  requireSurface(SurfaceTypes.PLATFORM_WEB),
  requireRouteKey(RouteKeys.SA_PLATFORM_HEALTH),
  consumptionController.getSaLogs,
);

// ─── Ops Admin consumption routes ────────────────────────────────────────────
router.get(
  '/consumption/overview',
  protect,
  requireSurface(SurfaceTypes.OPS_WEB),
  requireRouteKey(RouteKeys.OPS_AI_CONSUMPTION),
  requirePermissions('dashboard.read'),
  consumptionController.getOpsOverview,
);

router.get(
  '/consumption/workers',
  protect,
  requireSurface(SurfaceTypes.OPS_WEB),
  requireRouteKey(RouteKeys.OPS_AI_CONSUMPTION),
  requirePermissions('dashboard.read'),
  consumptionController.getOpsWorkerConsumption,
);

router.get(
  '/consumption/features',
  protect,
  requireSurface(SurfaceTypes.OPS_WEB),
  requireRouteKey(RouteKeys.OPS_AI_CONSUMPTION),
  requirePermissions('dashboard.read'),
  consumptionController.getOpsFeatureConsumption,
);

router.get(
  '/consumption/logs',
  protect,
  requireSurface(SurfaceTypes.OPS_WEB),
  requireRouteKey(RouteKeys.OPS_AI_CONSUMPTION),
  requirePermissions('dashboard.read'),
  consumptionController.getOpsLogs,
);

module.exports = router;
