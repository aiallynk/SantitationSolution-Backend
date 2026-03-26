const { isBlank } = require('../../utils/validators');

const validateLoginRequest = (req) => {
  const errors = [];
  const { username, password } = req.body;

  if (isBlank(username)) {
    errors.push('username is required');
  } else if (String(username).trim().length > 80) {
    errors.push('username must be 80 characters or less');
  }

  if (isBlank(password)) {
    errors.push('password is required');
  } else if (String(password).length > 128) {
    errors.push('password must be 128 characters or less');
  }

  return errors;
};

module.exports = {
  validateLoginRequest,
};
