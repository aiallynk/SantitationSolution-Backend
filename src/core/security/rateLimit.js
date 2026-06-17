const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { runtimeConfig } = require('../../config/runtime');

const isIngestionPath = (req) =>
  /^\/api\/v1\/inspections\/[^/]+\/media(?:\/|$)/i.test(String(req.originalUrl || req.path || ''));
const isInfraPath = (req) => {
  const path = String(req.path || req.originalUrl || '').split('?')[0];
  return path === '/health' || path === '/ready' || path === '/';
};

/** Supervisor UI can issue many parallel GETs; count them separately (see supervisorApiRateLimit). */
const isSupervisorApiPath = (req) => {
  const path = String(req.originalUrl || req.url || req.path || '')
    .split('?')[0]
    .toLowerCase();
  return path.includes('/api/v1/supervisor/');
};

const apiRateLimit = rateLimit({
  windowMs: Number(runtimeConfig.security.rateLimitWindowMs || 60_000),
  max: Number(runtimeConfig.security.rateLimitMax || 300),
  skip: (req) => isIngestionPath(req) || isInfraPath(req) || isSupervisorApiPath(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please retry later',
  },
});

/** Applied after JWT `protect` on supervisor routes; keyed by user id so NAT/office IP is not shared. */
const supervisorApiRateLimit = rateLimit({
  windowMs: Number(runtimeConfig.security.rateLimitWindowMs || 60_000),
  max: Number(runtimeConfig.security.supervisorRateLimitMax || 2000),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const userId = req.user?.id || req.user?.userId || null;
    return userId ? `supuid:${userId}` : `supip:${ipKeyGenerator(req.ip || '')}`;
  },
  message: {
    success: false,
    code: 'SUPERVISOR_RATE_LIMIT_EXCEEDED',
    message: 'Too many supervisor requests, please retry shortly',
  },
});

const ingestionRateLimit = rateLimit({
  windowMs: Number(runtimeConfig.security.rateLimitWindowMs || 60_000),
  max: Number(runtimeConfig.security.ingestRateLimitMax || 5000),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'INGEST_RATE_LIMIT_EXCEEDED',
    message: 'Upload traffic is high, please retry shortly',
  },
});

module.exports = { apiRateLimit, ingestionRateLimit, supervisorApiRateLimit };
