const express = require('express');
const reportController = require('./report.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');

const router = express.Router();

router.use('/reports', protect, requirePermissions('reports.read'));

router.get('/reports/inspections', reportController.getInspectionReport);
router.get('/reports/alerts', reportController.getAlertReport);
router.get('/reports/facility-performance', reportController.getFacilityPerformanceReport);
router.get('/reports/export', requirePermissions('reports.export'), reportController.getExport);

module.exports = router;
