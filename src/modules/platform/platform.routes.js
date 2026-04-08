const express = require('express');
const platformController = require('./platform.controller');
const { protect, requirePermissions, requireAction } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateTenantCreate,
  validateGeographyCreate,
  validateFacilityCreate,
  validateBlockCreate,
  validateUnitCreate,
  validateQrResolve,
} = require('./platform.validator');

const router = express.Router();

router.use(protect);

router.get('/tenants', requirePermissions('dashboard.read'), platformController.getTenants);
router.post(
  '/tenants',
  requirePermissions('tenants.manage'),
  requireAction('platform.manage'),
  validate(validateTenantCreate),
  platformController.postTenant
);
router.patch(
  '/tenants/:id',
  requirePermissions('tenants.manage'),
  requireAction('platform.manage'),
  platformController.patchTenant
);

router.get('/geographies/tree', requirePermissions('dashboard.read'), platformController.getGeographiesTree);
router.post(
  '/geographies',
  requirePermissions('tenants.manage'),
  requireAction('hierarchy.manage'),
  validate(validateGeographyCreate),
  platformController.postGeography
);

router.get('/facilities', requirePermissions('dashboard.read'), platformController.getFacilities);
router.post(
  '/facilities',
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  validate(validateFacilityCreate),
  platformController.postFacility
);
router.get('/facilities/:id', requirePermissions('dashboard.read'), platformController.getFacilityById);
router.patch(
  '/facilities/:id',
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  platformController.patchFacility
);

router.get('/toilet-blocks', requirePermissions('dashboard.read'), platformController.getToiletBlocks);
router.post(
  '/toilet-blocks',
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  validate(validateBlockCreate),
  platformController.postToiletBlock
);

router.get('/toilet-units', requirePermissions('dashboard.read'), platformController.getToiletUnits);
// QR resolve is used by the mobile app to map scanned toilet/public QR values to a toilet unit.
// Supervisors are allowed on mobile but may not have `inspection.create`, so keep this endpoint readable.
router.get('/toilet-units/resolve', requirePermissions('dashboard.read'), platformController.getToiletUnitByQr);
router.post(
  '/toilet-units/resolve',
  requirePermissions('dashboard.read'),
  validate(validateQrResolve),
  platformController.postToiletUnitByQr
);
router.post(
  '/toilet-units',
  requirePermissions('task.manage'),
  requireAction('facility.manage'),
  validate(validateUnitCreate),
  platformController.postToiletUnit
);
router.get('/toilets/:toiletId/inspections', requirePermissions('dashboard.read'), platformController.getToiletInspections);
router.get('/toilets/:id/details', requirePermissions('dashboard.read'), platformController.getToiletDetails);
router.get('/toilets/:id/latest-inspection', requirePermissions('dashboard.read'), platformController.getToiletLatestInspection);
router.get('/toilets/:id/score-trends', requirePermissions('dashboard.read'), platformController.getToiletScoreTrends);
router.get('/toilets/:id/inspection-history', requirePermissions('dashboard.read'), platformController.getToiletInspectionHistory);

module.exports = router;
