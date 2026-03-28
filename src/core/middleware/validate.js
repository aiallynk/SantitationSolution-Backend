const AppError = require('../errors/AppError');

const validate = (validator) => {
  return (req, res, next) => {
    const errors = validator(req);
    if (!Array.isArray(errors) || errors.length === 0) {
      return next();
    }

    return next(
      new AppError('Validation failed', 400, {
        code: 'VALIDATION_ERROR',
        errors,
      })
    );
  };
};

module.exports = { validate };
