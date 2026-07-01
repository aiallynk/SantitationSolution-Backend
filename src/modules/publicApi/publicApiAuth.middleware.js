const net = require('net');
const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const { ApiKey, ApiProject } = require('../../models');
const { getKeyPrefix, hashApiKey, safeHashEqual } = require('./apiKeyCrypto');
const { enforceApiKeyRateLimits } = require('./apiRateLimit.service');
const { EVENT_TYPES, recordApiKeyEvent } = require('./apiKeyEvents.service');

const PUBLIC_ENDPOINTS = Object.freeze({
  nearbyToilets: '/toilets/nearby',
});

const normalizeList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const getRequestIp = (req) => {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || req.ip || req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/, '');
};

const wildcardToRegExp = (value) => {
  const escaped = String(value || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
};

const isOriginAllowed = (origin, allowedOrigins) => {
  const normalizedOrigin = String(origin || '').trim().replace(/\/+$/, '');
  const allowed = normalizeList(allowedOrigins).map((item) => item.replace(/\/+$/, ''));
  if (!normalizedOrigin || allowed.length === 0) return true;
  return allowed.some((item) => item === '*' || wildcardToRegExp(item).test(normalizedOrigin));
};

const ipv4ToNumber = (ip) => {
  if (net.isIP(ip) !== 4) return null;
  return ip.split('.').reduce((sum, part) => (sum << 8) + Number(part), 0) >>> 0;
};

const isIpv4InCidr = (ip, cidr) => {
  const [range, bitsRaw] = String(cidr || '').split('/');
  const bits = Number(bitsRaw);
  const ipNum = ipv4ToNumber(ip);
  const rangeNum = ipv4ToNumber(range);
  if (ipNum === null || rangeNum === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
};

const isIpAllowed = (ip, allowedIps) => {
  const normalizedIp = String(ip || '').trim().replace(/^::ffff:/, '');
  const allowed = normalizeList(allowedIps);
  if (!normalizedIp || allowed.length === 0) return true;
  return allowed.some((item) => item === normalizedIp || (item.includes('/') && isIpv4InCidr(normalizedIp, item)));
};

const getPublicEndpoint = (req) => {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path.replace(/^\/api\/public\/v1/i, '') || path || '/';
};

const endpointAllowed = (endpoint, allowedEndpoints) => {
  const allowed = normalizeList(allowedEndpoints);
  if (allowed.length === 0) return false;
  const variants = [
    endpoint,
    `/api/public/v1${endpoint}`,
  ];
  return allowed.some((item) => item === '*' || variants.includes(item) || wildcardToRegExp(item).test(endpoint));
};

const markPublicError = (req, error) => {
  req.publicApi = {
    ...(req.publicApi || {}),
    errorCode: error.code,
    errorMessage: error.message,
  };
  return error;
};

const findApiKeyByRawValue = async (rawApiKey) => {
  const keyPrefix = getKeyPrefix(rawApiKey);
  if (!keyPrefix) return null;
  const candidates = await ApiKey.findAll({
    where: {
      key_prefix: {
        [Op.like]: `${keyPrefix.slice(0, 12)}%`,
      },
    },
    include: [{ model: ApiProject, as: 'project', required: false }],
    limit: 10,
  });
  const requestedHash = hashApiKey(rawApiKey);
  return candidates.find((candidate) => safeHashEqual(candidate.api_key_hash, requestedHash)) || null;
};

const rejectApiKeyStatus = async ({ req, apiKey, code, message }) => {
  const eventType =
    code === 'API_KEY_REVOKED'
      ? EVENT_TYPES.REVOKED_KEY_USED
      : code === 'API_KEY_EXPIRED'
        ? EVENT_TYPES.EXPIRED_KEY_USED
        : null;
  if (eventType) {
    await recordApiKeyEvent({
      apiProjectId: apiKey.api_project_id,
      apiKeyId: apiKey.id,
      eventType,
      requestIp: getRequestIp(req),
      userAgent: String(req.headers?.['user-agent'] || '').slice(0, 500) || null,
      metadata: {
        severity: 'high',
        message,
      },
      notify: true,
    });
  }
  throw markPublicError(req, new AppError(message, 403, { code }));
};

const authenticatePublicApiKey = async (req, res, next) => {
  try {
    const rawApiKey = String(req.headers['x-api-key'] || '').trim();
    if (!rawApiKey) {
      throw markPublicError(req, new AppError('API key is required', 401, { code: 'API_KEY_MISSING' }));
    }

    const apiKey = await findApiKeyByRawValue(rawApiKey);
    if (!apiKey) {
      throw markPublicError(req, new AppError('Invalid API key', 401, { code: 'API_KEY_INVALID' }));
    }

    const project = apiKey.project || apiKey.ApiProject || null;
    req.publicApi = {
      key: apiKey,
      project,
      apiKeyId: apiKey.id,
      apiProjectId: apiKey.api_project_id,
    };

    if (!project || project.status !== 'active') {
      throw markPublicError(
        req,
        new AppError('API project is not active', 403, {
          code: project?.status === 'suspended' ? 'API_PROJECT_SUSPENDED' : 'API_PROJECT_INACTIVE',
        })
      );
    }

    if (apiKey.status === 'revoked') {
      await rejectApiKeyStatus({
        req,
        apiKey,
        code: 'API_KEY_REVOKED',
        message: 'API key has been revoked',
      });
    }
    if (apiKey.status === 'inactive') {
      throw markPublicError(req, new AppError('API key is inactive', 403, { code: 'API_KEY_INACTIVE' }));
    }
    if (apiKey.status === 'expired') {
      await rejectApiKeyStatus({
        req,
        apiKey,
        code: 'API_KEY_EXPIRED',
        message: 'API key has expired',
      });
    }
    if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() <= Date.now()) {
      await apiKey.update({ status: 'expired', updated_at: new Date() });
      await recordApiKeyEvent({
        apiProjectId: apiKey.api_project_id,
        apiKeyId: apiKey.id,
        eventType: EVENT_TYPES.KEY_EXPIRED,
        metadata: { expiresAt: apiKey.expires_at },
      });
      await rejectApiKeyStatus({
        req,
        apiKey,
        code: 'API_KEY_EXPIRED',
        message: 'API key has expired',
      });
    }
    if (apiKey.status !== 'active') {
      throw markPublicError(req, new AppError('API key is not active', 403, { code: 'API_KEY_INACTIVE' }));
    }

    const endpoint = getPublicEndpoint(req);
    if (!endpointAllowed(endpoint, apiKey.allowed_endpoints)) {
      throw markPublicError(req, new AppError('API key is not allowed to call this endpoint', 403, { code: 'ENDPOINT_NOT_ALLOWED' }));
    }
    if (!isOriginAllowed(req.headers.origin, apiKey.allowed_origins)) {
      throw markPublicError(req, new AppError('Request origin is not allowed for this API key', 403, { code: 'ORIGIN_NOT_ALLOWED' }));
    }
    if (!isIpAllowed(getRequestIp(req), apiKey.allowed_ips)) {
      throw markPublicError(req, new AppError('Request IP is not allowed for this API key', 403, { code: 'IP_NOT_ALLOWED' }));
    }

    await enforceApiKeyRateLimits({ apiKey });

    const now = new Date();
    if (!apiKey.last_used_at) {
      await recordApiKeyEvent({
        apiProjectId: apiKey.api_project_id,
        apiKeyId: apiKey.id,
        eventType: EVENT_TYPES.KEY_USED_FIRST_TIME,
        requestIp: getRequestIp(req),
        userAgent: String(req.headers?.['user-agent'] || '').slice(0, 500) || null,
      });
    }
    await apiKey.update({ last_used_at: now, updated_at: now });

    return next();
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  PUBLIC_ENDPOINTS,
  authenticatePublicApiKey,
  endpointAllowed,
  isIpAllowed,
  isOriginAllowed,
  normalizeList,
};
