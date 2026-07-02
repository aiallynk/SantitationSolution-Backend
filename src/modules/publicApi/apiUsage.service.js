const { Op, fn, col } = require('sequelize');
const { ApiUsageLog, ApiUsageDailySummary, ApiKeyEvent } = require('../../models');
const { logger } = require('../../core/logging/logger');
const { getDayWindow, getMonthWindow, DEFAULT_API_TIMEZONE } = require('./timeWindow');
const { EVENT_TYPES, recordApiKeyEvent } = require('./apiKeyEvents.service');

const roundCoordinate = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Number(parsed.toFixed(3));
};

const extractPublicEndpoint = (req) => {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return path.replace(/^\/api\/public\/v1/i, '') || path || '/';
};

const getRequestIp = (req) => {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || null;
};

const asIntOrNull = (value) => {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const percentile = (values, pct) => {
  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
};

const summarizeDailyUsage = async ({ apiProjectId, apiKeyId, createdAt = new Date() } = {}) => {
  if (!apiProjectId || !apiKeyId) return null;
  const { start, end, dateKey } = getDayWindow(createdAt, DEFAULT_API_TIMEZONE);
  if (!dateKey) return null;

  const where = {
    api_project_id: apiProjectId,
    api_key_id: apiKeyId,
    created_at: { [Op.gte]: start, [Op.lt]: end },
  };

  const logs = await ApiUsageLog.findAll({
    where,
    attributes: ['status_code', 'response_time_ms', 'response_count', 'request_ip'],
    raw: true,
  });

  const totalRequests = logs.length;
  const successfulRequests = logs.filter((row) => Number(row.status_code) >= 200 && Number(row.status_code) < 400).length;
  const rateLimitedRequests = logs.filter((row) => Number(row.status_code) === 429).length;
  const failedRequests = Math.max(0, totalRequests - successfulRequests);
  const responseTimes = logs.map((row) => Number(row.response_time_ms || 0)).filter((value) => Number.isFinite(value));
  const avgResponseTimeMs =
    responseTimes.length > 0
      ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
      : 0;
  const p95ResponseTimeMs = Math.round(percentile(responseTimes, 95));
  const totalToiletsReturned = logs.reduce((sum, row) => sum + Number(row.response_count || 0), 0);
  const uniqueIpsCount = new Set(logs.map((row) => String(row.request_ip || '').trim()).filter(Boolean)).size;

  const [summary] = await ApiUsageDailySummary.findOrCreate({
    where: {
      api_project_id: apiProjectId,
      api_key_id: apiKeyId,
      date: dateKey,
    },
    defaults: {
      total_requests: totalRequests,
      successful_requests: successfulRequests,
      failed_requests: failedRequests,
      rate_limited_requests: rateLimitedRequests,
      avg_response_time_ms: avgResponseTimeMs,
      p95_response_time_ms: p95ResponseTimeMs,
      total_toilets_returned: totalToiletsReturned,
      unique_ips_count: uniqueIpsCount,
    },
  });

  await summary.update({
    total_requests: totalRequests,
    successful_requests: successfulRequests,
    failed_requests: failedRequests,
    rate_limited_requests: rateLimitedRequests,
    avg_response_time_ms: avgResponseTimeMs,
    p95_response_time_ms: p95ResponseTimeMs,
    total_toilets_returned: totalToiletsReturned,
    unique_ips_count: uniqueIpsCount,
    updated_at: new Date(),
  });

  return summary;
};

const maybeRecordQuotaAlert = async ({ apiKey, totalRequests, dateKey } = {}) => {
  const dailyLimit = Number(apiKey?.rate_limit_per_day || 0);
  if (!apiKey?.id || !apiKey?.api_project_id || !Number.isFinite(dailyLimit) || dailyLimit <= 0) {
    return;
  }
  const pct = (Number(totalRequests || 0) / dailyLimit) * 100;
  const threshold = pct >= 100 ? 100 : pct >= 90 ? 90 : pct >= 75 ? 75 : null;
  if (!threshold) return;

  const recentEvents = await ApiKeyEvent.findAll({
    where: {
      api_key_id: apiKey.id,
      event_type: EVENT_TYPES.HIGH_USAGE_DETECTED,
      created_at: { [Op.gte]: new Date(Date.now() - 36 * 3600_000) },
    },
    attributes: ['id', 'metadata'],
    raw: true,
  }).catch(() => []);
  const existing = recentEvents.some((event) => {
    const metadata = event.metadata || {};
    return metadata.quotaType === 'daily' && Number(metadata.threshold) === threshold && metadata.date === dateKey;
  });
  if (existing) return;

  await recordApiKeyEvent({
    apiProjectId: apiKey.api_project_id,
    apiKeyId: apiKey.id,
    eventType: EVENT_TYPES.HIGH_USAGE_DETECTED,
    metadata: {
      quotaType: 'daily',
      threshold,
      usagePercentage: Number(pct.toFixed(2)),
      totalRequests,
      limit: dailyLimit,
      date: dateKey,
      severity: threshold >= 100 ? 'critical' : threshold >= 90 ? 'high' : 'warning',
      message: `External API key reached ${threshold}% of its daily quota.`,
    },
    notify: true,
  });
};

const maybeRecordInvalidKeyAlert = async ({ requestIp } = {}) => {
  if (!requestIp) return;
  const since = new Date(Date.now() - 5 * 60_000);
  const attempts = await ApiUsageLog.count({
    where: {
      request_ip: requestIp,
      error_code: { [Op.in]: ['API_KEY_INVALID', 'API_KEY_MISSING'] },
      created_at: { [Op.gte]: since },
    },
  }).catch(() => 0);
  if (attempts < 5) return;

  const recentEvent = await ApiKeyEvent.findOne({
    where: {
      event_type: EVENT_TYPES.INVALID_KEY_ATTEMPTS_DETECTED,
      request_ip: requestIp,
      created_at: { [Op.gte]: since },
    },
  }).catch(() => null);
  if (recentEvent) return;

  await recordApiKeyEvent({
    eventType: EVENT_TYPES.INVALID_KEY_ATTEMPTS_DETECTED,
    requestIp,
    metadata: {
      attempts,
      windowMinutes: 5,
      severity: 'high',
      message: 'Repeated invalid external API key attempts detected.',
    },
    notify: true,
  });
};

const createUsageLog = async ({ req, res, startedAt = Date.now(), responseBody = null } = {}) => {
  const apiContext = req.publicApi || {};
  const responseTimeMs = Math.max(0, Math.round(Date.now() - startedAt));
  const statusCode = Number(res.statusCode || 500);
  const errorCode = statusCode >= 400 ? responseBody?.code || apiContext.errorCode || null : null;
  const errorMessage = statusCode >= 400 ? responseBody?.message || apiContext.errorMessage || null : null;
  const requestIp = getRequestIp(req);
  const createdAt = new Date();

  const log = await ApiUsageLog.create({
    api_project_id: apiContext.project?.id || apiContext.apiProjectId || null,
    api_key_id: apiContext.key?.id || apiContext.apiKeyId || null,
    endpoint: extractPublicEndpoint(req),
    method: String(req.method || 'GET').toUpperCase(),
    request_ip: requestIp,
    user_agent: String(req.headers?.['user-agent'] || '').slice(0, 500) || null,
    lat_rounded: roundCoordinate(req.query?.lat),
    lng_rounded: roundCoordinate(req.query?.lng),
    radius: asIntOrNull(req.query?.radius),
    response_count: Number(res.locals?.publicResponseCount || 0),
    status_code: statusCode,
    error_code: errorCode,
    error_message: errorMessage ? String(errorMessage).slice(0, 1000) : null,
    response_time_ms: responseTimeMs,
    created_at: createdAt,
  });

  const summary = await summarizeDailyUsage({
    apiProjectId: log.api_project_id,
    apiKeyId: log.api_key_id,
    createdAt,
  });

  if (summary && apiContext.key) {
    await maybeRecordQuotaAlert({
      apiKey: apiContext.key,
      totalRequests: summary.total_requests,
      dateKey: summary.date,
    });
  }

  if (errorCode === 'API_KEY_INVALID' || errorCode === 'API_KEY_MISSING') {
    await maybeRecordInvalidKeyAlert({ requestIp });
  }

  return log;
};

const publicUsageLogger = (req, res, next) => {
  const startedAt = Date.now();
  const originalJson = res.json.bind(res);
  let responseBody = null;

  res.json = (body) => {
    responseBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    createUsageLog({ req, res, startedAt, responseBody }).catch((error) => {
      logger.warn('External API usage logging failed', {
        path: req.originalUrl,
        error: error.message,
      });
    });
  });

  return next();
};

const getUsageCounts = async ({ apiKeyId, now = new Date() } = {}) => {
  if (!apiKeyId) {
    return { minute: 0, day: 0, month: 0 };
  }
  const minuteStart = new Date(now.getTime() - 60_000);
  const dayWindow = getDayWindow(now, DEFAULT_API_TIMEZONE);
  const monthWindow = getMonthWindow(now, DEFAULT_API_TIMEZONE);

  const [minute, day, month] = await Promise.all([
    ApiUsageLog.count({ where: { api_key_id: apiKeyId, created_at: { [Op.gte]: minuteStart } } }),
    ApiUsageLog.count({
      where: {
        api_key_id: apiKeyId,
        created_at: { [Op.gte]: dayWindow.start, [Op.lt]: dayWindow.end },
      },
    }),
    ApiUsageLog.count({
      where: {
        api_key_id: apiKeyId,
        created_at: { [Op.gte]: monthWindow.start, [Op.lt]: monthWindow.end },
      },
    }),
  ]);

  return { minute, day, month };
};

const getUsageOverview = async ({ since = null } = {}) => {
  const where = since ? { created_at: { [Op.gte]: since } } : {};
  const rows = await ApiUsageLog.findAll({
    where,
    attributes: [
      'endpoint',
      'api_project_id',
      [fn('COUNT', col('id')), 'count'],
      [fn('AVG', col('response_time_ms')), 'avg_response_time_ms'],
    ],
    group: ['endpoint', 'api_project_id'],
    raw: true,
  });
  return rows;
};

module.exports = {
  createUsageLog,
  publicUsageLogger,
  getUsageCounts,
  getUsageOverview,
  summarizeDailyUsage,
};
