const { sendSuccess } = require('../../core/http/response');
const consumptionService = require('./consumption.service');

const wrap = (serviceFn, message) => async (req, res, next) => {
  try {
    const data = await serviceFn(req);
    return sendSuccess(res, { message, data });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getSaOverview: wrap(consumptionService.getSaOverview, 'SA consumption overview fetched'),
  getSaTenantConsumption: wrap(consumptionService.getSaTenantConsumption, 'SA tenant consumption fetched'),
  getSaLogs: wrap(consumptionService.getSaLogs, 'SA consumption logs fetched'),
  getOpsOverview: wrap(consumptionService.getOpsOverview, 'Ops consumption overview fetched'),
  getOpsWorkerConsumption: wrap(consumptionService.getOpsWorkerConsumption, 'Ops worker consumption fetched'),
  getOpsFeatureConsumption: wrap(consumptionService.getOpsFeatureConsumption, 'Ops feature consumption fetched'),
  getOpsLogs: wrap(consumptionService.getOpsLogs, 'Ops consumption logs fetched'),
};
