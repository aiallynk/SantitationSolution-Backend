class AppError extends Error {
  constructor(message, statusCode = 500, options = {}) {
    super(message);
    this.statusCode = statusCode;
    this.status = 'error';
    this.code = options.code || 'INTERNAL_ERROR';
    this.isOperational = true;
    if (Array.isArray(options.errors) && options.errors.length > 0) {
      this.errors = options.errors;
    }
    if (options.details) {
      this.details = options.details;
    }

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
