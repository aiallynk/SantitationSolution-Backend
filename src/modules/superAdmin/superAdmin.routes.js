const express = require('express');
const superAdminController = require('./superAdmin.controller');
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
const { protect, requireRoles } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');

const router = express.Router();

router.use(protect, requireRoles('super_admin'));

router.get('/tenants', superAdminController.getTenants);
router.get('/tenants/:id', superAdminController.getTenantById);
router.post('/tenants', validate(validateTenantProvision), superAdminController.postTenantProvision);
router.patch('/tenants/:id', validate(validateTenantPatch), superAdminController.patchTenant);
router.get('/regions', superAdminController.getRegions);
router.get('/platform-metrics', superAdminController.getPlatformMetrics);
router.get('/storage', validate(validateListQuery), superAdminController.getStorage);
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

router.get('/support', validate(validateListQuery), superAdminController.getSupportConsole);
router.post('/support', validate(validateSupportTicketCreate), superAdminController.createSupportTicket);
router.patch('/support/:id', validate(validateSupportTicketPatch), superAdminController.patchSupportTicket);
router.get('/integrations', validate(validateListQuery), superAdminController.listIntegrations);
router.post('/integrations', validate(validateIntegrationUpsert), superAdminController.upsertIntegration);
router.get('/releases', validate(validateListQuery), superAdminController.listReleases);
router.post('/releases', validate(validateReleaseCreate), superAdminController.createRelease);
router.get('/backups', validate(validateListQuery), superAdminController.listBackups);
router.post('/backups', validate(validateBackupCreate), superAdminController.createBackup);
router.get('/policy', superAdminController.getPolicy);
router.patch('/policy', superAdminController.patchPolicy);
router.get('/reliability', superAdminController.getReliability);
router.get('/settings', superAdminController.getSettings);
router.patch('/settings', superAdminController.patchSettings);

module.exports = router;

