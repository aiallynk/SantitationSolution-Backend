const rateLimit = require('express-rate-limit');

const isIngestionPath = (req) =>
  /^\/api\/v1\/inspections\/[^/]+\/media(?:\/|$)/i.test(String(req.originalUrl || req.path || ''));

const apiRateLimit = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  skip: (req) => isIngestionPath(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many requests, please retry later',
  },
});

const ingestionRateLimit = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.INGEST_RATE_LIMIT_MAX || 5000),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 'INGEST_RATE_LIMIT_EXCEEDED',
    message: 'Upload traffic is high, please retry shortly',
  },
});

module.exports = { apiRateLimit, ingestionRateLimit };
