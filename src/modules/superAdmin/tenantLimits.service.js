'use strict';

const { Op, fn, col, literal } = require('sequelize');
const {
  sequelize,
  Tenant,
  TenantLimit,
  TenantUsageSnapshot,
  PlatformUser,
  Facility,
  ToiletUnit,
  SensorDevice,
  Inspection,
  InspectionMedia,
  Alert,
  AiUsageLog,
} = require('../../models');
const AppError = require('../../core/errors/AppError');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const toInt = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
const toBigInt = (v) => (v != null && !Number.isNaN(Number(v)) ? BigInt(v) : null);
const numericOrNull = (v) => (v != null ? Number(v) || 0 : null);

function storageBytesFromInput({ value, unit }) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new AppError('Storage value must be a positive number', 400);
  const units = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  const multiplier = units[String(unit || 'GB').toUpperCase()];
  if (!multiplier) throw new AppError('Invalid storage unit. Use MB, GB, or TB.', 400);
  return Math.round(n * multiplier);
}

// ─── Get limits ───────────────────────────────────────────────────────────────

async function getTenantLimits(tenantId) {
  const row = await TenantLimit.findOne({ where: { tenant_id: tenantId } });
  if (!row) {
    return buildDefaultLimits(tenantId);
  }
  return formatLimitsRow(row);
}

function buildDefaultLimits(tenantId) {
  return {
    tenantId,
    exists: false,
    limitsEnabled: false,
    storage: { enabled: false, limitBytes: null, hardBlock: false },
    aiTokens: { enabled: false, limit: null, hardBlock: false },
    aiRequests: { enabled: false, limit: null, hardBlock: false },
    users: { enabled: false, limit: null, hardBlock: false },
    toilets: { enabled: false, limit: null, hardBlock: false },
    facilities: { enabled: false, limit: null, hardBlock: false },
    devices: { enabled: false, limit: null, hardBlock: false },
    inspections: { enabled: false, limit: null, hardBlock: false },
    notifications: {
      warning75: true,
      warning90: true,
      exhausted: true,
      notifyTenantAdmin: true,
      notifySuperAdmin: true,
    },
  };
}

function formatLimitsRow(row) {
  return {
    tenantId: row.tenant_id,
    exists: true,
    limitsEnabled: row.limits_enabled,
    storage: {
      enabled: row.storage_limit_enabled,
      limitBytes: row.storage_limit_bytes ? Number(row.storage_limit_bytes) : null,
      hardBlock: row.storage_hard_block,
    },
    aiTokens: {
      enabled: row.ai_token_limit_enabled,
      limit: row.ai_token_limit ? Number(row.ai_token_limit) : null,
      hardBlock: row.ai_token_hard_block,
    },
    aiRequests: {
      enabled: row.ai_request_limit_enabled,
      limit: row.ai_request_limit,
      hardBlock: row.ai_request_hard_block,
    },
    users: {
      enabled: row.user_limit_enabled,
      limit: row.user_limit,
      hardBlock: row.user_hard_block,
    },
    toilets: {
      enabled: row.toilet_limit_enabled,
      limit: row.toilet_limit,
      hardBlock: row.toilet_hard_block,
    },
    facilities: {
      enabled: row.facility_limit_enabled,
      limit: row.facility_limit,
      hardBlock: row.facility_hard_block,
    },
    devices: {
      enabled: row.device_limit_enabled,
      limit: row.device_limit,
      hardBlock: row.device_hard_block,
    },
    inspections: {
      enabled: row.inspection_limit_enabled,
      limit: row.inspection_limit,
      hardBlock: row.inspection_hard_block,
    },
    notifications: {
      warning75: row.quota_warning_75_enabled,
      warning90: row.quota_warning_90_enabled,
      exhausted: row.quota_exhausted_enabled,
      notifyTenantAdmin: row.notify_tenant_admin,
      notifySuperAdmin: row.notify_super_admin,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Update limits ─────────────────────────────────────────────────────────────

async function upsertTenantLimits(tenantId, body, actorUserId) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw new AppError('Tenant not found', 404);

  const patch = {
    limits_enabled: !!body.limitsEnabled,
    updated_by: actorUserId || null,
  };

  if (body.storage != null) {
    patch.storage_limit_enabled = !!body.storage.enabled;
    patch.storage_hard_block = !!body.storage.hardBlock;
    if (body.storage.limitBytes != null) {
      patch.storage_limit_bytes = body.storage.limitBytes;
    } else if (body.storage.value != null && body.storage.unit != null) {
      patch.storage_limit_bytes = storageBytesFromInput({ value: body.storage.value, unit: body.storage.unit });
    } else if (!body.storage.enabled) {
      patch.storage_limit_bytes = null;
    }
  }

  if (body.aiTokens != null) {
    patch.ai_token_limit_enabled = !!body.aiTokens.enabled;
    patch.ai_token_limit = body.aiTokens.enabled ? toInt(body.aiTokens.limit) : null;
    patch.ai_token_hard_block = !!body.aiTokens.hardBlock;
  }

  if (body.aiRequests != null) {
    patch.ai_request_limit_enabled = !!body.aiRequests.enabled;
    patch.ai_request_limit = body.aiRequests.enabled ? toInt(body.aiRequests.limit) : null;
    patch.ai_request_hard_block = !!body.aiRequests.hardBlock;
  }

  if (body.users != null) {
    patch.user_limit_enabled = !!body.users.enabled;
    patch.user_limit = body.users.enabled ? toInt(body.users.limit) : null;
    patch.user_hard_block = !!body.users.hardBlock;
  }

  if (body.toilets != null) {
    patch.toilet_limit_enabled = !!body.toilets.enabled;
    patch.toilet_limit = body.toilets.enabled ? toInt(body.toilets.limit) : null;
    patch.toilet_hard_block = !!body.toilets.hardBlock;
  }

  if (body.facilities != null) {
    patch.facility_limit_enabled = !!body.facilities.enabled;
    patch.facility_limit = body.facilities.enabled ? toInt(body.facilities.limit) : null;
    patch.facility_hard_block = !!body.facilities.hardBlock;
  }

  if (body.devices != null) {
    patch.device_limit_enabled = !!body.devices.enabled;
    patch.device_limit = body.devices.enabled ? toInt(body.devices.limit) : null;
    patch.device_hard_block = !!body.devices.hardBlock;
  }

  if (body.inspections != null) {
    patch.inspection_limit_enabled = !!body.inspections.enabled;
    patch.inspection_limit = body.inspections.enabled ? toInt(body.inspections.limit) : null;
    patch.inspection_hard_block = !!body.inspections.hardBlock;
  }

  if (body.notifications != null) {
    const n = body.notifications;
    if (n.warning75 != null) patch.quota_warning_75_enabled = !!n.warning75;
    if (n.warning90 != null) patch.quota_warning_90_enabled = !!n.warning90;
    if (n.exhausted != null) patch.quota_exhausted_enabled = !!n.exhausted;
    if (n.notifyTenantAdmin != null) patch.notify_tenant_admin = !!n.notifyTenantAdmin;
    if (n.notifySuperAdmin != null) patch.notify_super_admin = !!n.notifySuperAdmin;
  }

  const existing = await TenantLimit.findOne({ where: { tenant_id: tenantId } });
  if (existing) {
    patch.updated_at = new Date();
    await existing.update(patch);
    return formatLimitsRow(await existing.reload());
  } else {
    const created = await TenantLimit.create({ ...patch, tenant_id: tenantId, created_by: actorUserId || null });
    return formatLimitsRow(created);
  }
}

// ─── Usage snapshot (DB metadata strategy) ────────────────────────────────────

async function recalculateTenantUsage(tenantId) {
  const tenant = await Tenant.findByPk(tenantId);
  if (!tenant) throw new AppError('Tenant not found', 404);

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const [
      storageResult,
      usersResult,
      activeUsersResult,
      workersResult,
      facilitiesResult,
      toiletsResult,
      devicesResult,
      inspectionsResult,
      inspections30dResult,
      aiResult,
      alertsResult,
      failedUploadsResult,
    ] = await Promise.all([
      // Storage: aggregate content_length from inspection_media via inspections.tenant_id
      sequelize.query(
        `SELECT
           COALESCE(SUM(media_size_bytes), 0) AS storage_used_bytes,
           COUNT(id) AS image_count,
           COALESCE(AVG(media_size_bytes), 0) AS avg_size,
           COALESCE(MAX(media_size_bytes), 0) AS max_size,
           MAX(uploaded_at) AS latest_upload_at
         FROM (
           SELECT
             im.id,
             COALESCE(im.uploaded_at, im.created_at) AS uploaded_at,
             COALESCE(
               im.content_length,
               CASE WHEN (im.metadata->>'bytes') ~ '^[0-9]+$' THEN (im.metadata->>'bytes')::bigint END,
               CASE WHEN (im.metadata->>'contentLength') ~ '^[0-9]+$' THEN (im.metadata->>'contentLength')::bigint END,
               CASE WHEN (im.metadata->>'fileSize') ~ '^[0-9]+$' THEN (im.metadata->>'fileSize')::bigint END
             ) AS media_size_bytes
           FROM inspection_media im
           JOIN inspections i ON im.inspection_id = i.id
           WHERE i.tenant_id = :tenantId
             AND im.upload_status IN ('uploaded', 'confirmed')
         ) media_sizes
         WHERE media_size_bytes IS NOT NULL`,
        { replacements: { tenantId }, type: sequelize.QueryTypes.SELECT }
      ),
      // Total users
      PlatformUser.count({ where: { tenant_id: tenantId } }),
      // Active users
      PlatformUser.count({ where: { tenant_id: tenantId, status: 'active' } }),
      // Workers (users with worker assignments in this tenant)
      sequelize.query(
        `SELECT COUNT(DISTINCT user_id) AS cnt FROM worker_assignments WHERE tenant_id = :tenantId AND status = 'active'`,
        { replacements: { tenantId }, type: sequelize.QueryTypes.SELECT }
      ),
      // Facilities
      Facility.count({ where: { tenant_id: tenantId } }),
      // Toilets (via facility)
      sequelize.query(
        `SELECT COUNT(*) AS cnt FROM toilet_units tu JOIN facilities f ON tu.facility_id = f.id WHERE f.tenant_id = :tenantId`,
        { replacements: { tenantId }, type: sequelize.QueryTypes.SELECT }
      ),
      // Devices
      SensorDevice.count({ where: { tenant_id: tenantId } }),
      // Total inspections
      Inspection.count({ where: { tenant_id: tenantId } }),
      // Inspections last 30 days
      Inspection.count({ where: { tenant_id: tenantId, created_at: { [Op.gte]: thirtyDaysAgo } } }),
      // AI usage last 30 days
      AiUsageLog.findAll({
        where: { tenant_id: tenantId, created_at: { [Op.gte]: thirtyDaysAgo } },
        attributes: [
          [fn('COUNT', col('id')), 'total_requests'],
          [fn('SUM', col('total_tokens')), 'total_tokens'],
          [fn('SUM', col('cost_usd')), 'total_cost_usd'],
          [fn('SUM', literal(`CASE WHEN status = 'failed' THEN 1 ELSE 0 END`)), 'failed_count'],
        ],
        raw: true,
      }),
      // Open alerts
      Alert.count({ where: { tenant_id: tenantId, status: 'open' } }),
      // Failed uploads in last 30 days
      sequelize.query(
        `SELECT COUNT(im.id) AS cnt
         FROM inspection_media im
         JOIN inspections i ON im.inspection_id = i.id
         WHERE i.tenant_id = :tenantId
           AND im.upload_status IN ('failed', 'upload_failed')
           AND im.created_at >= :since`,
        { replacements: { tenantId, since: thirtyDaysAgo }, type: sequelize.QueryTypes.SELECT }
      ),
    ]);

    const storage = storageResult[0] || {};
    const ai = aiResult[0] || {};
    const workers = workersResult[0] || {};
    const toilets = toiletsResult[0] || {};
    const failedUploads = failedUploadsResult[0] || {};

    const snapshot = {
      tenant_id: tenantId,
      calculated_at: new Date(),
      storage_used_bytes: Number(storage.storage_used_bytes) || 0,
      storage_object_count: Number(storage.image_count) || 0,
      image_count: Number(storage.image_count) || 0,
      average_image_size_bytes: Math.round(Number(storage.avg_size) || 0),
      largest_file_bytes: Number(storage.max_size) || 0,
      latest_upload_at: storage.latest_upload_at || null,
      ai_requests_30d: Number(ai.total_requests) || 0,
      ai_tokens_30d: Number(ai.total_tokens) || 0,
      ai_cost_usd_30d: Number(ai.total_cost_usd) || 0,
      ai_failed_30d: Number(ai.failed_count) || 0,
      users_count: Number(usersResult) || 0,
      active_users_count: Number(activeUsersResult) || 0,
      workers_count: Number(workers.cnt) || 0,
      toilets_count: Number(toilets.cnt) || 0,
      facilities_count: Number(facilitiesResult) || 0,
      devices_count: Number(devicesResult) || 0,
      inspections_count: Number(inspectionsResult) || 0,
      inspections_30d: Number(inspections30dResult) || 0,
      open_alerts_count: Number(alertsResult) || 0,
      failed_uploads_count: Number(failedUploads.cnt) || 0,
      source: 'db_metadata',
      status: 'fresh',
      error_message: null,
    };

    const created = await TenantUsageSnapshot.create(snapshot);
    return formatSnapshotRow(created);
  } catch (err) {
    await TenantUsageSnapshot.create({
      tenant_id: tenantId,
      calculated_at: new Date(),
      source: 'db_metadata',
      status: 'failed',
      error_message: err.message,
    });
    throw new AppError(`Usage recalculation failed: ${err.message}`, 500);
  }
}

async function getLatestUsageSnapshot(tenantId) {
  const row = await TenantUsageSnapshot.findOne({
    where: { tenant_id: tenantId, status: { [Op.ne]: 'failed' } },
    order: [['calculated_at', 'DESC']],
  });
  return row ? formatSnapshotRow(row) : null;
}

function formatSnapshotRow(row) {
  return {
    tenantId: row.tenant_id,
    calculatedAt: row.calculated_at,
    source: row.source,
    status: row.status,
    storageUsedBytes: numericOrNull(row.storage_used_bytes),
    storageObjectCount: numericOrNull(row.storage_object_count),
    imageCount: numericOrNull(row.image_count),
    averageImageSizeBytes: numericOrNull(row.average_image_size_bytes),
    largestFileBytes: numericOrNull(row.largest_file_bytes),
    latestUploadAt: row.latest_upload_at,
    aiRequests30d: numericOrNull(row.ai_requests_30d),
    aiTokens30d: numericOrNull(row.ai_tokens_30d),
    aiCostUsd30d: row.ai_cost_usd_30d != null ? Number(row.ai_cost_usd_30d) : null,
    aiFailed30d: numericOrNull(row.ai_failed_30d),
    usersCount: numericOrNull(row.users_count),
    activeUsersCount: numericOrNull(row.active_users_count),
    workersCount: numericOrNull(row.workers_count),
    toiletsCount: numericOrNull(row.toilets_count),
    facilitiesCount: numericOrNull(row.facilities_count),
    devicesCount: numericOrNull(row.devices_count),
    inspectionsCount: numericOrNull(row.inspections_count),
    inspections30d: numericOrNull(row.inspections_30d),
    openAlertsCount: numericOrNull(row.open_alerts_count),
    failedUploadsCount: numericOrNull(row.failed_uploads_count),
  };
}

// ─── Enriched tenant detail (limits + latest usage combined) ──────────────────

async function getTenantUsageWithLimits(tenantId) {
  const [limits, usage] = await Promise.all([
    getTenantLimits(tenantId),
    getLatestUsageSnapshot(tenantId),
  ]);
  return { limits, usage };
}

module.exports = {
  getTenantLimits,
  upsertTenantLimits,
  recalculateTenantUsage,
  getLatestUsageSnapshot,
  getTenantUsageWithLimits,
  formatLimitsRow,
  formatSnapshotRow,
};
