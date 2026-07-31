const authService = require('./auth.service');
const { sendSuccess } = require('../../core/http/response');

const login = async (req, res, next) => {
  try {
    const payload = await authService.login({
      identifier: req.body.identifier || req.body.username || req.body.email,
      password: req.body.password,
      tenantId: req.body.tenantId || req.headers['x-tenant-id'] || null,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Login successful',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const refresh = async (req, res, next) => {
  try {
    const payload = await authService.refresh({
      refreshToken: req.body.refreshToken,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Token refreshed successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const payload = await authService.logout({
      refreshToken: req.body.refreshToken,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Logout processed successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const payload = await authService.forgotPassword({
      email: req.body.email,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Password reset flow initiated',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const resetPassword = async (req, res, next) => {
  try {
    const payload = await authService.resetPassword({
      token: req.body.token,
      newPassword: req.body.newPassword,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Password reset successful',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const verifyResetToken = async (req, res, next) => {
  try {
    const payload = await authService.verifyResetToken({
      token: req.body.token,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Reset token verified',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const verifyActivationToken = async (req, res, next) => {
  try {
    const payload = await authService.verifyActivationToken({
      token: req.body.token,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Activation token verified',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const activateAccount = async (req, res, next) => {
  try {
    const payload = await authService.activateAccount({
      token: req.body.token,
      newPassword: req.body.newPassword,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Account activated successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const changeTemporaryPassword = async (req, res, next) => {
  try {
    const payload = await authService.changeTemporaryPassword({
      userId: req.user.id,
      activeTenantId: req.user?.tenantId || null,
      newPassword: req.body.newPassword,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Password changed successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const getMe = async (req, res, next) => {
  try {
    const payload = await authService.getMe({
      userId: req.user.id,
      activeTenantId: req.user?.tenantId || null,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Profile fetched successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const patchMe = async (req, res, next) => {
  try {
    const payload = await authService.updateMe({
      userId: req.user.id,
      body: req.body,
      req,
    });
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Profile updated successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  login,
  refresh,
  logout,
  forgotPassword,
  verifyResetToken,
  verifyActivationToken,
  activateAccount,
  changeTemporaryPassword,
  resetPassword,
  getMe,
  patchMe,
};
