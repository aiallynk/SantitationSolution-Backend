const { sendSuccess } = require('../../core/http/response');
const supervisorService = require('./supervisor.service');

const getOverview = async (req, res, next) => {
  try {
    const data = await supervisorService.getOverview(req);
    return sendSuccess(res, { message: 'Supervisor overview fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getWorkers = async (req, res, next) => {
  try {
    const payload = await supervisorService.getWorkers(req);
    return sendSuccess(res, {
      message: 'Supervisor workers fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getWorkerDetail = async (req, res, next) => {
  try {
    const data = await supervisorService.getWorkerDetail(req);
    return sendSuccess(res, { message: 'Supervisor worker detail fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getAttendance = async (req, res, next) => {
  try {
    const payload = await supervisorService.getAttendance(req);
    return sendSuccess(res, {
      message: 'Supervisor attendance fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getLiveLocations = async (req, res, next) => {
  try {
    const payload = await supervisorService.getLiveLocations(req);
    return sendSuccess(res, {
      message: 'Supervisor live locations fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getLiveMap = async (req, res, next) => {
  try {
    const data = await supervisorService.getLiveMap(req);
    return sendSuccess(res, { message: 'Supervisor live map fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getCheckins = async (req, res, next) => {
  try {
    const payload = await supervisorService.getCheckins(req);
    return sendSuccess(res, {
      message: 'Supervisor check-in timeline fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getDeviceHealth = async (req, res, next) => {
  try {
    const payload = await supervisorService.getDeviceHealth(req);
    return sendSuccess(res, {
      message: 'Supervisor device health fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getWorkProgress = async (req, res, next) => {
  try {
    const payload = await supervisorService.getWorkProgress(req);
    return sendSuccess(res, {
      message: 'Supervisor work progress fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getCleanliness = async (req, res, next) => {
  try {
    const payload = await supervisorService.getCleanliness(req);
    return sendSuccess(res, {
      message: 'Supervisor cleanliness verification fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getAlerts = async (req, res, next) => {
  try {
    const payload = await supervisorService.getAlerts(req);
    return sendSuccess(res, {
      message: 'Supervisor alerts fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getDailyReport = async (req, res, next) => {
  try {
    const data = await supervisorService.getDailyReport(req);
    return sendSuccess(res, { message: 'Supervisor daily report fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const postAcknowledgeAlert = async (req, res, next) => {
  try {
    const data = await supervisorService.acknowledgeAlert(req);
    return sendSuccess(res, { message: 'Supervisor alert acknowledged successfully', data });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAlerts,
  getAttendance,
  getCheckins,
  getCleanliness,
  getDailyReport,
  getDeviceHealth,
  getLiveMap,
  getLiveLocations,
  getOverview,
  getWorkerDetail,
  getWorkers,
  getWorkProgress,
  postAcknowledgeAlert,
};
