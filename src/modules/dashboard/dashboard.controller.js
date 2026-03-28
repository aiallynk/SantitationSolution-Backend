const { sendSuccess } = require('../../core/http/response');
const dashboardService = require('./dashboard.service');
const alertService = require('../alerts/alert.service');

const getOverview = async (req, res, next) => {
  try {
    const data = await dashboardService.getOverview(req);
    return sendSuccess(res, { message: 'Dashboard overview fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getMap = async (req, res, next) => {
  try {
    const data = await dashboardService.getMap(req);
    return sendSuccess(res, { message: 'Dashboard map data fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getHeatmap = async (req, res, next) => {
  try {
    const data = await dashboardService.getHeatmap(req);
    return sendSuccess(res, { message: 'Dashboard heatmap data fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getFacility = async (req, res, next) => {
  try {
    const data = await dashboardService.getFacilityDashboard(req);
    return sendSuccess(res, { message: 'Facility dashboard fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getTrends = async (req, res, next) => {
  try {
    const data = await dashboardService.getTrends(req);
    return sendSuccess(res, { message: 'Dashboard trends fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getAlerts = async (req, res, next) => {
  try {
    const result = await alertService.listAlerts(req);
    return sendSuccess(res, { message: 'Dashboard alerts fetched successfully', data: result.items, meta: result.meta });
  } catch (error) {
    return next(error);
  }
};

const getWorkforce = async (req, res, next) => {
  try {
    const data = await dashboardService.getWorkforce(req);
    return sendSuccess(res, { message: 'Dashboard workforce data fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getContractorPerformance = async (req, res, next) => {
  try {
    const data = await dashboardService.getContractorPerformance(req);
    return sendSuccess(res, { message: 'Contractor performance fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getSla = async (req, res, next) => {
  try {
    const data = await dashboardService.getSla(req);
    return sendSuccess(res, { message: 'SLA metrics fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getStorageUsage = async (req, res, next) => {
  try {
    const data = await dashboardService.getStorageUsage(req);
    return sendSuccess(res, { message: 'Storage usage fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getPlatformHealth = async (req, res, next) => {
  try {
    const data = await dashboardService.getPlatformHealth(req);
    return sendSuccess(res, { message: 'Platform health fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getOverview,
  getMap,
  getHeatmap,
  getFacility,
  getTrends,
  getAlerts,
  getWorkforce,
  getContractorPerformance,
  getSla,
  getStorageUsage,
  getPlatformHealth,
};
