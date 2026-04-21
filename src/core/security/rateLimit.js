const rateLimit = require('express-rate-limit');
const { runtimeConfig } = require('../../config/runtime');

const isIngestionPath = (req) =>
  /^\/api\/v1\/inspections\/[^/]+\/media(?:\/|$)/i.test(String(req.originalUrl || req.path || ''));
const isInfraPath = (req) => {
  const path = String(req.path || req.originalUrl || '').split('?')[0];
  return path === '/health' || path === '/ready' || path === '/';
};

const apiRateLimit = rateLimit({
  windowMs: Number(runtimeConfig.security.rateLimitWindowMs || 60_000),
  max: Number(runtimeConfig.security.rateLimitMax || 300),
  skip: (req) => isIngestionPath(req) || isInfraPath(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please retry later',
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

module.exports = { apiRateLimit, ingestionRateLimit };
