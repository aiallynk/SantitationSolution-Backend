const express = require('express');
const workerController = require('./worker.controller');
const {
  protect,
  requireAction,
  requireRoles,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

router.use('/worker', protect);
router.use(
  '/worker',
  requireRoles('field_worker'),
  requireSurface(SurfaceTypes.MOBILE_ONLY, SurfaceTypes.OPS_WEB_AND_MOBILE),
  requireRouteKey(RouteKeys.OPS_TASKS),
  requireScope({ scopeTypes: [ScopeTypes.FACILITY] }),
);

router.post(
  '/worker/heartbeat',
  requireAction('task.execute'),
  workerController.postHeartbeat
);

module.exports = router;
