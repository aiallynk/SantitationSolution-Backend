const { sendSuccess } = require('../../core/http/response');
const apiAccessService = require('./apiAccess.service');

const wrap = (serviceFn, message, statusCode = 200) => async (req, res, next) => {
  try {
    const data = await serviceFn(req);
    return sendSuccess(res, { statusCode, message, data });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getOverview: wrap(apiAccessService.getOverview, 'API access overview fetched successfully'),
  listProjects: wrap(apiAccessService.listProjects, 'API projects fetched successfully'),
  createProject: wrap(apiAccessService.createProject, 'API project created successfully', 201),
  getProjectById: wrap(apiAccessService.getProjectById, 'API project fetched successfully'),
  updateProject: wrap(apiAccessService.updateProject, 'API project updated successfully'),
  listKeys: wrap(apiAccessService.listKeys, 'API keys fetched successfully'),
  createKey: wrap(apiAccessService.createKey, 'API key generated successfully', 201),
  updateKey: wrap(apiAccessService.updateKey, 'API key updated successfully'),
  revokeKey: wrap(apiAccessService.revokeKey, 'API key revoked successfully'),
  regenerateKey: wrap(apiAccessService.regenerateKey, 'API key regenerated successfully'),
  listLogs: wrap(apiAccessService.listLogs, 'API usage logs fetched successfully'),
  listEvents: wrap(apiAccessService.listEvents, 'API key events fetched successfully'),
  getAnalytics: wrap(apiAccessService.getAnalytics, 'API usage analytics fetched successfully'),
  listTenantsForScope: wrap(apiAccessService.listTenantsForScope, 'API access tenant options fetched successfully'),
};
