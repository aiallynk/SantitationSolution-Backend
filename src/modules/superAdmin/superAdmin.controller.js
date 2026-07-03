const { sendSuccess } = require('../../core/http/response');
const superAdminService = require('./superAdmin.service');
const tenantLimitsService = require('./tenantLimits.service');
const { buildQuotaStatus } = require('./tenantQuota.service');
const storageUsageService = require('./storageUsage.service');

const wrap = (serviceFn, message) => async (req, res, next) => {
  try {
    const data = await serviceFn(req);
    return sendSuccess(res, { message, data });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getTenants: wrap(superAdminService.getTenants, 'Super admin tenants fetched successfully'),
  getTenantById: wrap(superAdminService.getTenantById, 'Super admin tenant fetched successfully'),
  getRegions: wrap(superAdminService.getRegions, 'Super admin regions fetched successfully'),
  getPlatformMetrics: wrap(superAdminService.getPlatformMetrics, 'Super admin platform metrics fetched successfully'),
  getStorage: wrap(superAdminService.getStorage, 'Super admin storage metrics fetched successfully'),
  getPlatformStorageUsage: wrap(storageUsageService.getPlatformStorageUsage, 'S3 storage usage fetched successfully'),
  getTenantStorageUsage: wrap(storageUsageService.getSuperAdminTenantStorageUsage, 'Tenant S3 storage usage fetched successfully'),
  getApiUsage: wrap(superAdminService.getApiUsage, 'Super admin API usage fetched successfully'),
  getSystemHealth: wrap(superAdminService.getSystemHealth, 'Super admin system health fetched successfully'),
  getAuditLogs: wrap(superAdminService.getAuditLogs, 'Super admin audit logs fetched successfully'),
  postTenantProvision: wrap(superAdminService.postTenantProvision, 'Tenant provisioned successfully'),
  patchTenant: wrap(superAdminService.patchTenant, 'Tenant updated successfully'),
  patchFeatureFlags: wrap(superAdminService.patchFeatureFlags, 'Feature flags updated successfully'),
  getActionCenter: wrap(superAdminService.getActionCenter, 'Super admin action center fetched successfully'),
  getNotificationsFeed: wrap(superAdminService.getNotificationsFeed, 'Super admin notifications fetched successfully'),
  getMultiCityRollups: wrap(superAdminService.getMultiCityRollups, 'Multi-city rollups fetched successfully'),
  getOrganizations: wrap(superAdminService.getOrganizations, 'Organizations fetched successfully'),
  getClientWorkspace: wrap(superAdminService.getClientWorkspace, 'Client workspace fetched successfully'),
  listProjects: wrap(superAdminService.listProjects, 'Projects fetched successfully'),
  createProject: wrap(superAdminService.createProject, 'Project created successfully'),
  getTopology: wrap(superAdminService.getTopology, 'Topology fetched successfully'),
  getGlobalUsers: wrap(superAdminService.getGlobalUsers, 'Global users fetched successfully'),
  getRolesPermissions: wrap(superAdminService.getRolesPermissions, 'Roles and permissions fetched successfully'),
  listApprovals: wrap(superAdminService.listApprovals, 'Approvals fetched successfully'),
  createApproval: wrap(superAdminService.createApproval, 'Approval created successfully'),
  patchApprovalStatus: wrap(superAdminService.patchApprovalStatus, 'Approval updated successfully'),
  getMasterData: wrap(superAdminService.getMasterData, 'Master data fetched successfully'),
  getScoringThresholds: wrap(superAdminService.getScoringThresholds, 'Scoring thresholds fetched successfully'),
  patchScoringThresholds: wrap(superAdminService.patchScoringThresholds, 'Scoring thresholds updated successfully'),
  getEscalationPolicies: wrap(superAdminService.getEscalationPolicies, 'Escalation policies fetched successfully'),
  patchEscalationPolicies: wrap(superAdminService.patchEscalationPolicies, 'Escalation policies updated successfully'),
  getTemplates: wrap(superAdminService.getTemplates, 'Templates fetched successfully'),
  upsertTemplate: wrap(superAdminService.upsertTemplate, 'Template saved successfully'),
  getLocalization: wrap(superAdminService.getLocalization, 'Localization config fetched successfully'),
  patchLocalization: wrap(superAdminService.patchLocalization, 'Localization config updated successfully'),
  getPlatformAnalytics: wrap(superAdminService.getPlatformAnalytics, 'Platform analytics fetched successfully'),
  getStorageAnalytics: wrap(superAdminService.getStorageAnalytics, 'Storage analytics fetched successfully'),
  getAiUsage: wrap(superAdminService.getAiUsage, 'AI usage analytics fetched successfully'),
  getQueueHealth: wrap(superAdminService.getQueueHealth, 'Queue health fetched successfully'),
  getSyncFailures: wrap(superAdminService.getSyncFailures, 'Sync failures fetched successfully'),
  patchSyncFailureStatus: wrap(superAdminService.patchSyncFailureStatus, 'Sync failure updated successfully'),
  getDeviceFleet: wrap(superAdminService.getDeviceFleet, 'Device fleet fetched successfully'),
  getTenantHealth: wrap(superAdminService.getTenantHealth, 'Tenant health fetched successfully'),
  getSupportConsole: wrap(superAdminService.getSupportConsole, 'Support tickets fetched successfully'),
  createSupportTicket: wrap(superAdminService.createSupportTicket, 'Support ticket created successfully'),
  patchSupportTicket: wrap(superAdminService.patchSupportTicket, 'Support ticket updated successfully'),
  listIntegrations: wrap(superAdminService.listIntegrations, 'Integrations fetched successfully'),
  upsertIntegration: wrap(superAdminService.upsertIntegration, 'Integration saved successfully'),
  listReleases: wrap(superAdminService.listReleases, 'Releases fetched successfully'),
  createRelease: wrap(superAdminService.createRelease, 'Release record created successfully'),
  listBackups: wrap(superAdminService.listBackups, 'Backups fetched successfully'),
  createBackup: wrap(superAdminService.createBackup, 'Backup record created successfully'),
  getPolicy: wrap(superAdminService.getPolicy, 'Policy documents fetched successfully'),
  patchPolicy: wrap(superAdminService.patchPolicy, 'Policy documents updated successfully'),
  getReliability: wrap(superAdminService.getReliability, 'Reliability metrics fetched successfully'),
  getSettings: wrap(superAdminService.getSettings, 'Settings fetched successfully'),
  patchSettings: wrap(superAdminService.patchSettings, 'Settings updated successfully'),

  getTenantLimits: async (req, res, next) => {
    try {
      const limits = await tenantLimitsService.getTenantLimits(req.params.id);
      return sendSuccess(res, { message: 'Tenant limits fetched successfully', data: limits });
    } catch (err) { return next(err); }
  },

  upsertTenantLimits: async (req, res, next) => {
    try {
      const limits = await tenantLimitsService.upsertTenantLimits(req.params.id, req.body, req.user?.id);
      return sendSuccess(res, { message: 'Tenant limits saved successfully', data: limits });
    } catch (err) { return next(err); }
  },

  getTenantUsage: async (req, res, next) => {
    try {
      const { limits, usage } = await tenantLimitsService.getTenantUsageWithLimits(req.params.id);
      const quota = buildQuotaStatus(limits, usage);
      return sendSuccess(res, { message: 'Tenant usage fetched successfully', data: { limits, usage, quota } });
    } catch (err) { return next(err); }
  },

  recalculateTenantUsage: async (req, res, next) => {
    try {
      const usage = await tenantLimitsService.recalculateTenantUsage(req.params.id);
      return sendSuccess(res, { message: 'Tenant usage recalculated successfully', data: usage });
    } catch (err) { return next(err); }
  },
};
