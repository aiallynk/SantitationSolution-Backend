const crypto = require('crypto');
const { runtimeConfig } = require('../../config/runtime');

const API_KEY_RANDOM_BYTES = 32;
const HASH_ALGORITHM = 'sha256';

const ENV_PREFIX = {
  production: 'san_live_',
  sandbox: 'san_test_',
};

const normalizeKeyEnvironment = (value, fallback = 'sandbox') => {
  const normalized = String(value || fallback).trim().toLowerCase();
  return normalized === 'production' ? 'production' : 'sandbox';
};

const getApiKeySecret = () =>
  String(runtimeConfig.publicApi?.apiKeyHashSecret || runtimeConfig.auth.jwtSecret || '').trim();

const generateRawApiKey = (environment = 'sandbox') => {
  const normalizedEnvironment = normalizeKeyEnvironment(environment);
  const prefix = ENV_PREFIX[normalizedEnvironment] || ENV_PREFIX.sandbox;
  return `${prefix}${crypto.randomBytes(API_KEY_RANDOM_BYTES).toString('base64url')}`;
};

const getKeyPrefix = (rawApiKey) => String(rawApiKey || '').trim().slice(0, 20);

const hashApiKey = (rawApiKey) => {
  const normalized = String(rawApiKey || '').trim();
  const secret = getApiKeySecret();
  if (secret) {
    return crypto.createHmac(HASH_ALGORITHM, secret).update(normalized).digest('hex');
  }
  return crypto.createHash(HASH_ALGORITHM).update(normalized).digest('hex');
};

const safeHashEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

module.exports = {
  generateRawApiKey,
  getKeyPrefix,
  hashApiKey,
  normalizeKeyEnvironment,
  safeHashEqual,
};
