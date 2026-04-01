const AppError = require('./AppError');

const extractDbMeta = (err) => {
  const original = err?.original || err?.parent || {};
  const dbMessage = original?.message || err?.message || null;
  const dbCode = original?.code || null;
  const detail = original?.detail || null;
  const hint = original?.hint || null;
  const table = original?.table || null;
  const column = original?.column || null;
  const constraint = original?.constraint || null;

  return {
    dbMessage,
    dbCode,
    detail,
    hint,
    table,
    column,
    constraint,
  };
};

const normalizeSequelizeError = (err) => {
  if (!err?.name || !String(err.name).startsWith('Sequelize')) {
    return err;
  }

  if (
    err.name === 'SequelizeValidationError' ||
    err.name === 'SequelizeUniqueConstraintError'
  ) {
    const errors = (err.errors || []).map((item) => item.message);
    return new AppError('Validation failed', 400, {
      code: 'VALIDATION_ERROR',
      errors,
    });
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    return new AppError('Invalid reference to related resource', 400, {
      code: 'FK_CONSTRAINT_ERROR',
    });
  }

  const dbMeta = extractDbMeta(err);
  const dbCode = String(dbMeta.dbCode || '').trim();
  if (dbCode === '42703' || dbCode === '42P01') {
    return new AppError('Database schema is out of date. Run database migrations.', 500, {
      code: 'SCHEMA_MISMATCH',
      details:
        process.env.NODE_ENV === 'production'
          ? { hint: 'Run: npm run db:migrate' }
          : {
              hint: 'Run: npm run db:migrate',
              ...dbMeta,
            },
    });
  }

  if (dbCode === '22P02') {
    return new AppError('Invalid input format for database query', 400, {
      code: 'INVALID_QUERY_FORMAT',
      details:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              ...dbMeta,
            },
    });
  }

  return new AppError('Database operation failed', 500, {
    code: 'DB_OPERATION_FAILED',
    details:
      process.env.NODE_ENV === 'production'
        ? undefined
        : {
            ...dbMeta,
            sequelizeErrorName: err.name || null,
          },
  });
};

const normalizeJsonBodyError = (err) => {
  if (!err) {
    return err;
  }
  if (err.type === 'entity.parse.failed') {
    return new AppError('Invalid JSON body format', 400, {
      code: 'INVALID_JSON_BODY',
      details:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              body: err.body || null,
            },
    });
  }
  return err;
};

const normalizeUploadError = (err) => {
  if (!err || err.name !== 'MulterError') {
    if (err?.message && String(err.message).toLowerCase().includes('only image files are allowed')) {
      return new AppError('Only image files are allowed', 400, {
        code: 'INVALID_MEDIA_TYPE',
      });
    }
    return err;
  }

  if (err.code === 'LIMIT_FILE_SIZE') {
    return new AppError('Uploaded file exceeds allowed size', 400, {
      code: 'FILE_TOO_LARGE',
    });
  }

  return new AppError('Invalid upload request', 400, {
    code: 'UPLOAD_ERROR',
  });
};

const handleError = (error, req, res, next) => {
  let err = error;
  err = normalizeJsonBodyError(err);
  err = normalizeUploadError(err);
  err = normalizeSequelizeError(err);

  const statusCode = Number(err.statusCode || 500);
  const operational = Boolean(err.isOperational);
  const requestId = req.requestId || null;

  const payload = {
    success: false,
    message: err.message || 'Unexpected error',
    requestId,
    code: err.code || 'INTERNAL_ERROR',
  };

  if (Array.isArray(err.errors) && err.errors.length > 0) {
    payload.errors = err.errors;
  }

  if (err.details) {
    payload.details = err.details;
  }

  if (!operational && process.env.NODE_ENV !== 'production') {
    payload.stack = err.stack;
  }

  if (!operational || statusCode >= 500) {
    // eslint-disable-next-line no-console
    console.error(
      `[${requestId || 'no-request-id'}] ${req.method} ${req.originalUrl} -> ${statusCode}`,
      {
        code: err.code || 'INTERNAL_ERROR',
        message: err.message || 'Unexpected error',
        details: err.details || null,
      }
    );
  }

  res.status(statusCode).json(payload);
};

module.exports = { handleError };
