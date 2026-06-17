const express = require('express');
const sensorController = require('./sensor.controller');
const {
  protect,
  requirePermissions,
  requireAnyPermissions,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const { withIdempotency } = require('../../core/idempotency/idempotency.middleware');
const {
  validateIngestion,
  validateAttachSensor,
  validateRegisterSensor,
  validateSensorListQuery,
} = require('./sensor.validator');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();
const SENSOR_ROUTE_PREFIXES = ['/sensor-ingestion', '/sensors', '/facilities', '/alerts'];

router.use(SENSOR_ROUTE_PREFIXES, protect);

router.post('/sensor-ingestion/readings', requirePermissions('sensor.ingest'), validate(validateIngestion), sensorController.postIngestion);

/* -------------------------------------------------------------------------- */
/* Registration — record a discovered device without a toilet mapping.         */
/* Mobile registers the moment a sensor connects (pre-commissioning), so it is */
/* allowed for anyone who can ingest or manage. requireRouteKey omitted        */
/* (mobile surface, same precedent as ingestion/commissioning).                */
/* -------------------------------------------------------------------------- */
router.post(
  '/sensors/register',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.MOBILE_ONLY),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requireAnyPermissions('sensor.manage', 'sensor.ingest'),
  withIdempotency('sensor.register', { ttlMs: 24 * 60 * 60 * 1000 }),
  validate(validateRegisterSensor),
  sensorController.postRegisterSensor
);

/* -------------------------------------------------------------------------- */
/* Commissioning (Phase 2) — mobile + web; gated by sensor.manage.             */
/* requireRouteKey is intentionally omitted: route keys gate web navigation,   */
/* and field workers commission from mobile (precedent: ingestion route).      */
/* -------------------------------------------------------------------------- */
router.post(
  '/sensors/attach',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.MOBILE_ONLY),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('sensor.manage'),
  withIdempotency('sensor.attach', { ttlMs: 24 * 60 * 60 * 1000 }),
  validate(validateAttachSensor),
  sensorController.postAttachSensor
);
router.post(
  '/sensors/replace',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.MOBILE_ONLY),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('sensor.manage'),
  withIdempotency('sensor.replace', { ttlMs: 24 * 60 * 60 * 1000 }),
  validate(validateAttachSensor),
  sensorController.postReplaceSensor
);
router.post(
  '/sensors/:id/detach',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.MOBILE_ONLY),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requirePermissions('sensor.manage'),
  sensorController.postDetachSensor
);

/* -------------------------------------------------------------------------- */
/* Per-toilet reading APIs (Phase 6) — mobile + web; gated by sensor.read.     */
/* Distinct /sensors/by-toilet/* namespace avoids the /toilets prefix owned by */
/* the inspections module and its blanket OPS_INSPECTIONS route-key middleware.*/
/* -------------------------------------------------------------------------- */
router.get(
  '/sensors/by-toilet/:toiletUnitId/latest',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.MOBILE_ONLY),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requireAnyPermissions('sensor.read', 'dashboard.read'),
  sensorController.getToiletLatestReading
);
router.get(
  '/sensors/by-toilet/:toiletUnitId/history',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.MOBILE_ONLY),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requireAnyPermissions('sensor.read', 'dashboard.read'),
  validate(validateSensorListQuery),
  sensorController.getToiletReadingHistory
);
router.get(
  '/sensors/by-toilet/:toiletUnitId/summary',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.MOBILE_ONLY),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
  requireAnyPermissions('sensor.read', 'dashboard.read'),
  sensorController.getToiletReadingSummary
);

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
