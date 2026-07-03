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
const publicToiletService = require('../publicApi/publicToilet.service');

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

const parseDateBound = (value, { endOfDay = false } = {}) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}+05:30`)
    : new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError('Date filters must be valid dates', 400, { code: 'INVALID_DATE_RANGE' });
  }
  return parsed;
};

const getRequestedDateRange = (query = {}) => {
  const from = parseDateBound(query.from || query.dateFrom || query.startDate);
  const to = parseDateBound(query.to || query.dateTo || query.endDate, { endOfDay: true });
  if (from && to && from.getTime() > to.getTime()) {
    throw new AppError('from must be before to', 400, { code: 'INVALID_DATE_RANGE' });
  }
  return {
    from,
    to,
    fromDateKey: from ? toTimezoneDateKey(from, DEFAULT_API_TIMEZONE) : null,
    toDateKey: to ? toTimezoneDateKey(to, DEFAULT_API_TIMEZONE) : null,
  };
};

const applyCreatedAtRange = (where, range) => {
  const createdAt = {};
  if (range.from) createdAt[Op.gte] = range.from;
  if (range.to) createdAt[Op.lte] = range.to;
  if (Object.keys(createdAt).length > 0) where.created_at = createdAt;
};

const applySummaryDateRange = (where, range) => {
  const date = {};
  if (range.fromDateKey) date[Op.gte] = range.fromDateKey;
  if (range.toDateKey) date[Op.lte] = range.toDateKey;
  if (Object.keys(date).length > 0) where.date = date;
};

const normalizeOptionalNumber = (value, fieldName) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new AppError(`${fieldName} must be a number`, 400, { code: 'INVALID_FILTER' });
  }
  return parsed;
};

const eventSeverity = (eventType) => {
  const type = String(eventType || '').toUpperCase();
  if (['REVOKED_KEY_USED', 'EXPIRED_KEY_USED', 'INVALID_KEY_ATTEMPTS_DETECTED'].includes(type)) return 'critical';
  if (['HIGH_USAGE_DETECTED', 'ORIGIN_NOT_ALLOWED', 'IP_NOT_ALLOWED', 'ENDPOINT_SCOPE_DENIED', 'TENANT_SCOPE_DENIED'].includes(type)) return 'high';
  if (['RATE_LIMIT_EXCEEDED', 'KEY_REVOKED', 'KEY_EXPIRED', 'KEY_REGENERATED'].includes(type)) return 'medium';
  return 'low';
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
  projectName: row.project?.project_name || null,
  usageBy: row.project?.usage_by || null,
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

const mapLog = (row) => ({
  id: row.id,
  apiProjectId: row.api_project_id,
  apiKeyId: row.api_key_id,
  projectName: row.project?.project_name || null,
  usageBy: row.project?.usage_by || null,
  keyName: row.apiKey?.key_name || null,
  keyPrefix: row.apiKey?.key_prefix || null,
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
});

const mapEvent = (row) => ({
  id: row.id,
  apiProjectId: row.api_project_id,
  apiKeyId: row.api_key_id,
  projectName: row.project?.project_name || null,
  usageBy: row.project?.usage_by || null,
  keyName: row.apiKey?.key_name || null,
  keyPrefix: row.apiKey?.key_prefix || null,
  eventType: row.event_type,
  severity: eventSeverity(row.event_type),
  actorUserId: row.actor_user_id,
  requestIp: row.request_ip,
  userAgent: row.user_agent,
  metadata: row.metadata || {},
  createdAt: row.created_at,
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
  const project = req.params.projectId ? await loadProject(req.params.projectId) : null;
  const where = {};
  if (project?.id) where.api_project_id = project.id;
  if (req.query.projectId) where.api_project_id = req.query.projectId;
  if (req.query.status) where.status = normalizeKeyStatus(req.query.status);
  if (req.query.environment) where.environment = normalizeKeyEnvironment(req.query.environment);
  const keyQuery = {
    where,
    include: [{ model: ApiProject, as: 'project', attributes: ['id', 'project_name', 'usage_by'], required: false }],
    order: [['created_at', 'DESC']],
  };
  if (!req.params.projectId) keyQuery.limit = 250;
  const keys = await ApiKey.findAll(keyQuery);
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
  const endpointScopeChanged =
    req.body.allowedEndpoints !== undefined ||
    req.body.allowed_endpoints !== undefined;
  const tenantScopeChanged =
    req.body.allowedTenantIds !== undefined ||
    req.body.allowed_tenant_ids !== undefined;

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
  if (endpointScopeChanged) {
    await recordApiKeyEvent({
      apiProjectId: apiKey.api_project_id,
      apiKeyId: apiKey.id,
      eventType: EVENT_TYPES.KEY_ENDPOINT_SCOPE_UPDATED,
      actorUserId: req.user.id,
      metadata: { allowed_endpoints: updates.allowed_endpoints },
    });
  }
  if (tenantScopeChanged) {
    await recordApiKeyEvent({
      apiProjectId: apiKey.api_project_id,
      apiKeyId: apiKey.id,
      eventType: EVENT_TYPES.KEY_TENANT_SCOPE_UPDATED,
      actorUserId: req.user.id,
      metadata: { allowed_tenant_ids: updates.allowed_tenant_ids },
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
    activeAlerts,
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
    ApiKeyEvent.count({
      where: {
        event_type: {
          [Op.in]: [
            EVENT_TYPES.RATE_LIMIT_EXCEEDED,
            EVENT_TYPES.HIGH_USAGE_DETECTED,
            EVENT_TYPES.INVALID_KEY_ATTEMPTS_DETECTED,
            EVENT_TYPES.REVOKED_KEY_USED,
            EVENT_TYPES.EXPIRED_KEY_USED,
          ],
        },
        created_at: { [Op.gte]: day.start, [Op.lt]: day.end },
      },
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
    activeAlerts,
    mostUsedEndpoint: endpointRows[0]?.endpoint || null,
    mostActiveProject: mostActiveProject ? mapProject(mostActiveProject) : null,
  };
};

const listLogs = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 50, maxLimit: 500 });
  const range = getRequestedDateRange(req.query);
  const where = {};
  if (req.params.projectId) where.api_project_id = req.params.projectId;
  if (req.query.projectId) where.api_project_id = req.query.projectId;
  if (req.query.keyId) where.api_key_id = req.query.keyId;
  if (req.query.statusCode) where.status_code = Number(req.query.statusCode);
  if (req.query.endpoint) where.endpoint = { [Op.iLike]: `%${String(req.query.endpoint).trim()}%` };
  if (req.query.method) where.method = String(req.query.method).trim().toUpperCase();
  if (req.query.errorOnly === 'true') where.status_code = { [Op.gte]: 400 };
  if (req.query.rateLimitedOnly === 'true') where.status_code = 429;
  if (req.query.ip) where.request_ip = { [Op.iLike]: `%${String(req.query.ip).trim()}%` };
  const minResponseTime = normalizeOptionalNumber(req.query.minResponseTimeMs || req.query.responseTimeGt, 'minResponseTimeMs');
  if (minResponseTime !== null) where.response_time_ms = { [Op.gte]: minResponseTime };
  applyCreatedAtRange(where, range);
  const { rows, count } = await ApiUsageLog.findAndCountAll({
    where,
    include: [
      { model: ApiProject, as: 'project', attributes: ['id', 'project_name', 'usage_by'], required: false },
      { model: ApiKey, as: 'apiKey', attributes: ['id', 'key_name', 'key_prefix'], required: false },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return {
    items: rows.map(mapLog),
    meta: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
};

const listEvents = async (req) => {
  ensureSuperAdmin(req);
  const { page, limit, offset } = normalizePagination(req.query, { page: 1, limit: 50, maxLimit: 500 });
  const range = getRequestedDateRange(req.query);
  const where = {};
  if (req.params.projectId) where.api_project_id = req.params.projectId;
  if (req.query.projectId) where.api_project_id = req.query.projectId;
  if (req.query.keyId) where.api_key_id = req.query.keyId;
  if (req.query.eventType) where.event_type = String(req.query.eventType).trim();
  if (req.query.ip) where.request_ip = { [Op.iLike]: `%${String(req.query.ip).trim()}%` };
  if (req.query.actorUserId) where.actor_user_id = String(req.query.actorUserId).trim();
  applyCreatedAtRange(where, range);
  const { rows, count } = await ApiKeyEvent.findAndCountAll({
    where,
    include: [
      { model: ApiProject, as: 'project', attributes: ['id', 'project_name', 'usage_by'], required: false },
      { model: ApiKey, as: 'apiKey', attributes: ['id', 'key_name', 'key_prefix'], required: false },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  const severityFilter = String(req.query.severity || '').trim().toLowerCase();
  const mappedRows = rows.map(mapEvent).filter((row) => !severityFilter || row.severity === severityFilter);
  return {
    items: mappedRows,
    meta: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
};

const getAnalytics = async (req) => {
  ensureSuperAdmin(req);
  const range = getRequestedDateRange(req.query);
  const where = {};
  if (req.params.projectId) where.api_project_id = req.params.projectId;
  if (req.query.projectId) where.api_project_id = req.query.projectId;
  if (req.query.keyId) where.api_key_id = req.query.keyId;
  applySummaryDateRange(where, range);
  const summaries = await ApiUsageDailySummary.findAll({
    where,
    order: [['date', 'DESC']],
    limit: range.from || range.to ? 366 : 45,
  });
  const month = getMonthWindow(new Date(), DEFAULT_API_TIMEZONE);
  const monthStartKey = toTimezoneDateKey(month.start, DEFAULT_API_TIMEZONE);
  const monthlyWhere = {
    ...(req.params.projectId || req.query.projectId ? { api_project_id: req.params.projectId || req.query.projectId } : {}),
    ...(req.query.keyId ? { api_key_id: req.query.keyId } : {}),
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
  const projectId = req.params.projectId || req.query.projectId || null;
  const project = projectId ? await ApiProject.findByPk(projectId) : null;
  const keys = projectId
    ? await ApiKey.findAll({ where: { api_project_id: projectId }, order: [['created_at', 'DESC']] })
    : await ApiKey.findAll({ order: [['last_used_at', 'DESC']], limit: 100 });
  const logWhere = {};
  if (projectId) logWhere.api_project_id = projectId;
  if (req.query.keyId) logWhere.api_key_id = req.query.keyId;
  if (range.from || range.to) {
    applyCreatedAtRange(logWhere, range);
  } else {
    logWhere.created_at = { [Op.gte]: month.start, [Op.lt]: month.end };
  }
  if (req.query.endpoint) logWhere.endpoint = { [Op.iLike]: `%${String(req.query.endpoint).trim()}%` };
  if (req.query.statusCode) logWhere.status_code = Number(req.query.statusCode);

  const [
    endpointRows,
    statusRows,
    projectRows,
    keyRows,
    locationRows,
    recentLogs,
    recentEvents,
  ] = await Promise.all([
    ApiUsageLog.findAll({
      where: logWhere,
      attributes: [
        'endpoint',
        [fn('COUNT', col('id')), 'count'],
        [fn('SUM', col('response_count')), 'responseCount'],
      ],
      group: ['endpoint'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 10,
      raw: true,
    }),
    ApiUsageLog.findAll({
      where: logWhere,
      attributes: ['status_code', [fn('COUNT', col('id')), 'count']],
      group: ['status_code'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 12,
      raw: true,
    }),
    ApiUsageLog.findAll({
      where: logWhere,
      attributes: ['api_project_id', [fn('COUNT', col('id')), 'count']],
      group: ['api_project_id'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 10,
      raw: true,
    }),
    ApiUsageLog.findAll({
      where: logWhere,
      attributes: ['api_key_id', [fn('COUNT', col('id')), 'count']],
      group: ['api_key_id'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 10,
      raw: true,
    }),
    ApiUsageLog.findAll({
      where: {
        ...logWhere,
        lat_rounded: { [Op.ne]: null },
        lng_rounded: { [Op.ne]: null },
      },
      attributes: [
        'lat_rounded',
        'lng_rounded',
        [fn('COUNT', col('id')), 'count'],
      ],
      group: ['lat_rounded', 'lng_rounded'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 10,
      raw: true,
    }),
    ApiUsageLog.findAll({
      where: logWhere,
      include: [
        { model: ApiProject, as: 'project', attributes: ['id', 'project_name', 'usage_by'], required: false },
        { model: ApiKey, as: 'apiKey', attributes: ['id', 'key_name', 'key_prefix'], required: false },
      ],
      order: [['created_at', 'DESC']],
      limit: 8,
    }),
    ApiKeyEvent.findAll({
      where: projectId ? { api_project_id: projectId } : {},
      include: [
        { model: ApiProject, as: 'project', attributes: ['id', 'project_name', 'usage_by'], required: false },
        { model: ApiKey, as: 'apiKey', attributes: ['id', 'key_name', 'key_prefix'], required: false },
      ],
      order: [['created_at', 'DESC']],
      limit: 8,
    }),
  ]);

  const projectIds = projectRows.map((row) => row.api_project_id).filter(Boolean);
  const keyIds = keyRows.map((row) => row.api_key_id).filter(Boolean);
  const [projectRowsForNames, keyRowsForNames] = await Promise.all([
    projectIds.length > 0
      ? ApiProject.findAll({ where: { id: { [Op.in]: projectIds } }, attributes: ['id', 'project_name', 'usage_by'] })
      : [],
    keyIds.length > 0
      ? ApiKey.findAll({ where: { id: { [Op.in]: keyIds } }, attributes: ['id', 'key_name', 'key_prefix', 'api_project_id'] })
      : [],
  ]);
  const projectNameMap = new Map(projectRowsForNames.map((row) => [row.id, row]));
  const keyNameMap = new Map(keyRowsForNames.map((row) => [row.id, row]));

  const monthly = monthlySummaries[0] || {};
  const summaryItems = summaries.map((row) => ({
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
  }));
  const timeSeriesMap = new Map();
  summaryItems.forEach((summary) => {
    const current = timeSeriesMap.get(summary.date) || {
      date: summary.date,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      rateLimitedRequests: 0,
      totalToiletsReturned: 0,
      uniqueIpsCount: 0,
      avgResponseTimeMs: 0,
      p95ResponseTimeMs: 0,
      samples: 0,
    };
    current.totalRequests += Number(summary.totalRequests || 0);
    current.successfulRequests += Number(summary.successfulRequests || 0);
    current.failedRequests += Number(summary.failedRequests || 0);
    current.rateLimitedRequests += Number(summary.rateLimitedRequests || 0);
    current.totalToiletsReturned += Number(summary.totalToiletsReturned || 0);
    current.uniqueIpsCount += Number(summary.uniqueIpsCount || 0);
    current.avgResponseTimeMs += Number(summary.avgResponseTimeMs || 0);
    current.p95ResponseTimeMs = Math.max(current.p95ResponseTimeMs, Number(summary.p95ResponseTimeMs || 0));
    current.samples += 1;
    timeSeriesMap.set(summary.date, current);
  });
  const timeSeries = [...timeSeriesMap.values()]
    .map((point) => ({
      ...point,
      avgResponseTimeMs: point.samples > 0 ? Math.round(point.avgResponseTimeMs / point.samples) : 0,
      errorRate: point.totalRequests > 0 ? Number(((point.failedRequests / point.totalRequests) * 100).toFixed(2)) : 0,
    }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return {
    projectUsage: {
      apiProjectId: projectId,
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
    timeSeries,
    endpointBreakdown: endpointRows.map((row) => ({
      endpoint: row.endpoint || 'Unknown',
      count: Number(row.count || 0),
      responseCount: Number(row.responseCount || 0),
    })),
    statusBreakdown: statusRows.map((row) => ({
      statusCode: row.status_code,
      count: Number(row.count || 0),
      category: Number(row.status_code) >= 400 ? 'failed' : 'successful',
    })),
    projectBreakdown: projectRows.map((row) => {
      const projectRow = projectNameMap.get(row.api_project_id);
      return {
        apiProjectId: row.api_project_id,
        projectName: projectRow?.project_name || row.api_project_id || 'Unknown project',
        usageBy: projectRow?.usage_by || null,
        count: Number(row.count || 0),
      };
    }),
    keyBreakdown: keyRows.map((row) => {
      const keyRow = keyNameMap.get(row.api_key_id);
      return {
        apiKeyId: row.api_key_id,
        apiProjectId: keyRow?.api_project_id || null,
        keyName: keyRow?.key_name || 'Unknown key',
        keyPrefix: keyRow?.key_prefix || null,
        count: Number(row.count || 0),
      };
    }),
    locationBreakdown: locationRows.map((row) => ({
      latRounded: row.lat_rounded,
      lngRounded: row.lng_rounded,
      count: Number(row.count || 0),
    })),
    recentLogs: recentLogs.map(mapLog),
    recentEvents: recentEvents.map(mapEvent),
    summaries: summaryItems,
    quotaUsage: keys.map((key) => ({
      apiKeyId: key.id,
      apiProjectId: key.api_project_id,
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
    attributes: ['id', 'name', 'code', 'status', 'external_api_sharing_enabled'],
    order: [['name', 'ASC']],
  });
  return tenants.map((tenant) => ({
    id: tenant.id,
    name: tenant.name,
    code: tenant.code,
    status: tenant.status,
    externalApiSharingEnabled: Boolean(tenant.external_api_sharing_enabled),
  }));
};

const debugNearbyToilets = async (req) => {
  ensureSuperAdmin(req);
  return publicToiletService.getDebugNearbyToilets({
    lat: req.query.lat,
    lng: req.query.lng,
    radius: req.query.radius || 10000,
    apiKeyId: req.query.api_key_id || req.query.apiKeyId || null,
    keyPrefix: req.query.key_prefix || req.query.keyPrefix || null,
    cleanlinessMin: req.query.cleanliness_min ?? req.query.cleanlinessMin ?? 0,
    includeClosed: req.query.include_closed ?? req.query.includeClosed ?? false,
  });
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
  debugNearbyToilets,
  mapKey,
  mapProject,
};
