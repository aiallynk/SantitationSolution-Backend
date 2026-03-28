const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const swaggerUi = require('swagger-ui-express');
require('./config/env');

const { apiRateLimit } = require('./core/security/rateLimit');
const { attachRequestId } = require('./core/middleware/requestId');
const { notFound } = require('./core/middleware/notFound');
const { handleError } = require('./core/errors/handleError');
const apiV1Router = require('./api/v1');
const compatRouter = require('./api/compat');

const app = express();

const resolveAllowedOrigins = () => {
  const raw = String(process.env.CORS_ORIGIN || '').trim();
  if (!raw) {
    return null;
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const allowedOrigins = resolveAllowedOrigins();

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1));

app.use(attachRequestId);
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(
  cors({
    origin(origin, callback) {
      if (!allowedOrigins || allowedOrigins.length === 0 || !origin) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
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
