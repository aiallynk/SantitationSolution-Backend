const express = require('express');
const analysisController = require('./analysis.controller');
const {
  protect,
  requirePermissions,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { withIdempotency } = require('../../core/idempotency/idempotency.middleware');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

router.use(protect);
router.use(
  '/analysis/inspections',
  requireSurface(
    SurfaceTypes.OPS_WEB,
    SurfaceTypes.OPS_WEB_AND_MOBILE,
    SurfaceTypes.MOBILE_ONLY,
  ),
  requireRouteKey(RouteKeys.OPS_INSPECTIONS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
);

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
