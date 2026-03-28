const AppError = require('../errors/AppError');

const notFound = (req, res, next) => {
  next(
    new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, {
      code: 'ROUTE_NOT_FOUND',
    })
  );
};

module.exports = { notFound };
