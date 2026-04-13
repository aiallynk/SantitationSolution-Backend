const express = require('express');
const userController = require('./user.controller');
const {
  protect,
  requirePermissions,
  requireAction,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateUserListQuery,
  validateCreateUser,
  validatePatchUser,
} = require('./user.validator');
const { ManagementLevels, RouteKeys, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

router.use(protect);
router.use(
  requireSurface(
    SurfaceTypes.OPS_WEB,
    SurfaceTypes.OPS_WEB_AND_MOBILE,
    SurfaceTypes.PLATFORM_WEB,
  ),
  requireRouteKey(RouteKeys.OPS_USERS, RouteKeys.SA_GLOBAL_USERS),
  requireScope({
    managementLevels: [ManagementLevels.PLATFORM, ManagementLevels.TENANT, ManagementLevels.GEOGRAPHY],
  }),
);

router.get('/users', requirePermissions('users.manage'), validate(validateUserListQuery), userController.getUsers);
router.get('/users/supervisors', requirePermissions('users.manage'), userController.getSupervisors);
router.get('/users/:id', requirePermissions('users.manage'), userController.getUserById);
router.post(
  '/users',
  requirePermissions('users.manage'),
  requireAction('user.manage'),
  validate(validateCreateUser),
  userController.postUser
);
router.patch(
  '/users/:id',
  requirePermissions('users.manage'),
  requireAction('user.manage'),
  validate(validatePatchUser),
  userController.patchUser
);
router.delete(
  '/users/:id',
  requirePermissions('users.manage'),
  requireAction('user.manage'),
  userController.deleteUser
);

router.get('/roles', requirePermissions('users.manage'), userController.getRoles);
router.get('/permissions', requirePermissions('users.manage'), userController.getPermissions);

module.exports = router;
