const express = require('express');
const userController = require('./user.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateUserListQuery,
  validateCreateUser,
  validatePatchUser,
} = require('./user.validator');

const router = express.Router();

router.use(protect);

router.get('/users', requirePermissions('users.manage'), validate(validateUserListQuery), userController.getUsers);
router.get('/users/:id', requirePermissions('users.manage'), userController.getUserById);
router.post('/users', requirePermissions('users.manage'), validate(validateCreateUser), userController.postUser);
router.patch('/users/:id', requirePermissions('users.manage'), validate(validatePatchUser), userController.patchUser);

router.get('/roles', requirePermissions('users.manage'), userController.getRoles);
router.get('/permissions', requirePermissions('users.manage'), userController.getPermissions);

module.exports = router;
