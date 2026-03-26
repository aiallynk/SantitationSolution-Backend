class AppError extends Error {
  constructor(message, statusCode = 500, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.status = 'error';
    this.isOperational = true;
    if (errors) {
      this.errors = errors;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
