const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
require('./config/env');

const { apiRateLimit } = require('./core/security/rateLimit');
const { attachRequestId } = require('./core/middleware/requestId');
const { requestLogger } = require('./core/middleware/requestLogger');
const { notFound } = require('./core/middleware/notFound');
const { handleError } = require('./core/errors/handleError');
const apiV1Router = require('./api/v1');
const compatRouter = require('./api/compat');

const app = express();

const normalizeOriginValue = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // Browser Origin header never includes trailing slash.
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw.replace(/\/+$/, '');
  }
  return raw;
};

const normalizeOriginToken = (value) =>
  normalizeOriginValue(String(value || '').replace(/^['"]|['"]$/g, ''));

const resolveAllowedOrigins = () => {
  const raw = String(process.env.CORS_ORIGIN || '').trim();
  if (!raw) {
    return null;
  }
  return raw
    .split(/[\n,;]/)
    .map((entry) => normalizeOriginToken(entry))
    .filter(Boolean);
};

const allowedOrigins = resolveAllowedOrigins();

const escapeRegex = (value) =>
  String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const originMatchers = Array.isArray(allowedOrigins)
  ? allowedOrigins.map((entry) => {
      const raw = String(entry || '').trim();
      if (!raw) return null;
      if (raw === '*') {
        return { type: 'any' };
      }
      if (raw.includes('*')) {
        const pattern = `^${raw.split('*').map(escapeRegex).join('.*')}$`;
        return { type: 'regex', value: new RegExp(pattern, 'i') };
      }
      return { type: 'exact', value: raw };
    }).filter(Boolean)
  : [];

const isOriginAllowed = (origin) => {
  const normalizedOrigin = normalizeOriginValue(origin);
  if (!normalizedOrigin || originMatchers.length === 0) return true;
  for (const matcher of originMatchers) {
    if (matcher.type === 'any') return true;
    if (matcher.type === 'exact' && matcher.value === normalizedOrigin) return true;
    if (matcher.type === 'regex' && matcher.value.test(normalizedOrigin)) return true;
  }
  return false;
};

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

app.use(attachRequestId);
app.use(requestLogger);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin(origin, callback) {
      if (!originMatchers.length || !origin) {
        return callback(null, true);
      }
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Requested-With',
      'X-Request-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
    optionsSuccessStatus: 204,
    preflightContinue: false,
    maxAge: 86400,
  })
);
app.use(apiRateLimit);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use(express.urlencoded({ extended: true, limit: process.env.JSON_BODY_LIMIT || '2mb' }));

const uploadsPath = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
}
app.use(
  '/static',
  express.static(uploadsPath, {
    maxAge: '1h',
    etag: true,
    setHeaders: (res) => {
      // Allow admin web app to render locally stored evidence images cross-origin.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Timing-Allow-Origin', '*');
    },
  })
);

const openApiPath = path.join(__dirname, 'docs', 'openapi.json');
if (fs.existsSync(openApiPath)) {
  const spec = JSON.parse(fs.readFileSync(openApiPath, 'utf8'));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec, { explorer: true }));
}

app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Sanitation Platform API is running',
    data: {
      version: 'v1',
      docs: '/docs',
      health: '/health',
    },
    requestId: req.requestId || null,
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'ok',
    data: {
      service: 'sanitation-platform-backend',
      now: new Date().toISOString(),
    },
    requestId: req.requestId || null,
  });
});

app.use('/api/v1', apiV1Router);
app.use('/', compatRouter);

app.use(notFound);
app.use(handleError);

module.exports = app;
