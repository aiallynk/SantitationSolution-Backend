const { logger } = require('../logging/logger');
const { runtimeConfig } = require('../../config/runtime');

const shouldLogRequests = Boolean(runtimeConfig.logging.requestLoggingEnabled);
const verboseRequestLogs = Boolean(runtimeConfig.logging.requestLoggingVerbose);
const slowRequestThresholdMs = Math.max(
  Number(runtimeConfig.logging.requestLoggingSlowMs || 1200),
  100
);

const getSanitizedPath = (req) => {
  const routePath = req?.route?.path;
  if (typeof routePath === 'string' && routePath.trim()) {
    return routePath;
  }
  return String(req.path || req.originalUrl || '/').split('?')[0];
};

const requestLogger = (req, res, next) => {
  if (!shouldLogRequests) {
    return next();
  }

  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const status = Number(res.statusCode || 0);
    const isWarn = status >= 400 && status < 500;
    const isSlow = durationMs >= slowRequestThresholdMs;
    const shouldEmit = verboseRequestLogs || isWarn || isSlow;
    if (!shouldEmit) {
      return;
    }

    const meta = {
      requestId: req.requestId || null,
      method: req.method,
      path: getSanitizedPath(req),
      status,
      durationMs,
      tenantId: req.user?.tenantId || null,
      userId: req.user?.id || null,
      ip: req.ip || null,
      userAgent: req.headers?.['user-agent']
        ? String(req.headers['user-agent']).slice(0, 200)
        : null,
    };

    if (isWarn) {
      logger.warn('Request warning', meta);
      return;
    }
    logger.info(isSlow ? 'Slow request' : 'Request completed', meta);
  });

  return next();
};

module.exports = { requestLogger };
