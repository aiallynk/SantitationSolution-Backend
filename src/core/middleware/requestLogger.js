const shouldLogRequests =
  String(process.env.REQUEST_LOGGING_ENABLED || 'true').toLowerCase() === 'true';
const verboseRequestLogs =
  String(process.env.REQUEST_LOGGING_VERBOSE || 'false').toLowerCase() === 'true';

const requestLogger = (req, res, next) => {
  if (!shouldLogRequests) {
    return next();
  }

  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const status = Number(res.statusCode || 0);
    const isError = status >= 500;
    const isWarn = status >= 400 && status < 500;
    const shouldEmit = verboseRequestLogs || isWarn || isError;
    if (!shouldEmit) {
      return;
    }

    const scope = req.user?.tenantId || 'platform';
    const actor = req.user?.id || 'anonymous';
    const message = `[${req.requestId || 'no-request-id'}] ${req.method} ${req.originalUrl} -> ${status} ${durationMs}ms tenant=${scope} user=${actor}`;

    if (isError) {
      // eslint-disable-next-line no-console
      console.error(message);
      return;
    }
    if (isWarn) {
      // eslint-disable-next-line no-console
      console.warn(message);
      return;
    }
    // eslint-disable-next-line no-console
    console.log(message);
  });

  return next();
};

module.exports = { requestLogger };
