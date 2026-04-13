const express = require('express');
const {
  protect,
  requireAction,
  requirePermissions,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { sendSuccess } = require('../../core/http/response');
const dashboardService = require('../../modules/dashboard/dashboard.service');
const alertService = require('../../modules/alerts/alert.service');
const inspectionService = require('../../modules/inspections/inspection.service');
const analysisService = require('../../modules/analysis/analysis.service');
const authRouter = require('../../modules/auth/auth.routes');
const AppError = require('../../core/errors/AppError');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();
const OPS_AND_MOBILE_SURFACES = [
  SurfaceTypes.OPS_WEB,
  SurfaceTypes.OPS_WEB_AND_MOBILE,
  SurfaceTypes.MOBILE_ONLY,
];
const COMMON_SCOPE_RULE = {
  scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY],
};
const OPS_WEB_SURFACES = [SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE];

// Legacy auth aliases
router.use('/auth', authRouter);

// Legacy inspections aliases for current frontend contract.
router.get(
  '/inspections',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_INSPECTIONS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('inspection.review'),
  async (req, res, next) => {
  try {
    const result = await inspectionService.listInspections(req, false);
    return sendSuccess(res, {
      message: 'Inspections fetched successfully',
      data: { items: result.items, total: result.meta.total },
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/inspections/recent',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_INSPECTIONS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('inspection.review'),
  async (req, res, next) => {
  try {
    const result = await inspectionService.listInspections(
      {
        ...req,
        query: {
          ...req.query,
          page: 1,
          limit: req.query.limit || 10,
        },
      },
      false
    );
    return sendSuccess(res, {
      message: 'Recent inspections fetched successfully',
      data: { items: result.items.slice(0, Number(req.query.limit || 10)), total: result.meta.total },
    });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/inspections/:id',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_INSPECTIONS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const data = await inspectionService.getInspectionById(req);
    return sendSuccess(res, { message: 'Inspection fetched successfully', data });
  } catch (error) {
    return next(error);
  }
});

// Legacy analytics aliases.
router.get(
  '/analytics/summary',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_OVERVIEW),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const data = await dashboardService.getOverview(req);
    return sendSuccess(res, { message: 'Summary fetched successfully', data });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/analytics/trends',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_OVERVIEW),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const data = await dashboardService.getTrends(req);
    return sendSuccess(res, { message: 'Trends fetched successfully', data: { items: data } });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/analytics/alerts',
  protect,
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ALERTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const result = await alertService.listAlerts(req);
    return sendSuccess(res, {
      message: 'Alerts fetched successfully',
      data: { items: result.items, total: result.meta.total },
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/analytics/heatmap',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_OVERVIEW),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const points = await dashboardService.getHeatmap(req);
    return sendSuccess(res, { message: 'Heatmap data fetched successfully', data: { points } });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/analytics/zones',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_OVERVIEW),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const facilities = await dashboardService.getMap(req);
    const zones = {};
    facilities.forEach((item) => {
      const zoneKey = item.facilityName?.split(' ')[0] || 'Unknown';
      zones[zoneKey] = zones[zoneKey] || { zone: zoneKey, inspectionCount: 0, averageScore: 0 };
      zones[zoneKey].inspectionCount += 1;
      zones[zoneKey].averageScore += Number(item.cleanlinessScore || 0);
    });
    const data = Object.values(zones).map((row) => ({
      ...row,
      averageScore: row.inspectionCount ? Number((row.averageScore / row.inspectionCount).toFixed(2)) : 0,
    }));
    return sendSuccess(res, { message: 'Zone summaries fetched successfully', data });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/analytics/critical',
  protect,
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ALERTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const alertsResult = await alertService.listAlerts({
      ...req,
      query: { ...req.query, severity: 'critical' },
    });
    return sendSuccess(res, {
      message: 'Critical inspections fetched successfully',
      data: alertsResult.items,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch(
  '/analytics/alerts/:id/acknowledge',
  protect,
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ALERTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('alerts.manage'),
  requireAction('alert.manage'),
  async (req, res, next) => {
  try {
    req.params.id = req.params.id;
    const data = await alertService.acknowledgeAlert(req);
    return sendSuccess(res, { message: 'Alert acknowledged successfully', data });
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/inspections/upload',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_INSPECTIONS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('inspection.create'),
  async (req, res, next) => {
  try {
    throw new AppError(
      'Legacy /inspections/upload is deprecated. Use /api/v1/inspections/:id/media',
      410,
      { code: 'ENDPOINT_DEPRECATED' }
    );
  } catch (error) {
    return next(error);
  }
});

router.post(
  '/inspections/submit',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_INSPECTIONS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('inspection.create'),
  async (req, res, next) => {
  try {
    throw new AppError(
      'Legacy /inspections/submit is deprecated. Use /api/v1/inspections and /api/v1/inspections/:id/submit',
      410,
      { code: 'ENDPOINT_DEPRECATED' }
    );
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/alerts/:id',
  protect,
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ALERTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const data = await alertService.getAlertById(req);
    return sendSuccess(res, { message: 'Alert fetched successfully', data });
  } catch (error) {
    return next(error);
  }
});

router.get(
  '/analysis/inspections/:inspectionId/result',
  protect,
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_INSPECTIONS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  async (req, res, next) => {
  try {
    const data = await analysisService.getAnalysisResult(req.params.inspectionId, req);
    return sendSuccess(res, { message: 'Analysis result fetched successfully', data });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
