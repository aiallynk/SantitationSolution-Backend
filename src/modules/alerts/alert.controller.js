const { sendSuccess } = require('../../core/http/response');
const alertService = require('./alert.service');

const getAlerts = async (req, res, next) => {
  try {
    const result = await alertService.listAlerts(req);
    return sendSuccess(res, {
      message: 'Alerts fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getAlertById = async (req, res, next) => {
  try {
    const data = await alertService.getAlertById(req);
    return sendSuccess(res, {
      message: 'Alert fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const patchAcknowledge = async (req, res, next) => {
  try {
    const data = await alertService.acknowledgeAlert(req);
    return sendSuccess(res, {
      message: 'Alert acknowledged successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const patchResolve = async (req, res, next) => {
  try {
    const data = await alertService.resolveAlert(req);
    return sendSuccess(res, {
      message: 'Alert resolved successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getAlertSummary = async (req, res, next) => {
  try {
    const data = await alertService.getAlertSummary(req);
    return sendSuccess(res, {
      message: 'Alert summary fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAlerts,
  getAlertById,
  patchAcknowledge,
  patchResolve,
  getAlertSummary,
};
