const express = require('express');
const reportController = require('./report.controller');
const {
  protect,
  requirePermissions,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

router.use(
  '/reports',
  protect,
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE),
  requireRouteKey(RouteKeys.OPS_REPORTS, RouteKeys.OPS_AUDITOR_REPORTS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('reports.read'),
);

router.get('/reports/inspections', reportController.getInspectionReport);
router.get('/reports/alerts', reportController.getAlertReport);
router.get('/reports/facility-performance', reportController.getFacilityPerformanceReport);
router.get('/reports/export', requirePermissions('reports.export'), reportController.getExport);

module.exports = router;
