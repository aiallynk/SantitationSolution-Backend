const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const {
  sequelize,
  Tenant,
  PlatformUser,
  BackupSchedule,
  BackupJob,
  BackupFile,
  BackupAuditLog,
} = require('../../models');
const AppError = require('../../core/errors/AppError');
const { logger } = require('../../core/logging/logger');
const { runtimeConfig } = require('../../config/runtime');
const { createZipBuffer } = require('../../utils/simpleZip');
const {
  calculateS3Usage,
  deleteObjectFromS3,
  getPresignedGetObjectUrl,
  headObjectFromS3,
  isS3Enabled,
  uploadBufferToS3,
} = require('../media/s3.service');
const notificationService = require('../notifications/notification.service');
const {
  NotificationAudienceKinds,
  NotificationPriorities,
  NotificationTypes,
} = require('../notifications/notification.constants');
const { resolvePlatformAdminIds } = require('../notifications/notification.recipientResolver');
const {
  nextDailyRun,
  previousDailyRun,
  normalizeRunTime,
  normalizeScheduleTimezone,
  normalizeTimeFormat,
} = require('./backupSchedule');

const VALID_SCOPES = new Set(['full_db', 'tenant']);
const VALID_STATUSES = new Set(['queued', 'running', 'success', 'failed', 'cancelled']);
const VALID_TRIGGERS = new Set(['manual', 'scheduled']);
const BACKUP_TABLE_SKIP = new Set(['backup_jobs', 'backup_files', 'backup_audit_logs']);
const VALID_STORAGE_PROVIDERS = new Set(['local', 's3']);
const STORAGE_USAGE_CACHE_MS = 30_000;
const ACTIVE_BACKUP_STATUSES = ['queued', 'running'];
let storageUsageCache = null;

const getActorId = (req) => req.user?.id || null;

const ensureSuperAdmin = (req) => {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can access this endpoint', 403, { code: 'SUPER_ADMIN_ONLY' });
  }
};

const ensureCronAccess = (req) => {
  const secret = runtimeConfig.backup.cronSecret;
  if (!secret) return;
  const provided = req.headers['x-backup-cron-secret'] || req.query.secret || req.body?.secret;
  if (provided !== secret) {
    throw new AppError('Invalid backup scheduler secret', 401, { code: 'BACKUP_CRON_UNAUTHORIZED' });
  }
};

const toInt = (value, fallback, { min = 1, max = 1000 } = {}) => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
};

const boolValue = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const normalizeScope = (scope = 'full_db') => {
  const normalized = String(scope || 'full_db').trim();
  if (!VALID_SCOPES.has(normalized)) {
    throw new AppError('Backup scope must be full_db or tenant', 400, { code: 'INVALID_BACKUP_SCOPE' });
  }
  return normalized;
};

const localBackupDir = () => {
  const configured = runtimeConfig.backup.localDir || 'db-backups';
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
};

const normalizeObjectPrefix = (value) =>
  String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');

const resolveBackupStorage = () => {
  const requestedProvider = String(runtimeConfig.backup.storageProvider || '').trim().toLowerCase();
  const provider = requestedProvider || (isS3Enabled() ? 's3' : 'local');
  if (!VALID_STORAGE_PROVIDERS.has(provider)) {
    throw new AppError('BACKUP_STORAGE_PROVIDER must be local or s3', 500, {
      code: 'INVALID_BACKUP_STORAGE_PROVIDER',
    });
  }
  const bucketName = String(
    runtimeConfig.backup.bucketName || runtimeConfig.media.s3.bucket || '',
  ).trim();
  return {
    provider,
    bucketName,
    prefix: normalizeObjectPrefix(runtimeConfig.backup.prefix || 'sanitation/backups'),
    configured: provider === 'local' || Boolean(bucketName && isS3Enabled()),
  };
};

const buildBackupObjectKey = ({ prefix, fileName, createdAt = new Date() }) => {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return [prefix, year, month, day, fileName].filter(Boolean).join('/');
};

const invalidateStorageUsageCache = () => {
  storageUsageCache = null;
};

const fileExists = async (filePath) => {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

const mapJob = (row) => ({
  id: row.id,
  scheduleId: row.schedule_id,
  scope: row.scope,
  tenantId: row.tenant_id,
  status: row.status,
  triggeredBy: row.triggered_by,
  requestedBy: row.requested_by,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  durationMs: row.duration_ms,
  filePath: row.file_path,
  fileName: row.file_name,
  fileSizeBytes: Number(row.file_size_bytes || 0),
  checksumSha256: row.checksum_sha256,
  errorMessage: row.error_message,
  metadata: row.metadata || {},
  rowCounts: row.metadata?.rowCounts || {},
  createdAt: row.created_at,
});

const activeBackupHeartbeatAt = (job) => {
  const progressUpdatedAt = job?.metadata?.progress?.updatedAt
    ? new Date(job.metadata.progress.updatedAt)
    : null;
  if (progressUpdatedAt && Number.isFinite(progressUpdatedAt.getTime())) return progressUpdatedAt;
  const startedAt = job?.started_at ? new Date(job.started_at) : null;
  if (startedAt && Number.isFinite(startedAt.getTime())) return startedAt;
  const createdAt = job?.created_at ? new Date(job.created_at) : null;
  return createdAt && Number.isFinite(createdAt.getTime()) ? createdAt : null;
};

const isStaleActiveBackupJob = (job, now = new Date(), staleMs = runtimeConfig.backup.staleActiveJobMs) => {
  if (!ACTIVE_BACKUP_STATUSES.includes(String(job?.status || '').toLowerCase())) return false;
  const heartbeatAt = activeBackupHeartbeatAt(job);
  if (!heartbeatAt) return false;
  return now.getTime() - heartbeatAt.getTime() > staleMs;
};

const failStaleActiveBackupJobs = async ({ now = new Date(), staleMs = runtimeConfig.backup.staleActiveJobMs } = {}) => {
  const oldestActiveCandidate = new Date(now.getTime() - staleMs);
  const candidates = await BackupJob.findAll({
    where: {
      status: { [Op.in]: ACTIVE_BACKUP_STATUSES },
      created_at: { [Op.lt]: oldestActiveCandidate },
    },
    order: [['created_at', 'ASC']],
  });
  let failed = 0;
  for (const job of candidates) {
    if (!isStaleActiveBackupJob(job, now, staleMs)) continue;
    const heartbeatAt = activeBackupHeartbeatAt(job);
    const completedAt = now;
    await job.update({
      status: 'failed',
      completed_at: completedAt,
      duration_ms: job.started_at ? completedAt.getTime() - new Date(job.started_at).getTime() : null,
      error_message: `Backup job marked failed because it had no progress heartbeat since ${heartbeatAt.toISOString()}`,
      metadata: {
        ...(job.metadata || {}),
        staleRecovery: {
          markedFailedAt: completedAt.toISOString(),
          staleAfterMs: staleMs,
          lastHeartbeatAt: heartbeatAt.toISOString(),
          previousStatus: job.status,
        },
        progress: {
          ...(job.metadata?.progress || {}),
          stage: 'failed',
          label: 'Backup failed: stale job recovered',
          updatedAt: completedAt.toISOString(),
        },
      },
    });
    failed += 1;
  }
  return { checkedAt: now, failed };
};

const mapSchedule = (row) => ({
  id: row.id,
  scope: row.scope,
  tenantId: row.tenant_id,
  frequency: row.frequency,
  cronExpression: row.cron_expression,
  timezone: row.timezone,
  runTime: row.run_time,
  timeFormat: normalizeTimeFormat(row.time_format || '24'),
  enabled: row.enabled,
  retentionDays: row.retention_days,
  includeStorageMetadata: row.include_storage_metadata,
  includeStorageFiles: row.include_storage_files,
  lastRunAt: row.last_run_at,
  nextRunAt: row.next_run_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const storageProviderForJob = (job) => {
  const metadataProvider = String(job?.metadata?.storageProvider || '').trim().toLowerCase();
  if (VALID_STORAGE_PROVIDERS.has(metadataProvider)) return metadataProvider;
  return String(job?.file_path || '').startsWith('s3://') ? 's3' : 'local';
};

const removeStoredBackupArtifact = async (job) => {
  const provider = storageProviderForJob(job);
  if (!job?.file_path) return true;
  if (provider === 's3') {
    return deleteObjectFromS3({
      storageKey: job.metadata?.objectKey || job.file_path,
      bucketName:
        job.metadata?.bucketName ||
        runtimeConfig.backup.bucketName ||
        runtimeConfig.media.s3.bucket,
    });
  }
  if (await fileExists(job.file_path)) {
    await fs.promises.unlink(job.file_path);
  }
  return true;
};

const audit = async (action, req, { job = null, schedule = null, details = {} } = {}) => {
  await BackupAuditLog.create({
    action,
    actor_user_id: getActorId(req),
    backup_job_id: job?.id || null,
    backup_schedule_id: schedule?.id || null,
    scope: job?.scope || schedule?.scope || null,
    tenant_id: job?.tenant_id || schedule?.tenant_id || null,
    ip_address: req.ip || null,
    user_agent: req.headers?.['user-agent'] || null,
    details,
  });
};

const whereForJobList = (query) => {
  const where = {};
  if (query.status && VALID_STATUSES.has(query.status)) where.status = query.status;
  if (query.scope && VALID_SCOPES.has(query.scope)) where.scope = query.scope;
  if (query.tenantId) where.tenant_id = query.tenantId;
  if (query.triggeredBy && VALID_TRIGGERS.has(query.triggeredBy)) where.triggered_by = query.triggeredBy;
  if (query.search) {
    where[Op.or] = [
      { file_name: { [Op.iLike]: `%${query.search}%` } },
      { id: { [Op.eq]: query.search } },
    ];
  }
  return where;
};

const tableNameForModel = (model) => {
  const table = model.getTableName();
  return typeof table === 'string' ? table : table?.tableName;
};

const exportOrderForModel = (model) => {
  const primaryKey = model.primaryKeyAttributes?.[0];
  if (primaryKey) return [[primaryKey, 'ASC']];
  if (model.rawAttributes?.created_at) return [['created_at', 'ASC']];
  return undefined;
};

const clampProgress = (value) => Math.max(0, Math.min(99, Math.floor(Number(value) || 0)));

const createBackupArtifact = async (job) => {
  const storage = resolveBackupStorage();
  if (!storage.configured) {
    throw new AppError(
      'S3 backup storage is selected but AWS region, bucket, or credentials are missing',
      500,
      { code: 'BACKUP_S3_NOT_CONFIGURED' },
    );
  }
  if (storage.provider === 'local') {
    await fs.promises.mkdir(localBackupDir(), { recursive: true });
  }
  const models = Object.values(sequelize.models)
    .filter((model) => {
      const tableName = tableNameForModel(model);
      return tableName && !BACKUP_TABLE_SKIP.has(tableName);
    })
    .sort((left, right) => String(tableNameForModel(left)).localeCompare(String(tableNameForModel(right))));

  const payload = {
    format: 'sanitation-solution-json-backup-v1',
    jobId: job.id,
    scope: job.scope,
    tenantId: job.tenant_id,
    createdAt: new Date().toISOString(),
    tables: {},
  };

  const rowCounts = {};
  const tenantScopedColumns = ['tenant_id', 'organization_id'];
  const pageSize = runtimeConfig.backup.exportPageSize || 1000;
  const plans = [];
  let totalRows = 0;
  let lastPersistedPercent = -1;

  const persistProgress = async (progress, { force = false } = {}) => {
    const percent = clampProgress(progress.percent);
    if (!force && percent <= lastPersistedPercent) return;
    lastPersistedPercent = percent;
    await job.update({
      metadata: {
        ...(job.metadata || {}),
        progressPercent: percent,
        progress: {
          ...progress,
          percent,
          updatedAt: new Date().toISOString(),
        },
      },
    });
  };

  await persistProgress({
    stage: 'planning',
    label: 'Scanning tables',
    percent: 1,
    tablesCompleted: 0,
    totalTables: 0,
    rowsExported: 0,
    totalRows: 0,
  }, { force: true });

  for (const model of models) {
    const tableName = tableNameForModel(model);
    const attributes = model.rawAttributes || {};
    const where = {};
    if (job.scope === 'tenant') {
      const tenantColumn = tenantScopedColumns.find((column) => attributes[column]);
      if (!tenantColumn) continue;
      where[tenantColumn] = job.tenant_id;
    }
    const rowCount = await model.count({ where });
    rowCounts[tableName] = rowCount;
    totalRows += rowCount;
    plans.push({ model, tableName, where, rowCount });
    payload.tables[tableName] = [];
  }

  await persistProgress({
    stage: 'exporting',
    label: 'Exporting database rows',
    percent: 2,
    currentTable: plans[0]?.tableName || null,
    tablesCompleted: 0,
    totalTables: plans.length,
    rowsExported: 0,
    totalRows,
  }, { force: true });

  let rowsExported = 0;
  let tablesCompleted = 0;

  for (const plan of plans) {
    const order = exportOrderForModel(plan.model);
    let offset = 0;

    if (plan.rowCount === 0) {
      tablesCompleted += 1;
      const percent = totalRows > 0
        ? 2 + ((rowsExported / totalRows) * 90)
        : 2 + ((tablesCompleted / Math.max(plans.length, 1)) * 90);
      await persistProgress({
        stage: 'exporting',
        label: 'Exporting database rows',
        percent,
        currentTable: plan.tableName,
        tablesCompleted,
        totalTables: plans.length,
        rowsExported,
        totalRows,
      }, { force: true });
      continue;
    }

    while (offset < plan.rowCount) {
      const rows = await plan.model.findAll({
        where: plan.where,
        raw: true,
        limit: pageSize,
        offset,
        ...(order ? { order } : {}),
      });
      payload.tables[plan.tableName].push(...rows);
      rowsExported += rows.length;
      offset += rows.length || pageSize;

      await persistProgress({
        stage: 'exporting',
        label: 'Exporting database rows',
        percent: 2 + ((rowsExported / Math.max(totalRows, 1)) * 90),
        currentTable: plan.tableName,
        tablesCompleted,
        totalTables: plans.length,
        rowsExported,
        totalRows,
      });

      if (rows.length === 0) break;
    }

    tablesCompleted += 1;
    await persistProgress({
      stage: 'exporting',
      label: 'Exporting database rows',
      percent: 2 + ((rowsExported / Math.max(totalRows, 1)) * 90),
      currentTable: plan.tableName,
      tablesCompleted,
      totalTables: plans.length,
      rowsExported,
      totalRows,
    }, { force: true });
  }

  await persistProgress({
    stage: 'serializing',
    label: 'Preparing JSON export',
    percent: 94,
    currentTable: null,
    tablesCompleted,
    totalTables: plans.length,
    rowsExported,
    totalRows,
  }, { force: true });
  const serialized = JSON.stringify(payload, null, 2);
  const innerFileName = `backup-${job.scope}-${new Date().toISOString().replace(/[:.]/g, '-')}-${job.id}.json`;
  await persistProgress({
    stage: 'compressing',
    label: 'Compressing ZIP archive',
    percent: 97,
    currentTable: null,
    tablesCompleted,
    totalTables: plans.length,
    rowsExported,
    totalRows,
  }, { force: true });
  const archiveBuffer = createZipBuffer([{ path: innerFileName, content: serialized, date: new Date() }]);
  const checksum = crypto.createHash('sha256').update(archiveBuffer).digest('hex');
  const fileName = innerFileName.replace(/\.json$/, '.zip');
  await persistProgress({
    stage: storage.provider === 's3' ? 'uploading' : 'writing',
    label: storage.provider === 's3' ? 'Uploading encrypted backup to S3' : 'Writing backup file',
    percent: 99,
    currentTable: null,
    tablesCompleted,
    totalTables: plans.length,
    rowsExported,
    totalRows,
  }, { force: true });

  let filePath = null;
  let objectKey = null;
  let bucketName = null;
  let storageMetadata = {};
  if (storage.provider === 's3') {
    objectKey = buildBackupObjectKey({
      prefix: storage.prefix,
      fileName,
      createdAt: new Date(),
    });
    const uploaded = await uploadBufferToS3({
      buffer: archiveBuffer,
      objectKey,
      contentType: 'application/zip',
      contentDisposition: `attachment; filename="${fileName}"`,
      bucketName: storage.bucketName,
      metadata: {
        backupjobid: String(job.id),
        backupscope: String(job.scope),
        checksumsha256: checksum,
      },
    });
    const verification = await headObjectFromS3(objectKey, {
      bucketName: storage.bucketName,
    });
    const uploadedChecksum = String(
      verification?.metadata?.checksumsha256 || '',
    ).trim().toLowerCase();
    const uploadVerified =
      Boolean(verification) &&
      Number(verification.contentLength || 0) === archiveBuffer.length &&
      uploadedChecksum === checksum.toLowerCase();
    if (!uploadVerified) {
      await deleteObjectFromS3({
        storageKey: objectKey,
        bucketName: storage.bucketName,
      }).catch(() => null);
      throw new AppError(
        'S3 upload verification failed; the previous backup was preserved',
        502,
        { code: 'BACKUP_S3_VERIFICATION_FAILED' },
      );
    }
    filePath = objectKey;
    bucketName = uploaded.bucket;
    storageMetadata = {
      objectKey,
      bucketName: uploaded.bucket,
      region: uploaded.region,
      eTag: uploaded.eTag,
      fileUrl: uploaded.fileUrl,
      uploadVerified: true,
      uploadVerifiedAt: new Date().toISOString(),
      uploadedContentLength: verification.contentLength,
      serverSideEncryption: verification.serverSideEncryption || null,
    };
  } else {
    filePath = path.join(localBackupDir(), fileName);
    await fs.promises.writeFile(filePath, archiveBuffer);
  }
  invalidateStorageUsageCache();
  return {
    fileName,
    filePath,
    objectKey,
    bucketName,
    storageProvider: storage.provider,
    sizeBytes: archiveBuffer.length,
    checksum,
    rowCounts,
    metadata: {
      archiveFormat: 'zip',
      contentType: 'application/zip',
      innerFileName,
      uncompressedBytes: Buffer.byteLength(serialized),
      ...storageMetadata,
    },
  };
};

const publishBackupStarted = async (job, req) => {
  try {
    const recipients = await resolvePlatformAdminIds();
    if (recipients.length === 0) return;
    const scheduled = job.triggered_by === 'scheduled';
    const scopeLabel = job.scope === 'tenant' ? 'Tenant backup' : 'Full database backup';
    await notificationService.publishNotification({
      recipients,
      eventType: 'backup.started',
      notificationType: NotificationTypes.SYSTEM,
      priority: NotificationPriorities.HIGH,
      title: 'Database backup started',
      body: `${scopeLabel} has started${scheduled ? ' from its schedule' : ''}.`,
      shortBody: `${scopeLabel} started`,
      entityType: 'backup_job',
      entityId: job.id,
      route: '/sa/backup',
      iconKey: 'database-backup',
      severity: 'info',
      audienceKind: NotificationAudienceKinds.TARGETED_LIST,
      createdByUserId: getActorId(req),
      dedupeKey: `backup-started:${job.id}`,
      metadata: {
        scope: job.scope,
        tenantId: job.tenant_id || null,
        triggeredBy: job.triggered_by,
        scheduleTimezone: job.metadata?.scheduleTimezone || null,
      },
      payload: {
        jobId: job.id,
        scheduleId: job.schedule_id || null,
        status: 'running',
      },
    });
  } catch (error) {
    logger.warn('Unable to publish backup-started notification', {
      backupJobId: job.id,
      error: error.message,
    });
  }
};

const runBackupJob = async (job, req) => {
  const startedAt = new Date();
  await job.update({ status: 'running', started_at: startedAt, error_message: null });
  await audit('backup_job_started', req, { job });
  void publishBackupStarted(job, req);
  try {
    const artifact = await createBackupArtifact(job);
    const completedAt = new Date();
    await job.update({
      status: 'success',
      completed_at: completedAt,
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      file_path: artifact.filePath,
      file_name: artifact.fileName,
      file_size_bytes: artifact.sizeBytes,
      checksum_sha256: artifact.checksum,
      metadata: {
        ...(job.metadata || {}),
        rowCounts: artifact.rowCounts,
        storageProvider: artifact.storageProvider,
        bucketName: artifact.bucketName,
        objectKey: artifact.objectKey,
        ...(artifact.metadata || {}),
        progressPercent: 100,
        progress: {
          ...(job.metadata?.progress || {}),
          stage: 'complete',
          label: 'Backup complete',
          percent: 100,
          updatedAt: completedAt.toISOString(),
        },
      },
    });
    await BackupFile.create({
      backup_job_id: job.id,
      storage_provider: artifact.storageProvider,
      bucket_name: artifact.bucketName,
      file_path: artifact.filePath,
      file_name: artifact.fileName,
      size_bytes: artifact.sizeBytes,
      checksum_sha256: artifact.checksum,
      content_type: artifact.metadata?.contentType || 'application/zip',
      metadata: {
        generatedAt: completedAt.toISOString(),
        objectKey: artifact.objectKey,
        ...(artifact.metadata || {}),
      },
    });
    await audit('backup_job_succeeded', req, { job, details: { fileName: artifact.fileName } });
    const latestOnlyPrune = await prunePreviousBackupArtifacts(job, req);
    try {
      await job.update({
        metadata: {
          ...(job.metadata || {}),
          latestOnlyRetention: {
            ...latestOnlyPrune,
            processedAt: new Date().toISOString(),
          },
        },
      });
    } catch (error) {
      logger.warn('Unable to persist latest-only backup cleanup summary', {
        backupJobId: job.id,
        error: error.message,
      });
    }
  } catch (error) {
    const completedAt = new Date();
    await job.update({
      status: 'failed',
      completed_at: completedAt,
      duration_ms: completedAt.getTime() - startedAt.getTime(),
      error_message: error.message,
      metadata: {
        ...(job.metadata || {}),
        failureCode: error.code || null,
        progress: {
          ...(job.metadata?.progress || {}),
          stage: 'failed',
          label: 'Backup failed',
          updatedAt: completedAt.toISOString(),
        },
      },
    });
    await audit('backup_job_failed', req, { job, details: { message: error.message } });
  }
  return BackupJob.findByPk(job.id);
};

const createAndRunJob = async (req, { schedule = null, triggeredBy = 'manual', sourceJob = null } = {}) => {
  const body = req.body || {};
  const scope = normalizeScope(schedule?.scope || sourceJob?.scope || body.scope || 'full_db');
  const tenantId = scope === 'tenant'
    ? (schedule?.tenant_id || sourceJob?.tenant_id || body.tenantId || null)
    : null;
  if (scope === 'tenant' && !tenantId) {
    throw new AppError('tenantId is required for tenant-scoped backup', 400, { code: 'BACKUP_TENANT_REQUIRED' });
  }

  const retentionDays = toInt(
    schedule?.retention_days || sourceJob?.metadata?.retentionDays || body.retentionDays,
    runtimeConfig.backup.defaultRetentionDays,
    { min: 1, max: 365 },
  );
  const job = await BackupJob.create({
    schedule_id: schedule?.id || null,
    scope,
    tenant_id: tenantId,
    status: 'queued',
    triggered_by: triggeredBy,
    requested_by: schedule?.created_by || getActorId(req),
    metadata: {
      retentionDays,
      scheduleTimezone: schedule?.timezone || null,
      includeStorageMetadata: boolValue(
        schedule?.include_storage_metadata ?? sourceJob?.metadata?.includeStorageMetadata ?? body.includeStorageMetadata,
        true,
      ),
      includeStorageFiles: boolValue(
        schedule?.include_storage_files ?? sourceJob?.metadata?.includeStorageFiles ?? body.includeStorageFiles,
        false,
      ),
      retriedFromJobId: sourceJob?.id || null,
    },
  });
  await audit('backup_job_queued', req, { job });
  return runBackupJob(job, req);
};

const calculateS3UsageSafe = async ({ prefix, bucketName }) => {
  try {
    return await calculateS3Usage({ prefix, bucketName });
  } catch (error) {
    return {
      bucketName,
      prefix,
      totalBytes: 0,
      objectCount: 0,
      error: error.message,
    };
  }
};

const getBackupStorageUsage = async ({ databaseTotal, successCount }) => {
  const now = Date.now();
  if (storageUsageCache && storageUsageCache.expiresAt > now) {
    return storageUsageCache.value;
  }
  const storage = resolveBackupStorage();
  if (storage.provider === 'local') {
    const value = {
      provider: 'local',
      backupPrefix: localBackupDir(),
      backupFolder: {
        totalBytes: Number(databaseTotal || 0),
        objectCount: Number(successCount || 0),
      },
    };
    storageUsageCache = { value, expiresAt: now + STORAGE_USAGE_CACHE_MS };
    return value;
  }
  if (!storage.configured) {
    return {
      provider: 's3',
      bucketName: storage.bucketName || null,
      backupPrefix: storage.prefix,
      error: 'S3 backup storage is not fully configured',
    };
  }

  const usagePrefix = normalizeObjectPrefix(runtimeConfig.backup.usagePrefix || 'sanitation');
  const [backupFolder, appFolder, bucket] = await Promise.all([
    calculateS3UsageSafe({ prefix: storage.prefix, bucketName: storage.bucketName }),
    calculateS3UsageSafe({ prefix: usagePrefix, bucketName: storage.bucketName }),
    runtimeConfig.backup.includeBucketUsage
      ? calculateS3UsageSafe({ prefix: '', bucketName: storage.bucketName })
      : Promise.resolve(null),
  ]);
  const value = {
    provider: 's3',
    bucketName: storage.bucketName,
    backupPrefix: storage.prefix,
    usagePrefix,
    backupFolder,
    appFolder,
    bucket,
  };
  storageUsageCache = { value, expiresAt: now + STORAGE_USAGE_CACHE_MS };
  return value;
};

const getStats = async (req) => {
  ensureSuperAdmin(req);
  await failStaleActiveBackupJobs();
  const [totalBackupCount, successCount, activeSchedules, lastSuccessfulBackup, nextScheduledBackup, storageTotal] =
    await Promise.all([
      BackupJob.count(),
      BackupJob.count({ where: { status: 'success' } }),
      BackupSchedule.count({ where: { enabled: true } }),
      BackupJob.findOne({ where: { status: 'success' }, order: [['completed_at', 'DESC']] }),
      BackupSchedule.findOne({ where: { enabled: true }, order: [['next_run_at', 'ASC']] }),
      BackupJob.sum('file_size_bytes', { where: { status: 'success' } }),
    ]);
  const storageUsage = await getBackupStorageUsage({
    databaseTotal: storageTotal,
    successCount,
  });
  return {
    totalBackupCount,
    successRate: totalBackupCount ? Math.round((successCount / totalBackupCount) * 100) : 0,
    activeSchedules,
    totalStorageUsed: Number(storageTotal || 0),
    databaseStorageTotal: Number(storageTotal || 0),
    lastSuccessfulBackup: lastSuccessfulBackup ? mapJob(lastSuccessfulBackup) : null,
    nextScheduledBackup: nextScheduledBackup ? mapSchedule(nextScheduledBackup) : null,
    storageUsage,
  };
};

const listJobs = async (req) => {
  ensureSuperAdmin(req);
  await failStaleActiveBackupJobs();
  const page = toInt(req.query.page, 1, { min: 1, max: 100000 });
  const limit = toInt(req.query.limit, 25, { min: 1, max: 100 });
  const where = whereForJobList(req.query || {});
  const { rows, count } = await BackupJob.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  return {
    items: rows.map(mapJob),
    meta: { page, limit, total: count, totalPages: Math.ceil(count / limit) || 1 },
  };
};

const triggerManualBackup = async (req) => {
  ensureSuperAdmin(req);
  const job = await createAndRunJob(req);
  return mapJob(job);
};

const getJobDetails = async (req) => {
  ensureSuperAdmin(req);
  await failStaleActiveBackupJobs();
  const job = await BackupJob.findByPk(req.params.id);
  if (!job) throw new AppError('Backup job not found', 404, { code: 'BACKUP_JOB_NOT_FOUND' });
  const logs = await BackupAuditLog.findAll({
    where: { backup_job_id: job.id },
    include: [{ model: PlatformUser, as: 'actor', attributes: ['id', 'full_name', 'email'], required: false }],
    order: [['created_at', 'ASC']],
  });
  return {
    ...mapJob(job),
    auditTrail: logs.map((log) => ({
      id: log.id,
      action: log.action,
      actorUserId: log.actor_user_id,
      actorName: log.actor?.full_name || log.actor?.email || null,
      details: log.details || {},
      createdAt: log.created_at,
    })),
  };
};

const createDownloadUrl = async (req) => {
  ensureSuperAdmin(req);
  const job = await BackupJob.findByPk(req.params.id);
  if (!job || job.status !== 'success' || job.metadata?.cleanedUpAt) {
    throw new AppError('Backup file is not available', 404, { code: 'BACKUP_FILE_NOT_AVAILABLE' });
  }
  const provider = storageProviderForJob(job);
  await audit('backup_download_requested', req, { job });
  if (provider === 's3') {
    const bucketName = String(
      job.metadata?.bucketName ||
      runtimeConfig.backup.bucketName ||
      runtimeConfig.media.s3.bucket ||
      '',
    ).trim();
    const signedUrl = await getPresignedGetObjectUrl({
      storageKey: job.metadata?.objectKey || job.file_path,
      expiresInSeconds: runtimeConfig.backup.signedUrlTtlSec,
      bucketName,
    });
    if (!signedUrl) {
      throw new AppError('Unable to create S3 backup download URL', 503, {
        code: 'BACKUP_S3_DOWNLOAD_UNAVAILABLE',
      });
    }
    return {
      provider: 's3',
      signedUrl,
      expiresInSeconds: runtimeConfig.backup.signedUrlTtlSec,
    };
  }
  return {
    provider: 'local',
    signedUrl: `/api/v1/super-admin/backups/jobs/${job.id}/file`,
    expiresInSeconds: runtimeConfig.backup.signedUrlTtlSec,
  };
};

const downloadLocalFile = async (req, res) => {
  ensureSuperAdmin(req);
  const job = await BackupJob.findByPk(req.params.id);
  if (
    !job ||
    job.status !== 'success' ||
    storageProviderForJob(job) !== 'local' ||
    job.metadata?.cleanedUpAt ||
    !job.file_path ||
    !(await fileExists(job.file_path))
  ) {
    throw new AppError('Backup file is not available', 404, { code: 'BACKUP_FILE_NOT_AVAILABLE' });
  }
  await audit('backup_file_downloaded', req, { job });
  return new Promise((resolve, reject) => {
    res.download(job.file_path, job.file_name || path.basename(job.file_path), (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const retryBackup = async (req) => {
  ensureSuperAdmin(req);
  const sourceJob = await BackupJob.findByPk(req.params.id);
  if (!sourceJob) throw new AppError('Backup job not found', 404, { code: 'BACKUP_JOB_NOT_FOUND' });
  const job = await createAndRunJob(req, { sourceJob });
  return mapJob(job);
};

const cleanupExpiredBackups = async (req) => {
  ensureSuperAdmin(req);
  const jobs = await BackupJob.findAll({ where: { status: 'success' } });
  let checked = 0;
  let deleted = 0;
  const now = Date.now();
  for (const job of jobs) {
    checked += 1;
    if (job.metadata?.cleanedUpAt) continue;
    const retentionDays = toInt(job.metadata?.retentionDays, runtimeConfig.backup.defaultRetentionDays, { min: 1, max: 365 });
    const basis = job.completed_at || job.created_at;
    if (!basis || now - new Date(basis).getTime() < retentionDays * 24 * 60 * 60 * 1000) continue;
    const removed = await removeStoredBackupArtifact(job);
    if (!removed) continue;
    deleted += 1;
    await job.update({
      metadata: {
        ...(job.metadata || {}),
        cleanedUpAt: new Date().toISOString(),
        storageAvailable: false,
        cleanupReason: 'retention_expired',
      },
    });
    await audit('backup_file_cleaned_up', req, { job });
  }
  if (deleted > 0) invalidateStorageUsageCache();
  return { checked, deleted };
};

const listSchedules = async (req) => {
  ensureSuperAdmin(req);
  const rows = await BackupSchedule.findAll({ order: [['created_at', 'DESC']] });
  return rows.map(mapSchedule);
};

const upsertSchedule = async (req) => {
  ensureSuperAdmin(req);
  const body = req.body || {};
  const scope = normalizeScope(body.scope || 'full_db');
  const tenantId = scope === 'tenant' ? body.tenantId || null : null;
  if (scope === 'tenant' && !tenantId) {
    throw new AppError('tenantId is required for tenant-scoped schedule', 400, { code: 'BACKUP_TENANT_REQUIRED' });
  }
  if (tenantId) {
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }
  const runTime = normalizeRunTime(body.runTime);
  const actor = getActorId(req)
    ? await PlatformUser.findByPk(getActorId(req), { attributes: ['id', 'metadata'] })
    : null;
  const profileTimezone =
    actor?.metadata?.preferences?.timezone ||
    actor?.metadata?.accountPreferences?.timezone ||
    null;
  const timezone = normalizeScheduleTimezone(profileTimezone, {
    fallback: 'Asia/Kolkata',
  });
  const enabled = boolValue(body.enabled, true);
  const timeFormat =
    body.timeFormat === undefined ? null : normalizeTimeFormat(body.timeFormat);
  const payload = {
    scope,
    tenant_id: tenantId,
    frequency: 'daily',
    timezone,
    run_time: runTime,
    ...(timeFormat ? { time_format: timeFormat } : {}),
    enabled,
    retention_days: toInt(body.retentionDays, runtimeConfig.backup.defaultRetentionDays, { min: 1, max: 365 }),
    include_storage_metadata: boolValue(body.includeStorageMetadata, true),
    include_storage_files: boolValue(body.includeStorageFiles, false),
    updated_by: getActorId(req),
    updated_at: new Date(),
    next_run_at: enabled ? nextDailyRun(runTime, timezone) : null,
  };
  let schedule;
  if (req.params.id || body.id) {
    schedule = await BackupSchedule.findByPk(req.params.id || body.id);
    if (!schedule) throw new AppError('Backup schedule not found', 404, { code: 'BACKUP_SCHEDULE_NOT_FOUND' });
    await schedule.update(payload);
    await audit('backup_schedule_updated', req, { schedule });
  } else {
    schedule = await BackupSchedule.create({
      ...payload,
      time_format: timeFormat || '24',
      created_by: getActorId(req),
    });
    await audit('backup_schedule_created', req, { schedule });
  }
  return mapSchedule(schedule);
};

const deleteSchedule = async (req) => {
  ensureSuperAdmin(req);
  const schedule = await BackupSchedule.findByPk(req.params.id);
  if (!schedule) throw new AppError('Backup schedule not found', 404, { code: 'BACKUP_SCHEDULE_NOT_FOUND' });
  await audit('backup_schedule_deleted', req, { schedule });
  await schedule.destroy();
  return { id: req.params.id, deleted: true };
};

const claimDueSchedule = async (schedule, now) => {
  const timezone = normalizeScheduleTimezone(schedule.timezone, {
    fallback: 'Asia/Kolkata',
  });
  const nextRunAt = nextDailyRun(schedule.run_time || '02:00:00', timezone, now);
  const dueCondition = schedule.next_run_at
    ? { next_run_at: { [Op.lte]: now } }
    : { next_run_at: null };
  const [claimed] = await BackupSchedule.update(
    {
      timezone,
      last_run_at: now,
      next_run_at: nextRunAt,
      updated_at: now,
    },
    {
      where: {
        id: schedule.id,
        enabled: true,
        ...dueCondition,
      },
    },
  );
  if (claimed !== 1) return false;
  await schedule.reload();
  return true;
};

const runBackupScheduleSweep = async (req = {}) => {
  const now = new Date();
  await failStaleActiveBackupJobs({ now });
  const schedules = await BackupSchedule.findAll({
    where: {
      enabled: true,
      [Op.or]: [{ next_run_at: null }, { next_run_at: { [Op.lte]: now } }],
    },
    order: [['next_run_at', 'ASC']],
  });
  const results = [];
  for (const schedule of schedules) {
    if (!(await claimDueSchedule(schedule, now))) continue;
    const job = await createAndRunJob(req, { schedule, triggeredBy: 'scheduled' });
    results.push(mapJob(job));
  }
  return { checkedAt: now, processed: results.length, jobs: results };
};

const reconcileBackupScheduleTimes = async (now = new Date()) => {
  return sequelize.transaction(async (transaction) => {
    const schedules = await BackupSchedule.findAll({
      order: [['created_at', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    let updated = 0;
    let due = 0;
    for (const schedule of schedules) {
      const timezone = normalizeScheduleTimezone(schedule.timezone, {
        fallback: 'Asia/Kolkata',
      });
      let nextRunAt = null;
      if (schedule.enabled) {
        const upcoming = nextDailyRun(schedule.run_time || '02:00:00', timezone, now);
        const previous = previousDailyRun(schedule.run_time || '02:00:00', timezone, now);
        const configuredAt = schedule.updated_at
          ? new Date(schedule.updated_at)
          : schedule.created_at
            ? new Date(schedule.created_at)
            : null;
        const lastRunAt = schedule.last_run_at ? new Date(schedule.last_run_at) : null;
        const wasConfiguredBeforePrevious =
          !configuredAt || configuredAt.getTime() <= previous.getTime();
        const previousWasNotProcessed =
          !lastRunAt || lastRunAt.getTime() < previous.getTime();
        const missedRun = wasConfiguredBeforePrevious && previousWasNotProcessed;
        nextRunAt = missedRun ? previous : upcoming;
        if (missedRun) due += 1;
      }
      const existingNext = schedule.next_run_at
        ? new Date(schedule.next_run_at).getTime()
        : null;
      const nextTimestamp = nextRunAt ? nextRunAt.getTime() : null;
      if (schedule.timezone === timezone && existingNext === nextTimestamp) continue;
      await schedule.update({
        timezone,
        next_run_at: nextRunAt,
        updated_at: now,
      }, { transaction });
      updated += 1;
    }
    return { checked: schedules.length, updated, due };
  });
};

const prunePreviousBackupArtifacts = async (latestJob, req) => {
  if (
    storageProviderForJob(latestJob) !== 's3' ||
    latestJob.metadata?.uploadVerified !== true ||
    !latestJob.completed_at
  ) {
    return { checked: 0, deleted: 0, failed: 0, skipped: true };
  }

  try {
    const previousJobs = await BackupJob.findAll({
      where: {
        id: { [Op.ne]: latestJob.id },
        status: 'success',
        scope: latestJob.scope,
        tenant_id: latestJob.tenant_id || null,
        completed_at: { [Op.lt]: latestJob.completed_at },
      },
      order: [['completed_at', 'DESC']],
    });
    let deleted = 0;
    let failed = 0;
    for (const previousJob of previousJobs) {
      if (previousJob.metadata?.cleanedUpAt) continue;
      try {
        const removed = await removeStoredBackupArtifact(previousJob);
        if (!removed) {
          failed += 1;
          continue;
        }
        const removedAt = new Date().toISOString();
        await previousJob.update({
          metadata: {
            ...(previousJob.metadata || {}),
            cleanedUpAt: removedAt,
            storageAvailable: false,
            cleanupReason: 'superseded_by_verified_backup',
            supersededByJobId: latestJob.id,
          },
        });
        await audit('backup_file_superseded', req, {
          job: previousJob,
          details: {
            supersededByJobId: latestJob.id,
            verifiedLatestUpload: true,
          },
        });
        deleted += 1;
      } catch (error) {
        failed += 1;
        logger.warn('Unable to delete superseded backup artifact', {
          backupJobId: previousJob.id,
          supersededByJobId: latestJob.id,
          error: error.message,
        });
      }
    }
    if (deleted > 0) invalidateStorageUsageCache();
    return {
      checked: previousJobs.length,
      deleted,
      failed,
      skipped: false,
    };
  } catch (error) {
    logger.warn('Unable to prune previous backup artifacts', {
      backupJobId: latestJob.id,
      error: error.message,
    });
    return { checked: 0, deleted: 0, failed: 1, skipped: false, error: error.message };
  }
};

const runScheduledBackups = async (req) => {
  ensureCronAccess(req);
  return runBackupScheduleSweep(req);
};

module.exports = {
  getStats,
  listJobs,
  triggerManualBackup,
  getJobDetails,
  createDownloadUrl,
  downloadLocalFile,
  retryBackup,
  cleanupExpiredBackups,
  listSchedules,
  upsertSchedule,
  deleteSchedule,
  activeBackupHeartbeatAt,
  isStaleActiveBackupJob,
  failStaleActiveBackupJobs,
  reconcileBackupScheduleTimes,
  runBackupScheduleSweep,
  runScheduledBackups,
};
