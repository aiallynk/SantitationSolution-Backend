const { isBlank } = require('../../utils/validators');

const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(String(value || '').trim());

const validateCreateSupervisorWorker = (req) => {
  const errors = [];

  if (isBlank(req.body.fullName)) errors.push('fullName is required');
  if (isBlank(req.body.email)) errors.push('email is required');
  if (!isBlank(req.body.email) && !isValidEmail(req.body.email)) {
    errors.push('email must be a valid email address');
  }
  if (isBlank(req.body.mobileNumber)) errors.push('mobileNumber is required');
  if (isBlank(req.body.address)) errors.push('address is required');
  if (isBlank(req.body.gender)) errors.push('gender is required');

  return errors;
};

module.exports = {
  validateCreateSupervisorWorker,
};
