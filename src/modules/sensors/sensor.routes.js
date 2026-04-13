const express = require('express');
const sensorController = require('./sensor.controller');
const {
  protect,
  requirePermissions,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const { validateIngestion, validateSensorListQuery } = require('./sensor.validator');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

router.use(protect);

router.post('/sensor-ingestion/readings', requirePermissions('sensor.ingest'), validate(validateIngestion), sensorController.postIngestion);
router.get(
  '/sensors',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE),
  requireRouteKey(RouteKeys.OPS_SENSORS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('sensor.read'),
  validate(validateSensorListQuery),
  sensorController.getSensors
);
router.get(
  '/sensors/:id/readings',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE),
  requireRouteKey(RouteKeys.OPS_SENSORS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('sensor.read'),
  validate(validateSensorListQuery),
  sensorController.getSensorReadings
);
router.get(
  '/facilities/:id/live-metrics',
  requireSurface(
    SurfaceTypes.OPS_WEB,
    SurfaceTypes.OPS_WEB_AND_MOBILE,
    SurfaceTypes.MOBILE_ONLY,
  ),
  requireRouteKey(RouteKeys.OPS_SENSORS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('dashboard.read'),
  sensorController.getFacilityLiveMetrics
);
router.get(
  '/alerts/live',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE),
  requireRouteKey(RouteKeys.OPS_ALERTS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('alerts.manage'),
  sensorController.getLiveAlerts
);

module.exports = router;
