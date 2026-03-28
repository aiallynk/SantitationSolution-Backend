const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_SECRET || 'change-me-access-secret';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'change-me-refresh-secret';
const ACCESS_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '30d';

const buildTokenPayload = (user, options = {}) => ({
  sub: user.id,
  tenantId: options.tenantId ?? user.tenant_id ?? null,
  geographyId: options.geographyId ?? user.geography_id ?? null,
});

const signAccessToken = (user, options = {}) =>
  jwt.sign(buildTokenPayload(user, options), ACCESS_SECRET, {
    expiresIn: ACCESS_EXPIRES_IN,
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
    }
  );

const verifyRefreshToken = (token) => jwt.verify(token, REFRESH_SECRET);

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
