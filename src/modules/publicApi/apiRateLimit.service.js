const IORedis = require('ioredis');
const AppError = require('../../core/errors/AppError');
const { runtimeConfig } = require('../../config/runtime');
const { logger } = require('../../core/logging/logger');
const { toTimezoneDateKey } = require('../../utils/timezone');
const { getUsageCounts } = require('./apiUsage.service');
const { DEFAULT_API_TIMEZONE } = require('./timeWindow');
const { EVENT_TYPES, recordApiKeyEvent } = require('./apiKeyEvents.service');

let redisClient = null;
let redisDisabled = false;

const getRedisClient = () => {
  if (redisDisabled || !runtimeConfig.redis?.enabled || !runtimeConfig.redis?.url) {
    return null;
  }
  if (!redisClient) {
    redisClient = new IORedis(runtimeConfig.redis.url, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 100, 1000),
    });
    redisClient.on('error', (error) => {
      if (!redisDisabled) {
        redisDisabled = true;
        logger.warn('External API Redis rate limiting unavailable; falling back to DB counters', {
          error: error.message,
        });
      }
    });
  }
  return redisClient;
};

const getPositiveLimit = (value) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const throwRateLimited = async ({ apiKey, limitType, limit, current }) => {
  await recordApiKeyEvent({
    apiProjectId: apiKey.api_project_id,
    apiKeyId: apiKey.id,
    eventType: EVENT_TYPES.RATE_LIMIT_EXCEEDED,
    metadata: {
      limitType,
      limit,
      current,
      severity: limitType === 'minute' ? 'warning' : 'high',
      message: `External API key exceeded its ${limitType} limit.`,
    },
    notify: limitType !== 'minute',
  });
  throw new AppError('API rate limit exceeded', 429, {
    code: 'API_RATE_LIMIT_EXCEEDED',
    details: {
      limitType,
      limit,
    },
  });
};

const checkRedisLimit = async ({ key, limit, ttlSeconds }) => {
  const client = getRedisClient();
  if (!client || !limit) return null;
  const current = await client.incr(key);
  if (current === 1) {
    await client.expire(key, ttlSeconds);
  }
  return current;
};

const checkRedisRateLimits = async ({ apiKey, now = new Date() }) => {
  const minuteLimit = getPositiveLimit(apiKey.rate_limit_per_minute);
  const dayLimit = getPositiveLimit(apiKey.rate_limit_per_day);
  const monthLimit = getPositiveLimit(apiKey.monthly_quota);
  if (!minuteLimit && !dayLimit && !monthLimit) return false;
  if (!getRedisClient()) return false;

  const minuteBucket = Math.floor(now.getTime() / 60_000);
  const dayBucket = toTimezoneDateKey(now, DEFAULT_API_TIMEZONE) || now.toISOString().slice(0, 10);
  const monthBucket = dayBucket.slice(0, 7);
  const base = `san:public-api:${apiKey.id}`;

  try {
    const [minuteCount, dayCount, monthCount] = await Promise.all([
      checkRedisLimit({ key: `${base}:m:${minuteBucket}`, limit: minuteLimit, ttlSeconds: 90 }),
      checkRedisLimit({ key: `${base}:d:${dayBucket}`, limit: dayLimit, ttlSeconds: 2 * 24 * 3600 }),
      checkRedisLimit({ key: `${base}:mo:${monthBucket}`, limit: monthLimit, ttlSeconds: 40 * 24 * 3600 }),
    ]);

    if (minuteLimit && minuteCount > minuteLimit) {
      await throwRateLimited({ apiKey, limitType: 'minute', limit: minuteLimit, current: minuteCount });
    }
    if (dayLimit && dayCount > dayLimit) {
      await throwRateLimited({ apiKey, limitType: 'day', limit: dayLimit, current: dayCount });
    }
    if (monthLimit && monthCount > monthLimit) {
      await throwRateLimited({ apiKey, limitType: 'month', limit: monthLimit, current: monthCount });
    }
    return true;
  } catch (error) {
    if (error instanceof AppError) throw error;
    redisDisabled = true;
    logger.warn('External API Redis rate limit check failed; using DB counters', {
      apiKeyId: apiKey.id,
      error: error.message,
    });
    return false;
  }
};

const checkDbRateLimits = async ({ apiKey, now = new Date() }) => {
  const minuteLimit = getPositiveLimit(apiKey.rate_limit_per_minute);
  const dayLimit = getPositiveLimit(apiKey.rate_limit_per_day);
  const monthLimit = getPositiveLimit(apiKey.monthly_quota);
  if (!minuteLimit && !dayLimit && !monthLimit) return;

  const counts = await getUsageCounts({ apiKeyId: apiKey.id, now });
  if (minuteLimit && counts.minute >= minuteLimit) {
    await throwRateLimited({ apiKey, limitType: 'minute', limit: minuteLimit, current: counts.minute + 1 });
  }
  if (dayLimit && counts.day >= dayLimit) {
    await throwRateLimited({ apiKey, limitType: 'day', limit: dayLimit, current: counts.day + 1 });
  }
  if (monthLimit && counts.month >= monthLimit) {
    await throwRateLimited({ apiKey, limitType: 'month', limit: monthLimit, current: counts.month + 1 });
  }
};

const enforceApiKeyRateLimits = async ({ apiKey, now = new Date() }) => {
  const redisApplied = await checkRedisRateLimits({ apiKey, now });
  if (!redisApplied) {
    await checkDbRateLimits({ apiKey, now });
  }
};

module.exports = {
  enforceApiKeyRateLimits,
};
