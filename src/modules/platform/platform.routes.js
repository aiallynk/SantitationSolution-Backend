const express = require('express');
const platformController = require('./platform.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateTenantCreate,
  validateGeographyCreate,
  validateFacilityCreate,
  validateBlockCreate,
  validateUnitCreate,
} = require('./platform.validator');

const router = express.Router();

router.use(protect);

router.get('/tenants', requirePermissions('dashboard.read'), platformController.getTenants);
router.post('/tenants', requirePermissions('tenants.manage'), validate(validateTenantCreate), platformController.postTenant);
router.patch('/tenants/:id', requirePermissions('tenants.manage'), platformController.patchTenant);

router.get('/geographies/tree', requirePermissions('dashboard.read'), platformController.getGeographiesTree);
router.post('/geographies', requirePermissions('tenants.manage'), validate(validateGeographyCreate), platformController.postGeography);

router.get('/facilities', requirePermissions('dashboard.read'), platformController.getFacilities);
router.post('/facilities', requirePermissions('task.manage'), validate(validateFacilityCreate), platformController.postFacility);
router.get('/facilities/:id', requirePermissions('dashboard.read'), platformController.getFacilityById);
router.patch('/facilities/:id', requirePermissions('task.manage'), platformController.patchFacility);

router.get('/toilet-blocks', requirePermissions('dashboard.read'), platformController.getToiletBlocks);
router.post('/toilet-blocks', requirePermissions('task.manage'), validate(validateBlockCreate), platformController.postToiletBlock);

router.get('/toilet-units', requirePermissions('dashboard.read'), platformController.getToiletUnits);
router.post('/toilet-units', requirePermissions('task.manage'), validate(validateUnitCreate), platformController.postToiletUnit);

module.exports = router;
