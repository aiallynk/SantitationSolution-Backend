const express = require('express');
const {
  protect,
  requirePermissions,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const auditController = require('./audit.controller');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

router.use(protect);
router.use(
  requireSurface(
    SurfaceTypes.OPS_WEB,
    SurfaceTypes.OPS_WEB_AND_MOBILE,
    SurfaceTypes.PLATFORM_WEB,
  ),
  requireRouteKey(RouteKeys.OPS_AUDIT, RouteKeys.SA_GLOBAL_USERS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
);

router.get('/audit-logs', requirePermissions('audit.read'), auditController.getAuditLogs);

module.exports = router;
