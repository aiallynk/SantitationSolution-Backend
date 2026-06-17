const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const { AiUsageLog, Tenant, PlatformUser, sequelize } = require('../../models');

const resolveLimit = (raw, defaultVal = 50, maxVal = 500) => {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultVal;
  return Math.min(parsed, maxVal);
};

const resolveOffset = (page, limit) => {
  const p = Math.max(Number(page) || 1, 1);
  return (p - 1) * limit;
};

const buildDateWhere = (range, fromDate, toDate) => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (fromDate && toDate) {
    return { [Op.between]: [new Date(fromDate), new Date(toDate)] };
  }

  switch (String(range || '').toLowerCase()) {
    case 'today':
      return { [Op.gte]: today };
    case 'last_7_days':
    case '7d': {
      const d = new Date(today);
      d.setDate(d.getDate() - 6);
      return { [Op.gte]: d };
    }
    case 'last_30_days':
    case '30d': {
      const d = new Date(today);
      d.setDate(d.getDate() - 29);
      return { [Op.gte]: d };
    }
    case 'this_month': {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      return { [Op.gte]: d };
    }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 1);
      return { [Op.gte]: start, [Op.lt]: end };
    }
    default:
      return null;
  }
};

const buildWhere = ({ tenantId, featureKey, modelName, status, range, fromDate, toDate } = {}) => {
  const where = {};
  if (tenantId) where.tenant_id = tenantId;
  if (featureKey) where.feature_key = featureKey;
  if (modelName) where.model_name = modelName;
  if (status) where.status = status;
  const dateFilter = buildDateWhere(range, fromDate, toDate);
  if (dateFilter) where.created_at = dateFilter;
  return where;
};

// ─── Super Admin ───────────────────────────────────────────────────────────────

const getSaOverview = async (req) => {
  const { range, fromDate, toDate } = req.query;
  const where = buildWhere({ range, fromDate, toDate });

  const [totals, byFeature, byModel, daily] = await Promise.all([
    AiUsageLog.findOne({
      attributes: [
        [fn('COUNT', col('id')), 'totalRequests'],
        [fn('SUM', col('total_tokens')), 'totalTokens'],
        [fn('SUM', col('input_tokens')), 'inputTokens'],
        [fn('SUM', col('output_tokens')), 'outputTokens'],
        [fn('SUM', col('cost_usd')), 'totalCostUsd'],
        [fn('SUM', col('cost_inr')), 'totalCostInr'],
        [fn('AVG', col('latency_ms')), 'avgLatencyMs'],
        [fn('COUNT', literal("CASE WHEN \"AiUsageLog\".\"status\" = 'failed' THEN 1 END")), 'failedRequests'],
        [fn('COUNT', literal("CASE WHEN \"AiUsageLog\".\"status\" = 'success' THEN 1 END")), 'successRequests'],
      ],
      where,
      raw: true,
    }),
    AiUsageLog.findAll({
      attributes: [
        'feature_key',
        'feature_name',
        [fn('COUNT', col('id')), 'cnt'],
        [fn('SUM', col('total_tokens')), 'tokens'],
        [fn('SUM', col('cost_usd')), 'costUsd'],
      ],
      where,
      group: ['feature_key', 'feature_name'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      limit: 10,
      raw: true,
    }),
    AiUsageLog.findAll({
      attributes: [
        'model_name',
        [fn('COUNT', col('id')), 'cnt'],
        [fn('SUM', col('total_tokens')), 'tokens'],
        [fn('SUM', col('cost_usd')), 'costUsd'],
      ],
      where,
      group: ['model_name'],
      order: [[fn('SUM', col('total_tokens')), 'DESC']],
      raw: true,
    }),
    AiUsageLog.findAll({
      attributes: [
        [fn('DATE', col('created_at')), 'date'],
        [fn('COUNT', col('id')), 'cnt'],
        [fn('SUM', col('total_tokens')), 'tokens'],
        [fn('SUM', col('cost_usd')), 'costUsd'],
      ],
      where,
      group: [fn('DATE', col('created_at'))],
      order: [[fn('DATE', col('created_at')), 'ASC']],
      raw: true,
    }),
  ]);

  return {
    totals: {
      totalRequests: Number(totals?.totalRequests || 0),
      totalTokens: Number(totals?.totalTokens || 0),
      inputTokens: Number(totals?.inputTokens || 0),
      outputTokens: Number(totals?.outputTokens || 0),
      totalCostUsd: Number(totals?.totalCostUsd || 0),
      totalCostInr: Number(totals?.totalCostInr || 0),
      avgLatencyMs: totals?.avgLatencyMs ? Math.round(Number(totals.avgLatencyMs)) : null,
      failedRequests: Number(totals?.failedRequests || 0),
      successRequests: Number(totals?.successRequests || 0),
    },
    byFeature: byFeature.map((r) => ({
      featureKey: r.feature_key,
      featureName: r.feature_name,
      count: Number(r.cnt),
      tokens: Number(r.tokens || 0),
      costUsd: Number(r.costUsd || 0),
    })),
    byModel: byModel.map((r) => ({
      modelName: r.model_name,
      count: Number(r.cnt),
      tokens: Number(r.tokens || 0),
      costUsd: Number(r.costUsd || 0),
    })),
    daily: daily.map((r) => ({
      date: String(r.date),
      count: Number(r.cnt),
      tokens: Number(r.tokens || 0),
      costUsd: Number(r.costUsd || 0),
    })),
  };
};

const getSaTenantConsumption = async (req) => {
  const { range, fromDate, toDate, page = 1, limit: rawLimit = 50 } = req.query;
  const limit = resolveLimit(rawLimit, 50, 200);
  const offset = resolveOffset(page, limit);
  const where = buildWhere({ range, fromDate, toDate });

  // Use raw query to avoid Sequelize GROUP BY + include complications
  const whereClauses = buildRawWhereClauses(where);
  const sql = `
    SELECT
      l.tenant_id,
      t.name AS tenant_name,
      t.code AS tenant_code,
      COUNT(l.id)::int AS total_calls,
      SUM(l.total_tokens)::bigint AS total_tokens,
      SUM(l.input_tokens)::bigint AS input_tokens,
      SUM(l.output_tokens)::bigint AS output_tokens,
      SUM(l.cost_usd)::float AS total_cost_usd,
      SUM(l.cost_inr)::float AS total_cost_inr,
      COUNT(CASE WHEN l.status = 'failed' THEN 1 END)::int AS failed_calls,
      MAX(l.created_at) AS last_used_at
    FROM ai_usage_logs l
    LEFT JOIN tenants t ON t.id = l.tenant_id
    ${whereClauses.sql.length ? 'WHERE ' + whereClauses.sql : ''}
    GROUP BY l.tenant_id, t.name, t.code
    ORDER BY SUM(l.cost_usd) DESC
    LIMIT :limit OFFSET :offset
  `;

  const rows = await sequelize.query(sql, {
    replacements: { ...whereClauses.replacements, limit, offset },
    type: QueryTypes.SELECT,
  });

  // Fetch most-used model per tenant
  const tenantIds = rows.map((r) => r.tenant_id).filter(Boolean);
  let mostUsedModelByTenant = {};
  if (tenantIds.length > 0) {
    const modelRows = await AiUsageLog.findAll({
      attributes: [
        'tenant_id',
        'model_name',
        [fn('COUNT', col('id')), 'cnt'],
      ],
      where: { ...where, tenant_id: { [Op.in]: tenantIds } },
      group: ['tenant_id', 'model_name'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      raw: true,
    });
    for (const r of modelRows) {
      if (!mostUsedModelByTenant[r.tenant_id]) {
        mostUsedModelByTenant[r.tenant_id] = r.model_name;
      }
    }
  }

  return rows.map((row) => ({
    tenantId: row.tenant_id,
    tenantName: row.tenant_name || row.tenant_id,
    tenantCode: row.tenant_code || null,
    totalCalls: Number(row.total_calls || 0),
    totalTokens: Number(row.total_tokens || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    totalCostUsd: Number(row.total_cost_usd || 0),
    totalCostInr: Number(row.total_cost_inr || 0),
    failedCalls: Number(row.failed_calls || 0),
    mostUsedModel: mostUsedModelByTenant[row.tenant_id] || null,
    lastUsedAt: row.last_used_at || null,
  }));
};

const getSaLogs = async (req) => {
  const {
    tenantId, featureKey, modelName, status,
    range, fromDate, toDate,
    page = 1, limit: rawLimit = 50, search,
  } = req.query;
  const limit = resolveLimit(rawLimit, 50, 200);
  const offset = resolveOffset(page, limit);
  const where = buildWhere({ tenantId, featureKey, modelName, status, range, fromDate, toDate });

  if (search) {
    where[Op.or] = [
      { feature_name: { [Op.iLike]: `%${search}%` } },
      { model_name: { [Op.iLike]: `%${search}%` } },
    ];
  }

  const { count, rows } = await AiUsageLog.findAndCountAll({
    where,
    include: [
      { model: Tenant, as: 'tenant', attributes: ['id', 'name'], required: false },
      { model: PlatformUser, as: 'user', attributes: ['id', 'full_name', 'email'], required: false },
      { model: PlatformUser, as: 'worker', attributes: ['id', 'full_name'], required: false },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
    subQuery: false,
  });

  return {
    items: rows.map(mapLogRow),
    meta: { total: count, page: Number(page), limit, pages: Math.ceil(count / limit) },
  };
};

// ─── Ops Admin ─────────────────────────────────────────────────────────────────

const getOpsOverview = async (req) => {
  const tenantId = req.user.tenantId;
  if (!tenantId) return buildEmptyOverview();

  const { range, fromDate, toDate } = req.query;
  const where = buildWhere({ tenantId, range, fromDate, toDate });

  const [totals, byFeature, byModel, daily] = await Promise.all([
    AiUsageLog.findOne({
      attributes: [
        [fn('COUNT', col('id')), 'totalRequests'],
        [fn('SUM', col('total_tokens')), 'totalTokens'],
        [fn('SUM', col('input_tokens')), 'inputTokens'],
        [fn('SUM', col('output_tokens')), 'outputTokens'],
        [fn('SUM', col('cost_usd')), 'totalCostUsd'],
        [fn('SUM', col('cost_inr')), 'totalCostInr'],
        [fn('AVG', col('latency_ms')), 'avgLatencyMs'],
        [fn('COUNT', literal("CASE WHEN \"AiUsageLog\".\"status\" = 'failed' THEN 1 END")), 'failedRequests'],
        [fn('COUNT', literal("CASE WHEN \"AiUsageLog\".\"status\" = 'success' THEN 1 END")), 'successRequests'],
        [fn('COUNT', literal('DISTINCT "AiUsageLog"."worker_id"')), 'workerCount'],
      ],
      where,
      raw: true,
    }),
    AiUsageLog.findAll({
      attributes: [
        'feature_key',
        'feature_name',
        [fn('COUNT', col('id')), 'cnt'],
        [fn('SUM', col('total_tokens')), 'tokens'],
        [fn('SUM', col('cost_usd')), 'costUsd'],
        [fn('AVG', col('latency_ms')), 'avgLatencyMs'],
        [fn('COUNT', literal("CASE WHEN \"AiUsageLog\".\"status\" = 'failed' THEN 1 END")), 'failedCount'],
      ],
      where,
      group: ['feature_key', 'feature_name'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      raw: true,
    }),
    AiUsageLog.findAll({
      attributes: [
        'model_name',
        [fn('COUNT', col('id')), 'cnt'],
        [fn('SUM', col('total_tokens')), 'tokens'],
        [fn('SUM', col('cost_usd')), 'costUsd'],
      ],
      where,
      group: ['model_name'],
      order: [[fn('SUM', col('total_tokens')), 'DESC']],
      raw: true,
    }),
    AiUsageLog.findAll({
      attributes: [
        [fn('DATE', col('created_at')), 'date'],
        [fn('COUNT', col('id')), 'cnt'],
        [fn('SUM', col('total_tokens')), 'tokens'],
        [fn('SUM', col('cost_usd')), 'costUsd'],
      ],
      where,
      group: [fn('DATE', col('created_at'))],
      order: [[fn('DATE', col('created_at')), 'ASC']],
      raw: true,
    }),
  ]);

  return {
    totals: {
      totalRequests: Number(totals?.totalRequests || 0),
      totalTokens: Number(totals?.totalTokens || 0),
      inputTokens: Number(totals?.inputTokens || 0),
      outputTokens: Number(totals?.outputTokens || 0),
      totalCostUsd: Number(totals?.totalCostUsd || 0),
      totalCostInr: Number(totals?.totalCostInr || 0),
      avgLatencyMs: totals?.avgLatencyMs ? Math.round(Number(totals.avgLatencyMs)) : null,
      failedRequests: Number(totals?.failedRequests || 0),
      successRequests: Number(totals?.successRequests || 0),
      workerCount: Number(totals?.workerCount || 0),
    },
    byFeature: byFeature.map((r) => ({
      featureKey: r.feature_key,
      featureName: r.feature_name,
      count: Number(r.cnt),
      tokens: Number(r.tokens || 0),
      costUsd: Number(r.costUsd || 0),
      avgLatencyMs: r.avgLatencyMs ? Math.round(Number(r.avgLatencyMs)) : null,
      failedCount: Number(r.failedCount || 0),
      failureRate: Number(r.cnt) > 0
        ? Math.round((Number(r.failedCount || 0) / Number(r.cnt)) * 100)
        : 0,
    })),
    byModel: byModel.map((r) => ({
      modelName: r.model_name,
      count: Number(r.cnt),
      tokens: Number(r.tokens || 0),
      costUsd: Number(r.costUsd || 0),
    })),
    daily: daily.map((r) => ({
      date: String(r.date),
      count: Number(r.cnt),
      tokens: Number(r.tokens || 0),
      costUsd: Number(r.costUsd || 0),
    })),
  };
};

const getOpsWorkerConsumption = async (req) => {
  const tenantId = req.user.tenantId;
  if (!tenantId) return [];

  const { range, fromDate, toDate, page = 1, limit: rawLimit = 50 } = req.query;
  const limit = resolveLimit(rawLimit, 50, 200);
  const offset = resolveOffset(page, limit);
  const where = buildWhere({ tenantId, range, fromDate, toDate });
  const whereClauses = buildRawWhereClauses({ ...where, worker_id_not_null: true });

  const sql = `
    SELECT
      l.worker_id,
      u.full_name AS worker_name,
      COUNT(l.id)::int AS total_calls,
      SUM(l.total_tokens)::bigint AS total_tokens,
      SUM(l.cost_usd)::float AS total_cost_usd,
      SUM(l.cost_inr)::float AS total_cost_inr,
      MAX(l.created_at) AS last_used_at
    FROM ai_usage_logs l
    LEFT JOIN platform_users u ON u.id = l.worker_id
    WHERE l.worker_id IS NOT NULL
      ${whereClauses.sql.length ? 'AND ' + whereClauses.sql : ''}
    GROUP BY l.worker_id, u.full_name
    ORDER BY COUNT(l.id) DESC
    LIMIT :limit OFFSET :offset
  `;

  const rows = await sequelize.query(sql, {
    replacements: { ...whereClauses.replacements, limit, offset },
    type: QueryTypes.SELECT,
  });

  // Fetch top feature per worker
  const workerIds = rows.map((r) => r.worker_id).filter(Boolean);
  let topFeatureByWorker = {};
  if (workerIds.length > 0) {
    const featureRows = await AiUsageLog.findAll({
      attributes: [
        'worker_id',
        'feature_name',
        [fn('COUNT', col('id')), 'cnt'],
      ],
      where: { ...where, worker_id: { [Op.in]: workerIds } },
      group: ['worker_id', 'feature_name'],
      order: [[fn('COUNT', col('id')), 'DESC']],
      raw: true,
    });
    for (const r of featureRows) {
      if (!topFeatureByWorker[r.worker_id]) {
        topFeatureByWorker[r.worker_id] = r.feature_name;
      }
    }
  }

  return rows.map((row) => ({
    workerId: row.worker_id,
    workerName: row.worker_name || row.worker_id,
    totalCalls: Number(row.total_calls || 0),
    totalTokens: Number(row.total_tokens || 0),
    totalCostUsd: Number(row.total_cost_usd || 0),
    totalCostInr: Number(row.total_cost_inr || 0),
    mostUsedFeature: topFeatureByWorker[row.worker_id] || null,
    lastUsedAt: row.last_used_at || null,
  }));
};

const getOpsFeatureConsumption = async (req) => {
  const tenantId = req.user.tenantId;
  if (!tenantId) return [];

  const { range, fromDate, toDate } = req.query;
  const where = buildWhere({ tenantId, range, fromDate, toDate });

  const rows = await AiUsageLog.findAll({
    attributes: [
      'feature_key',
      'feature_name',
      [fn('COUNT', col('id')), 'cnt'],
      [fn('SUM', col('total_tokens')), 'tokens'],
      [fn('SUM', col('cost_usd')), 'costUsd'],
      [fn('SUM', col('cost_inr')), 'costInr'],
      [fn('AVG', col('latency_ms')), 'avgLatencyMs'],
      [fn('COUNT', literal("CASE WHEN \"AiUsageLog\".\"status\" = 'failed' THEN 1 END")), 'failedCount'],
      [fn('COUNT', literal("CASE WHEN \"AiUsageLog\".\"status\" = 'success' THEN 1 END")), 'successCount'],
    ],
    where,
    group: ['feature_key', 'feature_name'],
    order: [[fn('COUNT', col('id')), 'DESC']],
    raw: true,
  });

  return rows.map((r) => ({
    featureKey: r.feature_key,
    featureName: r.feature_name,
    count: Number(r.cnt),
    tokens: Number(r.tokens || 0),
    costUsd: Number(r.costUsd || 0),
    costInr: Number(r.costInr || 0),
    avgLatencyMs: r.avgLatencyMs ? Math.round(Number(r.avgLatencyMs)) : null,
    failedCount: Number(r.failedCount || 0),
    successCount: Number(r.successCount || 0),
    failureRate: Number(r.cnt) > 0
      ? Math.round((Number(r.failedCount || 0) / Number(r.cnt)) * 100)
      : 0,
  }));
};

const getOpsLogs = async (req) => {
  const tenantId = req.user.tenantId;
  if (!tenantId) return { items: [], meta: { total: 0, page: 1, limit: 50, pages: 0 } };

  const {
    featureKey, modelName, status, workerId,
    range, fromDate, toDate,
    page = 1, limit: rawLimit = 50, search,
  } = req.query;
  const limit = resolveLimit(rawLimit, 50, 200);
  const offset = resolveOffset(page, limit);
  const where = buildWhere({ tenantId, featureKey, modelName, status, range, fromDate, toDate });
  if (workerId) where.worker_id = workerId;

  if (search) {
    where[Op.or] = [
      { feature_name: { [Op.iLike]: `%${search}%` } },
      { model_name: { [Op.iLike]: `%${search}%` } },
    ];
  }

  const { count, rows } = await AiUsageLog.findAndCountAll({
    where,
    include: [
      { model: PlatformUser, as: 'user', attributes: ['id', 'full_name', 'email'], required: false },
      { model: PlatformUser, as: 'worker', attributes: ['id', 'full_name'], required: false },
    ],
    order: [['created_at', 'DESC']],
    limit,
    offset,
    subQuery: false,
  });

  return {
    items: rows.map(mapLogRow),
    meta: { total: count, page: Number(page), limit, pages: Math.ceil(count / limit) },
  };
};

// ─── Raw query WHERE builder ────────────────────────────────────────────────────

const buildRawWhereClauses = (where) => {
  const parts = [];
  const replacements = {};
  let idx = 0;

  if (where.tenant_id) {
    parts.push(`l.tenant_id = :tenant_id_${idx}`);
    replacements[`tenant_id_${idx}`] = where.tenant_id;
    idx++;
  }
  if (where.feature_key) {
    parts.push(`l.feature_key = :feature_key_${idx}`);
    replacements[`feature_key_${idx}`] = where.feature_key;
    idx++;
  }
  if (where.model_name) {
    parts.push(`l.model_name = :model_name_${idx}`);
    replacements[`model_name_${idx}`] = where.model_name;
    idx++;
  }
  if (where.status) {
    parts.push(`l.status = :status_${idx}`);
    replacements[`status_${idx}`] = where.status;
    idx++;
  }
  if (where.created_at) {
    const dateFilter = where.created_at;
    if (dateFilter[Op.gte]) {
      parts.push(`l.created_at >= :created_at_gte`);
      replacements.created_at_gte = dateFilter[Op.gte];
    }
    if (dateFilter[Op.lte]) {
      parts.push(`l.created_at <= :created_at_lte`);
      replacements.created_at_lte = dateFilter[Op.lte];
    }
    if (dateFilter[Op.lt]) {
      parts.push(`l.created_at < :created_at_lt`);
      replacements.created_at_lt = dateFilter[Op.lt];
    }
    if (Array.isArray(dateFilter[Op.between])) {
      parts.push(`l.created_at BETWEEN :created_at_start AND :created_at_end`);
      replacements.created_at_start = dateFilter[Op.between][0];
      replacements.created_at_end = dateFilter[Op.between][1];
    }
  }

  return { sql: parts.join(' AND '), replacements };
};

// ─── Shared helpers ──────────────────────────────────────────────────────────────

const mapLogRow = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  workerId: row.worker_id,
  inspectionId: row.inspection_id,
  toiletId: row.toilet_id,
  userRole: row.user_role,
  featureKey: row.feature_key,
  featureName: row.feature_name,
  aiProvider: row.ai_provider,
  modelName: row.model_name,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  totalTokens: row.total_tokens,
  imageCount: row.image_count,
  costUsd: Number(row.cost_usd || 0),
  costInr: Number(row.cost_inr || 0),
  usdToInrRate: Number(row.usd_to_inr_rate || 0),
  isEstimated: row.is_estimated,
  status: row.status,
  latencyMs: row.latency_ms,
  errorMessage: row.error_message,
  providerRequestId: row.provider_request_id,
  metadata: row.metadata,
  workerName: row.worker?.full_name || null,
  userName: row.user?.full_name || null,
  tenantName: row.tenant?.name || null,
  createdAt: row.created_at,
});

const buildEmptyOverview = () => ({
  totals: {
    totalRequests: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCostUsd: 0,
    totalCostInr: 0,
    avgLatencyMs: null,
    failedRequests: 0,
    successRequests: 0,
    workerCount: 0,
  },
  byFeature: [],
  byModel: [],
  daily: [],
});

module.exports = {
  getSaOverview,
  getSaTenantConsumption,
  getSaLogs,
  getOpsOverview,
  getOpsWorkerConsumption,
  getOpsFeatureConsumption,
  getOpsLogs,
};
