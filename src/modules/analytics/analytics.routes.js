const express = require('express');
const analyticsController = require('./analytics.controller');
const { protect, restrictTo } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const { validateTrendsQuery, validateAlertIdParam } = require('./analytics.validator');

const router = express.Router();

router.use(protect, restrictTo('ADMIN'));

router.get('/summary', analyticsController.getSummary);
router.get('/alerts', analyticsController.getAllAlerts);
router.get('/heatmap', analyticsController.getHeatmap);
router.get('/trends', validate(validateTrendsQuery), analyticsController.getTrends);
router.get('/zones', analyticsController.getZoneSummaries);
router.get('/critical', analyticsController.getCriticalInspections);
router.patch('/alerts/:id/acknowledge', validate(validateAlertIdParam), analyticsController.acknowledgeAlert);

module.exports = router;
