const { Op, fn, col } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  ApiProject,
  ApiKey,
  ApiUsageLog,
  ApiUsageDailySummary,
  ApiKeyEvent,
  Tenant,
} = require('../../models');
const { sanitizeText, normalizePagination, isUuid } = require('../../utils/validators');
const { toTimezoneDateKey } = require('../../utils/timezone');
const {
  generateRawApiKey,
  getKeyPrefix,
  hashApiKey,
  normalizeKeyEnvironment,
} = require('../publicApi/apiKeyCrypto');
const { EVENT_TYPES, recordApiKeyEvent } = require('../publicApi/apiKeyEvents.service');
const { getDayWindow, getMonthWindow, DEFAULT_API_TIMEZONE } = require('../publicApi/timeWindow');

const DEFAULT_ALLOWED_ENDPOINTS = ['/toilets/nearby'];
const DEFAULT_PERMISSIONS = ['toilets:nearby:read'];

const ensureSuperAdmin = (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can access API access management', 403, {
      code: 'SUPER_ADMIN_ONLY',
    });
  }
};

const normalizeStringList = (value, { uuidOnly = false } = {}) => {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const normalized = [
    ...new Set(
      raw
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    ),
  ];
  if (uuidOnly) {
    normalized.forEach((item) => {
      if (!isUuid(item)) {
        throw new AppError('allowedTenantIds must contain valid tenant ids', 400, {
          code: 'INVALID_TENANT_SCOPE',
        });
      }
    });
  }
  return normalized;
};

const normalizePositiveInt = (value, fallback, { min = 1, max = 10_000_000 } = {}) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(`Limit must be an integer between ${min} and ${max}`, 400, {
      code: 'INVALID_LIMIT',
    });
  }
  return parsed;
};

const parseOptionalDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('expiresAt must be a valid date', 400, { code: 'INVALID_EXPIRY' });
  }
  return parsed;
};

const normalizeProjectStatus = (value, fallback = 'active') => {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!['active', 'inactive', 'suspended'].includes(normalized)) {
    throw new AppError('status must be active, inactive, or suspended', 400, {
      code: 'INVALID_PROJECT_STATUS',
    });
  }
  return normalized;
};

const normalizeKeyStatus = (value, fallback = 'active') => {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!['active', 'inactive', 'revoked', 'expired'].includes(normalized)) {
    throw new AppError('status must be active, inactive, revoked, or expired', 400, {
      code: 'INVALID_KEY_STATUS',
    });
  }
  return normalized;
};

const mapProject = (row, keyCount = undefined) => ({
  id: row.id,
  projectName: row.project_name,
  description: row.description || null,
  clientName: row.client_name || null,
  usageBy: row.usage_by || null,
  projectOwnerName: row.project_owner_name || null,
  projectOwnerEmail: row.project_owner_email || null,
  projectOwnerMobile: row.project_owner_mobile || null,
  environment: row.environment,
  status: row.status,
  allowedTenantIds: Array.isArray(row.allowed_tenant_ids) ? row.allowed_tenant_ids : [],
  createdBySuperAdminId: row.created_by_super_admin_id || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  keyCount,
});

const mapKey = (row, { rawApiKey = null, usage = null } = {}) => ({
  id: row.id,
  apiProjectId: row.api_project_id,
  keyName: row.key_name,
  keyPrefix: row.key_prefix,
  environment: row.environment,
  status: row.status,
  permissions: Array.isArray(row.permissions) ? row.permissions : [],
  allowedEndpoints: Array.isArray(row.allowed_endpoints) ? row.allowed_endpoints : [],
  allowedTenantIds: Array.isArray(row.allowed_tenant_ids) ? row.allowed_tenant_ids : [],
  allowedOrigins: Array.isArray(row.allowed_origins) ? row.allowed_origins : [],
  allowedIps: Array.isArray(row.allowed_ips) ? row.allowed_ips : [],
  rateLimitPerMinute: row.rate_limit_per_minute,
  rateLimitPerDay: row.rate_limit_per_day,
  monthlyQuota: row.monthly_quota,
  expiresAt: row.expires_at,
  lastUsedAt: row.last_used_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revokedAt: row.revoked_at,
  revokedBy: row.revoked_by,
  revokeReason: row.revoke_reason,
  usage,
  ...(rawApiKey ? { apiKey: rawApiKey, rawApiKey } : {}),
});

const loadProject = async (projectId) => {
  const project = await ApiProject.findByPk(projectId);
  if (!project) {
    throw new AppError('API project not found', 404, { code: 'API_PROJECT_NOT_FOUND' });
  }
  return project;
};

const loadKey = async (keyId) => {
  const apiKey = await ApiKey.findByPk(keyId);
  if (!apiKey) {
    throw new AppError('API key not found', 404, { code: 'API_KEY_NOT_FOUND' });
  }
  return apiKey;
};

const listProjects = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 25, maxLimit: 200 });
  const where = {};
  if (req.query.status) where.status = normalizeProjectStatus(req.query.status);
  if (req.query.environment) where.environment = normalizeKeyEnvironment(req.query.environment);
  if (req.query.search) {
    const search = `%${String(req.query.search).trim()}%`;
    where[Op.or] = [
      { project_name: { [Op.iLike]: search } },
      { client_name: { [Op.iLike]: search } },
      { usage_by: { [Op.iLike]: search } },
      { project_owner_email: { [Op.iLike]: search } },
    ];
  }

  const { rows, count } = await ApiProject.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  const keyCounts = rows.length > 0
    ? await ApiKey.findAll({
        attributes: ['api_project_id', [fn('COUNT', col('id')), 'count']],
        where: { api_project_id: { [Op.in]: rows.map((row) => row.id) } },
        group: ['api_project_id'],
        raw: true,
      })
    : [];
  const keyCountMap = new Map(keyCounts.map((row) => [row.api_project_id, Number(row.count || 0)]));
  return {
    items: rows.map((row) => mapProject(row, keyCountMap.get(row.id) || 0)),
    meta: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
};

const createProject = async (req) => {
  ensureSuperAdmin(req);
  const projectName = sanitizeText(req.body.projectName || req.body.project_name, 220);
  if (!projectName) {
    throw new AppError('projectName is required', 400, { code: 'PROJECT_NAME_REQUIRED' });
  }
  const project = await ApiProject.create({
    project_name: projectName,
    description: sanitizeText(req.body.description, 1000) || null,
    client_name: sanitizeText(req.body.clientName || req.body.client_name, 220) || null,
    usage_by: sanitizeText(req.body.usageBy || req.body.usage_by, 220) || null,
    project_owner_name: sanitizeText(req.body.projectOwnerName || req.body.project_owner_name, 180) || null,
    project_owner_email: sanitizeText(req.body.projectOwnerEmail || req.body.project_owner_email, 180) || null,
    project_owner_mobile: sanitizeText(req.body.projectOwnerMobile || req.body.project_owner_mobile, 32) || null,
    environment: normalizeKeyEnvironment(req.body.environment, 'sandbox'),
    status: normalizeProjectStatus(req.body.status, 'active'),
    allowed_tenant_ids: normalizeStringList(req.body.allowedTenantIds || req.body.allowed_tenant_ids, {
      uuidOnly: true,
    }),
    created_by_super_admin_id: req.user.id,
  });
  return mapProject(project, 0);
};

const getProjectById = async (req) => {
  ensureSuperAdmin(req);
  const project = await loadProject(req.params.projectId);
  const keyCount = await ApiKey.count({ where: { api_project_id: project.id } });
  return mapProject(project, keyCount);
};

const updateProject = async (req) => {
  ensureSuperAdmin(req);
  const project = await loadProject(req.params.projectId);
  const updates = {};
  if (req.body.projectName !== undefined || req.body.project_name !== undefined) {
    const value = sanitizeText(req.body.projectName || req.body.project_name, 220);
    if (!value) throw new AppError('projectName cannot be blank', 400, { code: 'PROJECT_NAME_REQUIRED' });
    updates.project_name = value;
  }
  if (req.body.description !== undefined) updates.description = sanitizeText(req.body.description, 1000) || null;
  if (req.body.clientName !== undefined || req.body.client_name !== undefined) {
    updates.client_name = sanitizeText(req.body.clientName || req.body.client_name, 220) || null;
  }
  if (req.body.usageBy !== undefined || req.body.usage_by !== undefined) {
    updates.usage_by = sanitizeText(req.body.usageBy || req.body.usage_by, 220) || null;
  }
  if (req.body.projectOwnerName !== undefined || req.body.project_owner_name !== undefined) {
    updates.project_owner_name = sanitizeText(req.body.projectOwnerName || req.body.project_owner_name, 180) || null;
  }
  if (req.body.projectOwnerEmail !== undefined || req.body.project_owner_email !== undefined) {
    updates.project_owner_email = sanitizeText(req.body.projectOwnerEmail || req.body.project_owner_email, 180) || null;
  }
  if (req.body.projectOwnerMobile !== undefined || req.body.project_owner_mobile !== undefined) {
    updates.project_owner_mobile = sanitizeText(req.body.projectOwnerMobile || req.body.project_owner_mobile, 32) || null;
  }
  if (req.body.environment !== undefined) updates.environment = normalizeKeyEnvironment(req.body.environment);
  if (req.body.status !== undefined) updates.status = normalizeProjectStatus(req.body.status);
  if (req.body.allowedTenantIds !== undefined || req.body.allowed_tenant_ids !== undefined) {
    updates.allowed_tenant_ids = normalizeStringList(req.body.allowedTenantIds || req.body.allowed_tenant_ids, {
      uuidOnly: true,
    });
  }
  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date();
    await project.update(updates);
  }
  return mapProject(project);
};

const buildRawKeyRecord = ({ project, body, userId }) => {
  const environment = normalizeKeyEnvironment(body.environment, project.environment || 'sandbox');
  const rawApiKey = generateRawApiKey(environment);
  const allowedTenantIds =
    body.allowedTenantIds !== undefined || body.allowed_tenant_ids !== undefined
      ? normalizeStringList(body.allowedTenantIds || body.allowed_tenant_ids, { uuidOnly: true })
      : Array.isArray(project.allowed_tenant_ids)
        ? project.allowed_tenant_ids
        : [];
  return {
    rawApiKey,
    record: {
      api_project_id: project.id,
      key_name: sanitizeText(body.keyName || body.key_name || 'Default key', 180),
      key_prefix: getKeyPrefix(rawApiKey),
      api_key_hash: hashApiKey(rawApiKey),
      environment,
      status: normalizeKeyStatus(body.status, 'active'),
      permissions: normalizeStringList(body.permissions).length > 0
        ? normalizeStringList(body.permissions)
        : DEFAULT_PERMISSIONS,
      allowed_endpoints: normalizeStringList(body.allowedEndpoints || body.allowed_endpoints).length > 0
        ? normalizeStringList(body.allowedEndpoints || body.allowed_endpoints)
        : DEFAULT_ALLOWED_ENDPOINTS,
      allowed_tenant_ids: allowedTenantIds,
      allowed_origins: normalizeStringList(body.allowedOrigins || body.allowed_origins),
      allowed_ips: normalizeStringList(body.allowedIps || body.allowed_ips),
      rate_limit_per_minute: normalizePositiveInt(body.rateLimitPerMinute || body.rate_limit_per_minute, 60, { max: 100_000 }),
      rate_limit_per_day: normalizePositiveInt(body.rateLimitPerDay || body.rate_limit_per_day, 1000, { max: 10_000_000 }),
      monthly_quota: normalizePositiveInt(body.monthlyQuota || body.monthly_quota, 30_000, { max: 100_000_000 }),
      expires_at: parseOptionalDate(body.expiresAt || body.expires_at),
      created_by: userId,
    },
  };
};

const createKey = async (req) => {
  ensureSuperAdmin(req);
  const project = await loadProject(req.params.projectId);
  const { rawApiKey, record } = buildRawKeyRecord({ project, body: req.body || {}, userId: req.user.id });
  const apiKey = await ApiKey.create(record);
  await recordApiKeyEvent({
    apiProjectId: project.id,
    apiKeyId: apiKey.id,
    eventType: EVENT_TYPES.KEY_CREATED,
    actorUserId: req.user.id,
    metadata: {
      keyName: apiKey.key_name,
      keyPrefix: apiKey.key_prefix,
      environment: apiKey.environment,
    },
  });
  return mapKey(apiKey, { rawApiKey });
};

const listKeys = async (req) => {
  ensureSuperAdmin(req);
  const project = await loadProject(req.params.projectId);
  const keys = await ApiKey.findAll({
    where: { api_project_id: project.id },
    order: [['created_at', 'DESC']],
  });
  const today = getDayWindow(new Date());
  const month = getMonthWindow(new Date());
  const usageRows = await Promise.all(
    keys.map(async (key) => {
      const [todayCount, monthCount] = await Promise.all([
        ApiUsageLog.count({
          where: {
            api_key_id: key.id,
            created_at: { [Op.gte]: today.start, [Op.lt]: today.end },
          },
        }),
        ApiUsageLog.count({
          where: {
            api_key_id: key.id,
            created_at: { [Op.gte]: month.start, [Op.lt]: month.end },
          },
        }),
      ]);
      return [key.id, { todayCount, monthCount }];
    })
  );
  const usageMap = new Map(usageRows);
  return keys.map((key) => mapKey(key, { usage: usageMap.get(key.id) || null }));
};

const updateKey = async (req) => {
  ensureSuperAdmin(req);
  const apiKey = await loadKey(req.params.keyId);
  const updates = {};
  const limitChanged =
    req.body.rateLimitPerMinute !== undefined ||
    req.body.rate_limit_per_minute !== undefined ||
    req.body.rateLimitPerDay !== undefined ||
    req.body.rate_limit_per_day !== undefined ||
    req.body.monthlyQuota !== undefined ||
    req.body.monthly_quota !== undefined;
  const scopeChanged =
    req.body.permissions !== undefined ||
    req.body.allowedEndpoints !== undefined ||
    req.body.allowed_endpoints !== undefined ||
    req.body.allowedTenantIds !== undefined ||
    req.body.allowed_tenant_ids !== undefined ||
    req.body.allowedOrigins !== undefined ||
    req.body.allowed_origins !== undefined ||
    req.body.allowedIps !== undefined ||
    req.body.allowed_ips !== undefined;

  if (req.body.keyName !== undefined || req.body.key_name !== undefined) {
    updates.key_name = sanitizeText(req.body.keyName || req.body.key_name, 180);
  }
  if (req.body.status !== undefined) updates.status = normalizeKeyStatus(req.body.status);
  if (req.body.permissions !== undefined) updates.permissions = normalizeStringList(req.body.permissions);
  if (req.body.allowedEndpoints !== undefined || req.body.allowed_endpoints !== undefined) {
    updates.allowed_endpoints = normalizeStringList(req.body.allowedEndpoints || req.body.allowed_endpoints);
  }
  if (req.body.allowedTenantIds !== undefined || req.body.allowed_tenant_ids !== undefined) {
    updates.allowed_tenant_ids = normalizeStringList(req.body.allowedTenantIds || req.body.allowed_tenant_ids, {
      uuidOnly: true,
    });
  }
  if (req.body.allowedOrigins !== undefined || req.body.allowed_origins !== undefined) {
    updates.allowed_origins = normalizeStringList(req.body.allowedOrigins || req.body.allowed_origins);
  }
  if (req.body.allowedIps !== undefined || req.body.allowed_ips !== undefined) {
    updates.allowed_ips = normalizeStringList(req.body.allowedIps || req.body.allowed_ips);
  }
  if (req.body.rateLimitPerMinute !== undefined || req.body.rate_limit_per_minute !== undefined) {
    updates.rate_limit_per_minute = normalizePositiveInt(req.body.rateLimitPerMinute || req.body.rate_limit_per_minute, 60, { max: 100_000 });
  }
  if (req.body.rateLimitPerDay !== undefined || req.body.rate_limit_per_day !== undefined) {
    updates.rate_limit_per_day = normalizePositiveInt(req.body.rateLimitPerDay || req.body.rate_limit_per_day, 1000, { max: 10_000_000 });
  }
  if (req.body.monthlyQuota !== undefined || req.body.monthly_quota !== undefined) {
    updates.monthly_quota = normalizePositiveInt(req.body.monthlyQuota || req.body.monthly_quota, 30_000, { max: 100_000_000 });
  }
  if (req.body.expiresAt !== undefined || req.body.expires_at !== undefined) {
    updates.expires_at = parseOptionalDate(req.body.expiresAt || req.body.expires_at);
  }
  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date();
    await apiKey.update(updates);
  }

  if (limitChanged) {
    await recordApiKeyEvent({
      apiProjectId: apiKey.api_project_id,
      apiKeyId: apiKey.id,
      eventType: EVENT_TYPES.KEY_LIMIT_UPDATED,
      actorUserId: req.user.id,
      metadata: updates,
    });
  }
  if (scopeChanged) {
    await recordApiKeyEvent({
      apiProjectId: apiKey.api_project_id,
      apiKeyId: apiKey.id,
      eventType: EVENT_TYPES.KEY_SCOPE_UPDATED,
      actorUserId: req.user.id,
      metadata: updates,
    });
  }

  return mapKey(apiKey);
};

const revokeKey = async (req) => {
  ensureSuperAdmin(req);
  const apiKey = await loadKey(req.params.keyId);
  const reason = sanitizeText(req.body.reason || req.body.revokeReason, 500) || 'Revoked by Super Admin';
  await apiKey.update({
    status: 'revoked',
    revoked_at: new Date(),
    revoked_by: req.user.id,
    revoke_reason: reason,
    updated_at: new Date(),
  });
  await recordApiKeyEvent({
    apiProjectId: apiKey.api_project_id,
    apiKeyId: apiKey.id,
    eventType: EVENT_TYPES.KEY_REVOKED,
    actorUserId: req.user.id,
    metadata: { reason },
  });
  return mapKey(apiKey);
};

const regenerateKey = async (req) => {
  ensureSuperAdmin(req);
  const apiKey = await loadKey(req.params.keyId);
  const rawApiKey = generateRawApiKey(apiKey.environment);
  await apiKey.update({
    key_prefix: getKeyPrefix(rawApiKey),
    api_key_hash: hashApiKey(rawApiKey),
    status: 'active',
    last_used_at: null,
    revoked_at: null,
    revoked_by: null,
    revoke_reason: null,
    updated_at: new Date(),
  });
  await recordApiKeyEvent({
    apiProjectId: apiKey.api_project_id,
    apiKeyId: apiKey.id,
    eventType: EVENT_TYPES.KEY_REGENERATED,
    actorUserId: req.user.id,
    metadata: {
      keyPrefix: apiKey.key_prefix,
    },
  });
  return mapKey(apiKey, { rawApiKey });
};

const getOverview = async (req) => {
  ensureSuperAdmin(req);
  const now = new Date();
  const day = getDayWindow(now);
  const month = getMonthWindow(now);
  const [
    totalApiProjects,
    activeApiKeys,
    callsToday,
    callsThisMonth,
    failedCalls,
    rateLimitedCalls,
    avgResponseRows,
    endpointRows,
    projectRows,
  ] = await Promise.all([
    ApiProject.count(),
    ApiKey.count({ where: { status: 'active' } }),
    ApiUsageLog.count({ where: { created_at: { [Op.gte]: day.start, [Op.lt]: day.end } } }),
    ApiUsageLog.count({ where: { created_at: { [Op.gte]: month.start, [Op.lt]: month.end } } }),
    ApiUsageLog.count({
      where: {
        status_code: { [Op.gte]: 400 },
        created_at: { [Op.gte]: day.start, [Op.lt]: day.end },
      },
    }),
    ApiUsageLog.count({
      where: {
        status_code: 429,
        created_at: { [Op.gte]: day.start, [Op.lt]: day.end },
      },
    }),
    ApiUsageLog.findAll({
      where: { created_at: { [Op.gte]: day.start, [Op.lt]: day.end } },
      attributes: [[fn('AVG', col('response_time_ms')), 'avg']],
      raw: true,
    }),
    ApiUsageLog.findAll({
      where: { created_at: { [Op.gte]: month.start, [Op.lt]: month.end } },
      attributes: ['endpoint', [fn('COUNT', col('id')), 'count']],
      group: ['endpoint'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 1,
      raw: true,
    }),
    ApiUsageLog.findAll({
      where: { created_at: { [Op.gte]: month.start, [Op.lt]: month.end } },
      attributes: ['api_project_id', [fn('COUNT', col('id')), 'count']],
      group: ['api_project_id'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 1,
      raw: true,
    }),
  ]);
  const mostActiveProject = projectRows[0]?.api_project_id
    ? await ApiProject.findByPk(projectRows[0].api_project_id)
    : null;
  return {
    totalApiProjects,
    activeApiKeys,
    callsToday,
    callsThisMonth,
    failedCalls,
    rateLimitedCalls,
    averageResponseTimeMs: Math.round(Number(avgResponseRows[0]?.avg || 0)),
    mostUsedEndpoint: endpointRows[0]?.endpoint || null,
    mostActiveProject: mostActiveProject ? mapProject(mostActiveProject) : null,
  };
};

const listLogs = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 50, maxLimit: 500 });
  const where = {};
  if (req.params.projectId) where.api_project_id = req.params.projectId;
  if (req.query.keyId) where.api_key_id = req.query.keyId;
  if (req.query.statusCode) where.status_code = Number(req.query.statusCode);
  const { rows, count } = await ApiUsageLog.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      apiProjectId: row.api_project_id,
      apiKeyId: row.api_key_id,
      endpoint: row.endpoint,
      method: row.method,
      requestIp: row.request_ip,
      userAgent: row.user_agent,
      latRounded: row.lat_rounded,
      lngRounded: row.lng_rounded,
      radius: row.radius,
      responseCount: row.response_count,
      statusCode: row.status_code,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      responseTimeMs: row.response_time_ms,
      createdAt: row.created_at,
    })),
    meta: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
};

const listEvents = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 50, maxLimit: 500 });
  const where = {};
  if (req.params.projectId) where.api_project_id = req.params.projectId;
  if (req.query.keyId) where.api_key_id = req.query.keyId;
  if (req.query.eventType) where.event_type = String(req.query.eventType).trim();
  const { rows, count } = await ApiKeyEvent.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      apiProjectId: row.api_project_id,
      apiKeyId: row.api_key_id,
      eventType: row.event_type,
      actorUserId: row.actor_user_id,
      requestIp: row.request_ip,
      userAgent: row.user_agent,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    })),
    meta: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
};

const getAnalytics = async (req) => {
  ensureSuperAdmin(req);
  const where = {};
  if (req.params.projectId) where.api_project_id = req.params.projectId;
  if (req.query.keyId) where.api_key_id = req.query.keyId;
  const summaries = await ApiUsageDailySummary.findAll({
    where,
    order: [['date', 'DESC']],
    limit: 45,
  });
  const month = getMonthWindow(new Date(), DEFAULT_API_TIMEZONE);
  const monthStartKey = toTimezoneDateKey(month.start, DEFAULT_API_TIMEZONE);
  const monthlyWhere = {
    ...where,
    ...(monthStartKey ? { date: { [Op.gte]: monthStartKey } } : {}),
  };
  const monthlySummaries = await ApiUsageDailySummary.findAll({
    where: monthlyWhere,
    attributes: [
      [fn('SUM', col('total_requests')), 'totalRequests'],
      [fn('SUM', col('successful_requests')), 'successfulRequests'],
      [fn('SUM', col('failed_requests')), 'failedRequests'],
      [fn('SUM', col('rate_limited_requests')), 'rateLimitedRequests'],
      [fn('SUM', col('total_toilets_returned')), 'totalToiletsReturned'],
      [fn('AVG', col('avg_response_time_ms')), 'avgResponseTimeMs'],
      [fn('MAX', col('unique_ips_count')), 'uniqueIpsCount'],
    ],
    raw: true,
  });
  const project = req.params.projectId ? await ApiProject.findByPk(req.params.projectId) : null;
  const keys = req.params.projectId
    ? await ApiKey.findAll({ where: { api_project_id: req.params.projectId }, order: [['created_at', 'DESC']] })
    : [];
  const monthly = monthlySummaries[0] || {};
  return {
    projectUsage: {
      apiProjectId: req.params.projectId || null,
      projectName: project?.project_name || null,
      usageBy: project?.usage_by || null,
      monthStartDate: monthStartKey,
      totalRequests: Number(monthly.totalRequests || 0),
      successfulRequests: Number(monthly.successfulRequests || 0),
      failedRequests: Number(monthly.failedRequests || 0),
      rateLimitedRequests: Number(monthly.rateLimitedRequests || 0),
      totalToiletsReturned: Number(monthly.totalToiletsReturned || 0),
      avgResponseTimeMs: Math.round(Number(monthly.avgResponseTimeMs || 0)),
      uniqueIpsCount: Number(monthly.uniqueIpsCount || 0),
    },
    summaries: summaries.map((row) => ({
      id: row.id,
      apiProjectId: row.api_project_id,
      apiKeyId: row.api_key_id,
      date: row.date,
      totalRequests: row.total_requests,
      successfulRequests: row.successful_requests,
      failedRequests: row.failed_requests,
      rateLimitedRequests: row.rate_limited_requests,
      avgResponseTimeMs: row.avg_response_time_ms,
      p95ResponseTimeMs: row.p95_response_time_ms,
      totalToiletsReturned: row.total_toilets_returned,
      uniqueIpsCount: row.unique_ips_count,
    })),
    quotaUsage: keys.map((key) => ({
      apiKeyId: key.id,
      keyName: key.key_name,
      keyPrefix: key.key_prefix,
      lastUsedAt: key.last_used_at,
      dailyLimit: key.rate_limit_per_day,
      monthlyQuota: key.monthly_quota,
    })),
  };
};

const listTenantsForScope = async (req) => {
  ensureSuperAdmin(req);
  const tenants = await Tenant.findAll({
    attributes: ['id', 'name', 'code', 'status'],
    order: [['name', 'ASC']],
  });
  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    code: tenant.code,
    status: tenant.status,
  }));
};

module.exports = {
  listProjects,
  createProject,
  getProjectById,
  updateProject,
  listKeys,
  createKey,
  updateKey,
  revokeKey,
  regenerateKey,
  getOverview,
  listLogs,
  listEvents,
  getAnalytics,
  listTenantsForScope,
  mapKey,
  mapProject,
};
