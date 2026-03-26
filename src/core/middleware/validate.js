const AppError = require('../errors/AppError');
const fs = require('fs');

const collectUploadedPaths = (req) => {
  const paths = [];

  if (req.file && req.file.path) {
    paths.push(req.file.path);
  }

  if (req.files && typeof req.files === 'object') {
    Object.values(req.files).forEach((value) => {
      if (Array.isArray(value)) {
        value.forEach((file) => {
          if (file && file.path) {
            paths.push(file.path);
          }
        });
      }
    });
  }

  return [...new Set(paths)];
};

const cleanupUploadedFiles = (req) => {
  const filePaths = collectUploadedPaths(req);

  filePaths.forEach((filePath) => {
    fs.unlink(filePath, () => {});
  });
};

const validate = (validatorFn) => {
  return (req, res, next) => {
    const errors = validatorFn(req) || [];

    if (errors.length > 0) {
      cleanupUploadedFiles(req);
      return next(new AppError('Validation failed', 400, errors));
    }

    return next();
  };
};

module.exports = {
  validate,
};
