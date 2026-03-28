const express = require('express');
const sensorController = require('./sensor.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const { validateIngestion, validateSensorListQuery } = require('./sensor.validator');

const router = express.Router();

router.use(protect);

router.post('/sensor-ingestion/readings', requirePermissions('sensor.ingest'), validate(validateIngestion), sensorController.postIngestion);
router.get('/sensors', requirePermissions('sensor.read'), validate(validateSensorListQuery), sensorController.getSensors);
router.get('/sensors/:id/readings', requirePermissions('sensor.read'), validate(validateSensorListQuery), sensorController.getSensorReadings);
router.get('/facilities/:id/live-metrics', requirePermissions('dashboard.read'), sensorController.getFacilityLiveMetrics);
router.get('/alerts/live', requirePermissions('alerts.manage'), sensorController.getLiveAlerts);

module.exports = router;
