const express = require('express');
const superAdminController = require('./superAdmin.controller');
const apiAccessController = require('./apiAccess.controller');
const backupController = require('../backups/backup.controller');
const {
  validateTenantProvision,
  validateTenantPatch,
  validateFeatureFlagsPatch,
  validateListQuery,
  validateApprovalCreate,
  validateApprovalDecision,
  validateProjectCreate,
  validateSupportTicketCreate,
  validateSupportTicketPatch,
  validateIntegrationUpsert,
  validateReleaseCreate,
  validateBackupCreate,
  validateSyncFailurePatch,
} = require('./superAdmin.validator');
const {
  protect,
  requireRoles,
  requireRouteKey,
  requireSurface,
} = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const { RouteKeys, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

router.post('/backups/scheduled-run', backupController.runScheduledBackups);

router.use(
  protect,
  requireRoles('super_admin'),
  requireSurface(SurfaceTypes.PLATFORM_WEB),
  requireRouteKey(
    RouteKeys.SA_OVERVIEW,
    RouteKeys.SA_TENANTS,
    RouteKeys.SA_GLOBAL_USERS,
    RouteKeys.SA_PLATFORM_HEALTH,
  ),
);

router.get('/tenants', superAdminController.getTenants);
router.get('/tenants/:id', superAdminController.getTenantById);
router.post('/tenants', validate(validateTenantProvision), superAdminController.postTenantProvision);
router.patch('/tenants/:id', validate(validateTenantPatch), superAdminController.patchTenant);
router.patch('/tenants/:id/ai-scoring-mode', superAdminController.patchTenantAiScoringMode);
router.get('/tenants/:id/limits', superAdminController.getTenantLimits);
router.put('/tenants/:id/limits', superAdminController.upsertTenantLimits);
router.get('/tenants/:id/usage', superAdminController.getTenantUsage);
router.post('/tenants/:id/usage/recalculate', superAdminController.recalculateTenantUsage);
router.get('/regions', superAdminController.getRegions);
router.get('/platform-metrics', superAdminController.getPlatformMetrics);
router.get('/storage', validate(validateListQuery), superAdminController.getStorage);
router.get('/storage/usage', superAdminController.getPlatformStorageUsage);
router.get('/tenants/:id/storage/usage', superAdminController.getTenantStorageUsage);
router.get('/api-usage', superAdminController.getApiUsage);
router.get('/system-health', superAdminController.getSystemHealth);
router.get('/audit-logs', validate(validateListQuery), superAdminController.getAuditLogs);
router.post('/tenant-provision', validate(validateTenantProvision), superAdminController.postTenantProvision);
router.patch('/feature-flags', validate(validateFeatureFlagsPatch), superAdminController.patchFeatureFlags);

router.get('/action-center', superAdminController.getActionCenter);
router.get('/notifications', validate(validateListQuery), superAdminController.getNotificationsFeed);
router.get('/multi-city-rollups', superAdminController.getMultiCityRollups);
router.get('/organizations', superAdminController.getOrganizations);
router.get('/client-workspace', superAdminController.getClientWorkspace);
router.get('/projects', validate(validateListQuery), superAdminController.listProjects);
router.post('/projects', validate(validateProjectCreate), superAdminController.createProject);
router.get('/topology', superAdminController.getTopology);

router.get('/global-users', validate(validateListQuery), superAdminController.getGlobalUsers);
router.get('/roles-permissions', superAdminController.getRolesPermissions);
router.get('/approvals', validate(validateListQuery), superAdminController.listApprovals);
router.post('/approvals', validate(validateApprovalCreate), superAdminController.createApproval);
router.patch('/approvals/:id', validate(validateApprovalDecision), superAdminController.patchApprovalStatus);
router.get('/master-data', superAdminController.getMasterData);

router.get('/scoring-thresholds', superAdminController.getScoringThresholds);
router.patch('/scoring-thresholds', superAdminController.patchScoringThresholds);
router.get('/escalation-policies', superAdminController.getEscalationPolicies);
router.patch('/escalation-policies', superAdminController.patchEscalationPolicies);
router.get('/templates', superAdminController.getTemplates);
router.post('/templates', superAdminController.upsertTemplate);
router.get('/localization', superAdminController.getLocalization);
router.patch('/localization', superAdminController.patchLocalization);

router.get('/platform-analytics', superAdminController.getPlatformAnalytics);
router.get('/storage-analytics', superAdminController.getStorageAnalytics);
router.get('/ai-usage', superAdminController.getAiUsage);
router.get('/queue-health', superAdminController.getQueueHealth);
router.get('/sync-failures', validate(validateListQuery), superAdminController.getSyncFailures);
router.patch('/sync-failures/:id', validate(validateSyncFailurePatch), superAdminController.patchSyncFailureStatus);
router.get('/device-fleet', superAdminController.getDeviceFleet);
router.get('/tenant-health', validate(validateListQuery), superAdminController.getTenantHealth);

router.get('/api-access/overview', apiAccessController.getOverview);
router.get('/api-access/tenants', apiAccessController.listTenantsForScope);
router.get('/api-access/debug/nearby-toilets', apiAccessController.debugNearbyToilets);
router.get('/api-access/analytics', apiAccessController.getAnalytics);
router.get('/api-access/logs', apiAccessController.listLogs);
router.get('/api-access/events', apiAccessController.listEvents);
router.get('/api-access/keys', apiAccessController.listKeys);
router.get('/api-access/projects', apiAccessController.listProjects);
router.post('/api-access/projects', apiAccessController.createProject);
router.get('/api-access/projects/:projectId', apiAccessController.getProjectById);
router.patch('/api-access/projects/:projectId', apiAccessController.updateProject);
router.get('/api-access/projects/:projectId/keys', apiAccessController.listKeys);
router.post('/api-access/projects/:projectId/keys', apiAccessController.createKey);
router.get('/api-access/projects/:projectId/logs', apiAccessController.listLogs);
router.get('/api-access/projects/:projectId/events', apiAccessController.listEvents);
router.get('/api-access/projects/:projectId/analytics', apiAccessController.getAnalytics);
router.patch('/api-access/keys/:keyId', apiAccessController.updateKey);
router.post('/api-access/keys/:keyId/revoke', apiAccessController.revokeKey);
router.post('/api-access/keys/:keyId/regenerate', apiAccessController.regenerateKey);

router.get('/support', validate(validateListQuery), superAdminController.getSupportConsole);
router.post('/support', validate(validateSupportTicketCreate), superAdminController.createSupportTicket);
router.patch('/support/:id', validate(validateSupportTicketPatch), superAdminController.patchSupportTicket);
router.get('/integrations', validate(validateListQuery), superAdminController.listIntegrations);
router.post('/integrations', validate(validateIntegrationUpsert), superAdminController.upsertIntegration);
router.get('/releases', validate(validateListQuery), superAdminController.listReleases);
router.post('/releases', validate(validateReleaseCreate), superAdminController.createRelease);
router.get('/backups/stats', backupController.getStats);
router.get('/backups/jobs', backupController.listJobs);
router.post('/backups/run', backupController.triggerManualBackup);
router.get('/backups/jobs/:id/file', backupController.downloadLocalFile);
router.get('/backups/jobs/:id', backupController.getJobDetails);
router.post('/backups/jobs/:id/download', backupController.createDownloadUrl);
router.post('/backups/jobs/:id/retry', backupController.retryBackup);
router.post('/backups/cleanup', backupController.cleanupExpiredBackups);
router.get('/backups/schedules', backupController.listSchedules);
router.post('/backups/schedules', backupController.upsertSchedule);
router.patch('/backups/schedules/:id', backupController.upsertSchedule);
router.delete('/backups/schedules/:id', backupController.deleteSchedule);
router.get('/backups', validate(validateListQuery), superAdminController.listBackups);
router.post('/backups', validate(validateBackupCreate), superAdminController.createBackup);
router.get('/policy', superAdminController.getPolicy);
router.patch('/policy', superAdminController.patchPolicy);
router.get('/reliability', superAdminController.getReliability);
router.get('/settings', superAdminController.getSettings);
router.patch('/settings', superAdminController.patchSettings);

module.exports = router;
