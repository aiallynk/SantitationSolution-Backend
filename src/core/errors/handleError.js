const AppError = require('./AppError');

const normalizeMulterError = (err) => {
  if (!err || err.name !== 'MulterError') {
    return err;
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return new AppError('Image size exceeds the allowed 5MB limit', 400);
  }

  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return new AppError('Unexpected file field received in request', 400);
  }

  return new AppError('File upload failed', 400);
};

const normalizeSequelizeError = (err) => {
  if (!err || !err.name || !err.name.startsWith('Sequelize')) {
    return err;
  }

  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    const errors = err.errors ? err.errors.map((item) => item.message) : [];
    return new AppError('Validation failed', 400, errors);
  }

  return new AppError('Database operation failed', 500);
};

const handleError = (error, req, res, next) => {
  let err = error;
  err = normalizeMulterError(err);
  err = normalizeSequelizeError(err);

  const statusCode = err.statusCode || 500;
  const isOperational = Boolean(err.isOperational);

  const payload = {
    status: 'error',
    message: err.message || 'Something went wrong',
  };

  if (Array.isArray(err.errors) && err.errors.length > 0) {
    payload.errors = err.errors;
  }

  if (process.env.NODE_ENV === 'development' && !isOperational) {
    payload.stack = err.stack;
  }

  if (!isOperational && statusCode >= 500) {
    console.error('Unhandled error:', err);
  }

  res.status(statusCode).json(payload);
};

module.exports = { handleError };
