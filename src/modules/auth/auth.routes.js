const express = require('express');
const authController = require('./auth.controller');
const { validate } = require('../../core/middleware/validate');
const {
  validateLogin,
  validateRefresh,
  validateForgotPassword,
  validateResetPassword,
  validateVerifyResetToken,
  validateUpdateMe,
} = require('./auth.validator');
const { protect } = require('../../core/middleware/auth');

const router = express.Router();

router.post('/login', validate(validateLogin), authController.login);
router.post('/refresh', validate(validateRefresh), authController.refresh);
router.post('/logout', validate(validateRefresh), authController.logout);
router.post('/forgot-password', validate(validateForgotPassword), authController.forgotPassword);
router.post('/verify-reset-token', validate(validateVerifyResetToken), authController.verifyResetToken);
router.post('/reset-password', validate(validateResetPassword), authController.resetPassword);
router.get('/me', protect, authController.getMe);
router.patch('/me', protect, validate(validateUpdateMe), authController.patchMe);

module.exports = router;
