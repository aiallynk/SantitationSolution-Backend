const express = require('express');
const platformController = require('./platform.controller');
const {
  protect,
  requirePermissions,
  requireAnyPermissions,
  requireNotRoles,
  requireAction,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateTenantCreate,
  validateGeographyCreate,
  validateFacilityCreate,
  validateFacilityQrResolve,
  validateBlockCreate,
  validateUnitCreate,
  validateUnitBulkCreate,
  validateQrResolve,
} = require('./platform.validator');
const {
  ManagementLevels,
  RouteKeys,
  ScopeTypes,
  SurfaceTypes,
} = require('../../core/rbac/accessMatrix');

const router = express.Router();
const PLATFORM_ROUTE_PREFIXES = [
  '/tenants',
  '/geographies',
  '/global-geographies',
  '/operational-master-data',
  '/facilities',
  '/toilet-blocks',
  '/toilet-units',
  '/toilets',
];

const COMMON_SCOPE_RULE = {
  scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY],
};
const ADMIN_MANAGEMENT_SCOPE_RULE = {
  managementLevels: [ManagementLevels.TENANT, ManagementLevels.GEOGRAPHY],
};
const OPS_WEB_SURFACES = [SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE];
const OPS_AND_PLATFORM_WEB_SURFACES = [...OPS_WEB_SURFACES, SurfaceTypes.PLATFORM_WEB];
const OPS_AND_MOBILE_SURFACES = [...OPS_WEB_SURFACES, SurfaceTypes.MOBILE_ONLY];
const ADMINOPS_ROUTE_KEYS = [RouteKeys.OPS_ADMINOPS, RouteKeys.SA_TENANTS, RouteKeys.SA_GLOBAL_USERS];
const TOILETS_ROUTE_KEYS = [
  RouteKeys.OPS_TOILETS,
  RouteKeys.OPS_AUDITOR_ASSETS,
  RouteKeys.SA_TENANTS,
  RouteKeys.SA_GLOBAL_USERS,
];

router.use(PLATFORM_ROUTE_PREFIXES, protect);

router.get(
  '/tenants/me',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_SETTINGS, RouteKeys.OPS_USERS),
  requireScope(COMMON_SCOPE_RULE),
  requireAnyPermissions('dashboard.read', 'users.manage'),
  platformController.getOwnTenantProfile
);
router.patch(
  '/tenants/me/profile',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_SETTINGS, RouteKeys.OPS_USERS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('users.manage'),
  platformController.patchOwnTenantProfile
);
router.get(
  '/tenants/me/ai-scoring-mode',
  requireSurface(...OPS_WEB_SURFACES), requireRouteKey(RouteKeys.OPS_SETTINGS), requireScope(COMMON_SCOPE_RULE),
  requireAnyPermissions('dashboard.read', 'users.manage'), platformController.getOwnTenantAiScoringMode
);
router.patch(
  '/tenants/me/ai-scoring-mode',
  requireSurface(...OPS_WEB_SURFACES), requireRouteKey(RouteKeys.OPS_SETTINGS), requireScope(COMMON_SCOPE_RULE),
  requirePermissions('users.manage'), platformController.patchOwnTenantAiScoringMode
);
router.get(
  '/tenants',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getTenants
);
router.post(
  '/tenants',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('tenants.manage'),
  requireAction('platform.manage'),
  validate(validateTenantCreate),
  platformController.postTenant
);
router.patch(
  '/tenants/:id',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('tenants.manage'),
  requireAction('platform.manage'),
  platformController.patchTenant
);

router.get(
  '/geographies/tree',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getGeographiesTree
);
router.get(
  '/geographies/options',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getGeographyOptions
);
router.get(
  '/global-geographies/options',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getGlobalGeographyOptions
);
router.get(
  '/global-geographies/sources',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS, RouteKeys.OPS_SETTINGS),
  requireScope(COMMON_SCOPE_RULE),
  requireAnyPermissions('dashboard.read', 'auth.read'),
  platformController.getGlobalGeographyDataSources
);
router.post(
  '/global-geographies/:id/activate',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('users.manage'),
  platformController.postGlobalGeographyActivation
);
router.get(
  '/geographies/import-jobs',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(RouteKeys.SA_TENANTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getGeographyImportJobs
);
router.post(
  '/geographies/import-jobs',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(RouteKeys.SA_TENANTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('tenants.manage'),
  requireAction('platform.manage'),
  platformController.postGeographyImportJob
);
router.post(
  '/geographies/request-missing-area',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.postRequestMissingArea
);
router.get(
  '/geographies/migration-reviews',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(RouteKeys.SA_TENANTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getGeographyMigrationReviews
);
router.patch(
  '/geographies/migration-reviews/:id',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(RouteKeys.SA_TENANTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('tenants.manage'),
  requireAction('platform.manage'),
  platformController.patchGeographyMigrationReview
);
router.put(
  '/tenants/:tenantId/geographies/:geographyId',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(RouteKeys.SA_TENANTS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('tenants.manage'),
  requireAction('platform.manage'),
  platformController.putTenantGeographyAssignment
);
router.post(
  '/geographies',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requireAnyPermissions('tenants.manage', 'task.manage'),
  requireAction('hierarchy.manage'),
  validate(validateGeographyCreate),
  platformController.postGeography
);
router.patch(
  '/geographies/:id',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requireAnyPermissions('tenants.manage', 'task.manage'),
  requireAction('hierarchy.manage'),
  platformController.patchGeography
);
router.delete(
  '/geographies/:id',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requireAnyPermissions('tenants.manage', 'task.manage'),
  requireAction('hierarchy.manage'),
  platformController.deleteGeography
);

router.get(
  '/operational-master-data',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS, RouteKeys.SA_PLATFORM_HEALTH),
  requireScope(COMMON_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requirePermissions('dashboard.read'),
  platformController.getOperationalMasterData
);
router.post(
  '/operational-master-data',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS, RouteKeys.SA_PLATFORM_HEALTH),
  requireScope(COMMON_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requireAnyPermissions('task.manage', 'tenants.manage'),
  platformController.postOperationalMasterData
);
router.patch(
  '/operational-master-data/:id',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS, RouteKeys.SA_PLATFORM_HEALTH),
  requireScope(COMMON_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requireAnyPermissions('task.manage', 'tenants.manage'),
  platformController.patchOperationalMasterData
);
router.post(
  '/operational-master-data/:id/activate',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS, RouteKeys.SA_PLATFORM_HEALTH),
  requireScope(COMMON_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requireAnyPermissions('task.manage', 'tenants.manage'),
  platformController.postOperationalMasterDataActivate
);
router.post(
  '/operational-master-data/:id/deactivate',
  requireSurface(...OPS_AND_PLATFORM_WEB_SURFACES),
  requireRouteKey(...ADMINOPS_ROUTE_KEYS, RouteKeys.SA_PLATFORM_HEALTH),
  requireScope(COMMON_SCOPE_RULE),
  requireNotRoles('tenant_admin', 'state_admin'),
  requireAnyPermissions('task.manage', 'tenants.manage'),
  platformController.postOperationalMasterDataDeactivate
);

router.get(
  '/facilities',
  requireSurface(...[...OPS_AND_MOBILE_SURFACES, SurfaceTypes.PLATFORM_WEB]),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getFacilities
);
router.post(
  '/facilities',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  validate(validateFacilityCreate),
  platformController.postFacility
);
router.post(
  '/facilities/resolve',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS, ...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requireAnyPermissions('dashboard.read', 'inspection.create'),
  validate(validateFacilityQrResolve),
  platformController.postFacilityQrResolve
);
router.get(
  '/facilities/:id',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getFacilityById
);
router.get(
  '/facilities/:id/qr',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS, ...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getFacilityQr
);
router.post(
  '/facilities/:id/qr/download',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.postFacilityQrDownload
);
router.post(
  '/facilities/:id/qr/print',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.postFacilityQrPrint
);
router.post(
  '/facilities/:id/qr/regenerate',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  platformController.postFacilityQrRegenerate
);
router.patch(
  '/facilities/:id',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  platformController.patchFacility
);
router.delete(
  '/facilities/:id',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  platformController.deleteFacility
);

router.get(
  '/toilet-blocks',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletBlocks
);
router.post(
  '/toilet-blocks',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  validate(validateBlockCreate),
  platformController.postToiletBlock
);

router.get(
  '/toilet-units',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletUnits
);
router.get(
  '/toilets/map',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletMap
);
// QR resolve is used by the mobile app to map scanned toilet/public QR values to a toilet unit.
// Supervisors are allowed on mobile but may not have `inspection.create`, so keep this endpoint readable.
router.get(
  '/toilet-units/resolve',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requireAnyPermissions('dashboard.read', 'inspection.create'),
  platformController.getToiletUnitByQr
);
router.post(
  '/toilet-units/resolve',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requireAnyPermissions('dashboard.read', 'inspection.create'),
  validate(validateQrResolve),
  platformController.postToiletUnitByQr
);
router.post(
  '/toilet-units/bulk',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  validate(validateUnitBulkCreate),
  platformController.postToiletUnitsBulk
);
router.post(
  '/toilet-units',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  validate(validateUnitCreate),
  platformController.postToiletUnit
);
router.patch(
  '/toilet-units/:id/deactivate',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  platformController.patchToiletUnitDeactivate
);
router.patch(
  '/toilet-units/:id/reactivate',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  platformController.patchToiletUnitReactivate
);
router.delete(
  '/toilet-units/:id',
  requireSurface(...OPS_WEB_SURFACES),
  requireRouteKey(RouteKeys.OPS_ADMINOPS),
  requireScope(ADMIN_MANAGEMENT_SCOPE_RULE),
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  platformController.deleteToiletUnit
);
router.get(
  '/toilets/:toiletId/inspections',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletInspections
);
router.get(
  '/toilets/:id/details',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletDetails
);
router.get(
  '/toilets/:id/latest-inspection',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletLatestInspection
);
router.get(
  '/toilets/:id/score-trends',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletScoreTrends
);
router.get(
  '/toilets/:id/inspection-history',
  requireSurface(...OPS_AND_MOBILE_SURFACES),
  requireRouteKey(...TOILETS_ROUTE_KEYS),
  requireScope(COMMON_SCOPE_RULE),
  requirePermissions('dashboard.read'),
  platformController.getToiletInspectionHistory
);

module.exports = router;
