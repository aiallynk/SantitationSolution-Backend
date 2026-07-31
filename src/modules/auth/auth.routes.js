const express = require('express');
const authController = require('./auth.controller');
const { validate } = require('../../core/middleware/validate');
const {
  validateLogin,
  validateRefresh,
  validateLogout,
  validateForgotPassword,
  validateResetPassword,
  validateVerifyResetToken,
  validateVerifyActivationToken,
  validateActivateAccount,
  validateChangeTemporaryPassword,
  validateUpdateMe,
} = require('./auth.validator');
const { protect } = require('../../core/middleware/auth');
const { authSensitiveRateLimit } = require('../../core/security/rateLimit');

const router = express.Router();

router.post('/login', authSensitiveRateLimit, validate(validateLogin), authController.login);
router.post('/refresh', authSensitiveRateLimit, validate(validateRefresh), authController.refresh);
router.post('/logout', authSensitiveRateLimit, validate(validateLogout), authController.logout);
router.post('/forgot-password', authSensitiveRateLimit, validate(validateForgotPassword), authController.forgotPassword);
router.post('/verify-reset-token', validate(validateVerifyResetToken), authController.verifyResetToken);
router.post('/reset-password', authSensitiveRateLimit, validate(validateResetPassword), authController.resetPassword);
router.post('/verify-activation-token', authSensitiveRateLimit, validate(validateVerifyActivationToken), authController.verifyActivationToken);
router.post('/activate-account', authSensitiveRateLimit, validate(validateActivateAccount), authController.activateAccount);
router.post('/change-temporary-password', authSensitiveRateLimit, protect, validate(validateChangeTemporaryPassword), authController.changeTemporaryPassword);
router.get('/me', protect, authController.getMe);
router.patch('/me', protect, validate(validateUpdateMe), authController.patchMe);

module.exports = router;
