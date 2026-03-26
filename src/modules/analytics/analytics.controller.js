const analyticsService = require('./analytics.service');
const { sendSuccess } = require('../../utils/response');

const getSummary = async (req, res, next) => {
  try {
    const summary = await analyticsService.getSummary();

    sendSuccess(res, {
      statusCode: 200,
      message: 'Dashboard summary fetched successfully',
      data: summary,
    });
  } catch (error) {
    next(error);
  }
};

const getAllAlerts = async (req, res, next) => {
  try {
    const alerts = await analyticsService.getAlerts(req.query);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Alerts fetched successfully',
      data: alerts,
    });
  } catch (error) {
    next(error);
  }
};

const getHeatmap = async (req, res, next) => {
  try {
    const points = await analyticsService.getHeatmap();

    sendSuccess(res, {
      statusCode: 200,
      message: 'Heatmap data fetched successfully',
      data: points,
    });
  } catch (error) {
    next(error);
  }
};

const getTrends = async (req, res, next) => {
  try {
    const trendSeries = await analyticsService.getTrends(req.query);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Trend data fetched successfully',
      data: trendSeries,
    });
  } catch (error) {
    next(error);
  }
};

const getZoneSummaries = async (req, res, next) => {
  try {
    const zones = await analyticsService.getZoneSummaries();

    sendSuccess(res, {
      statusCode: 200,
      message: 'Zone-wise summary fetched successfully',
      data: zones,
    });
  } catch (error) {
    next(error);
  }
};

const getCriticalInspections = async (req, res, next) => {
  try {
    const criticalInspections = await analyticsService.getCriticalInspections();

    sendSuccess(res, {
      statusCode: 200,
      message: 'Critical inspections fetched successfully',
      data: criticalInspections,
    });
  } catch (error) {
    next(error);
  }
};

const acknowledgeAlert = async (req, res, next) => {
  try {
    const alert = await analyticsService.acknowledgeAlert(req.params.id);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Alert acknowledged successfully',
      data: alert,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSummary,
  getAllAlerts,
  getHeatmap,
  getTrends,
  getZoneSummaries,
  getCriticalInspections,
  acknowledgeAlert,
};
