const { isBlank } = require('../../utils/validators');

const validateLogin = (req) => {
  const errors = [];
  const { identifier, username, email, password } = req.body;
  const resolvedIdentifier = identifier || username || email;

  if (isBlank(resolvedIdentifier)) {
    errors.push('identifier is required');
  }
  if (isBlank(password)) {
    errors.push('password is required');
  }
  if (!isBlank(password) && String(password).length > 128) {
    errors.push('password must be 128 characters or fewer');
  }
  if (!isBlank(req.body.tenantId) && String(req.body.tenantId).trim().length < 10) {
    errors.push('tenantId appears invalid');
  }
  return errors;
};

const validateRefresh = (req) => {
  const errors = [];
  if (isBlank(req.body.refreshToken)) {
    errors.push('refreshToken is required');
  }
  return errors;
};

const validateForgotPassword = (req) => {
  const errors = [];
  if (isBlank(req.body.email)) {
    errors.push('email is required');
  }
  return errors;
};

const validateResetPassword = (req) => {
  const errors = [];
  if (isBlank(req.body.token)) {
    errors.push('token is required');
  }
  if (isBlank(req.body.newPassword)) {
    errors.push('newPassword is required');
  } else if (String(req.body.newPassword).length < 8) {
    errors.push('newPassword must be at least 8 characters');
  }
  return errors;
};

const validateVerifyResetToken = (req) => {
  const errors = [];
  if (isBlank(req.body.token)) {
    errors.push('token is required');
  }
  return errors;
};

const validateUpdateMe = (req) => {
  const errors = [];
  if (req.body.fullName !== undefined) {
    const fullName = String(req.body.fullName || '').trim();
    if (!fullName) {
      errors.push('fullName cannot be blank');
    } else if (fullName.length > 180) {
      errors.push('fullName must be 180 characters or fewer');
    }
  }
  if (req.body.phone !== undefined) {
    const phone = String(req.body.phone || '').trim();
    if (phone && phone.length > 32) {
      errors.push('phone must be 32 characters or fewer');
    }
  }
  if (req.body.employeeCode !== undefined) {
    const employeeCode = String(req.body.employeeCode || '').trim();
    if (employeeCode.length > 64) {
      errors.push('employeeCode must be 64 characters or fewer');
    }
  }
  if (req.body.remarks !== undefined) {
    const remarks = String(req.body.remarks || '').trim();
    if (remarks.length > 500) {
      errors.push('remarks must be 500 characters or fewer');
    }
  }
  if (req.body.metadata !== undefined) {
    const isObject = req.body.metadata && typeof req.body.metadata === 'object' && !Array.isArray(req.body.metadata);
    if (req.body.metadata !== null && !isObject) {
      errors.push('metadata must be a JSON object');
    }
  }
  return errors;
};

module.exports = {
  validateLogin,
  validateRefresh,
  validateForgotPassword,
  validateResetPassword,
  validateVerifyResetToken,
  validateUpdateMe,
};
