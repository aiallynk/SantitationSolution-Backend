const express = require('express');
const dashboardController = require('./dashboard.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');

const router = express.Router();

router.use('/dashboard', protect, requirePermissions('dashboard.read'));

router.get('/dashboard/overview', dashboardController.getOverview);
router.get('/dashboard/map', dashboardController.getMap);
router.get('/dashboard/heatmap', dashboardController.getHeatmap);
router.get('/dashboard/facility/:id', dashboardController.getFacility);
router.get('/dashboard/trends', dashboardController.getTrends);
router.get('/dashboard/alerts', dashboardController.getAlerts);
router.get('/dashboard/workforce', dashboardController.getWorkforce);
router.get('/dashboard/contractor-performance', dashboardController.getContractorPerformance);
router.get('/dashboard/sla', dashboardController.getSla);
router.get('/dashboard/storage-usage', dashboardController.getStorageUsage);
router.get('/dashboard/platform-health', dashboardController.getPlatformHealth);

module.exports = router;
