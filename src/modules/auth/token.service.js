const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { runtimeConfig } = require('../../config/runtime');

const ACCESS_SECRET = runtimeConfig.auth.jwtSecret || 'change-me-access-secret';
const REFRESH_SECRET = runtimeConfig.auth.jwtRefreshSecret || 'change-me-refresh-secret';
const ACCESS_EXPIRES_IN = runtimeConfig.auth.accessTokenTtl;
const REFRESH_EXPIRES_IN = runtimeConfig.auth.refreshTokenTtl;
const JWT_ALGORITHM = runtimeConfig.auth.jwtAlgorithm;

const buildTokenPayload = (user, options = {}) => ({
  sub: user.id,
  tenantId: options.tenantId ?? user.tenant_id ?? null,
  geographyId: options.geographyId ?? user.geography_id ?? null,
  ...(options.sessionMode ? { sessionMode: options.sessionMode } : {}),
});

const signAccessToken = (user, options = {}) =>
  jwt.sign(buildTokenPayload(user, options), ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRES_IN,
    algorithm: JWT_ALGORITHM,
  });

const signRefreshToken = (user, sessionId, options = {}) =>
  jwt.sign(
    {
      ...buildTokenPayload(user, options),
      sid: sessionId,
      typ: 'refresh',
    },
    REFRESH_SECRET,
    {
      expiresIn: REFRESH_EXPIRES_IN,
      algorithm: JWT_ALGORITHM,
    }
  );

const verifyRefreshToken = (token) =>
  jwt.verify(token, REFRESH_SECRET, { algorithms: [JWT_ALGORITHM] });

const hashToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const decodeTokenExpiry = (token) => {
  const decoded = jwt.decode(token);
  if (!decoded?.exp) {
    return null;
  }
  return new Date(decoded.exp * 1000);
};

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  decodeTokenExpiry,
};
