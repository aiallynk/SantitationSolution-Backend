const express = require('express');
const analysisController = require('./analysis.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { withIdempotency } = require('../../core/idempotency/idempotency.middleware');

const router = express.Router();

router.use(protect);

router.post(
  '/analysis/inspections/:inspectionId/run',
  requirePermissions('inspection.review'),
  withIdempotency('analysis.run'),
  analysisController.postRunAnalysis
);
router.post(
  '/analysis/inspections/:inspectionId/reprocess',
  requirePermissions('inspection.review'),
  withIdempotency('analysis.reprocess'),
  analysisController.postReprocessAnalysis
);
router.get(
  '/analysis/inspections/:inspectionId/result',
  requirePermissions('dashboard.read'),
  analysisController.getInspectionAnalysisResult
);
router.get(
  '/analysis/inspections/:inspectionId/trend',
  requirePermissions('dashboard.read'),
  analysisController.getInspectionAnalysisTrendData
);
router.post('/analysis/webhook', analysisController.postAnalysisWebhook);

module.exports = router;
