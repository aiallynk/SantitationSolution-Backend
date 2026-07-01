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
const { runtimeConfig } = require('../../config/runtime');
const { createZipBuffer } = require('../../utils/simpleZip');

const VALID_SCOPES = new Set(['full_db', 'tenant']);
const VALID_STATUSES = new Set(['queued', 'running', 'success', 'failed', 'cancelled']);
const VALID_TRIGGERS = new Set(['manual', 'scheduled']);
const BACKUP_TABLE_SKIP = new Set(['backup_jobs', 'backup_files', 'backup_audit_logs']);

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

const normalizeRunTime = (value) => {
  const raw = String(value || '02:00:00').trim();
  if (/^\d{2}:\d{2}$/.test(raw)) return `${raw}:00`;
  if (/^\d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  throw new AppError('runTime must be HH:mm or HH:mm:ss', 400, { code: 'INVALID_BACKUP_RUN_TIME' });
};

const localBackupDir = () => {
  const configured = runtimeConfig.backup.localDir || 'db-backups';
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
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

const mapSchedule = (row) => ({
  id: row.id,
  scope: row.scope,
  tenantId: row.tenant_id,
  frequency: row.frequency,
  cronExpression: row.cron_expression,
  timezone: row.timezone,
  runTime: row.run_time,
  enabled: row.enabled,
  retentionDays: row.retention_days,
  includeStorageMetadata: row.include_storage_metadata,
  includeStorageFiles: row.include_storage_files,
  lastRunAt: row.last_run_at,
  nextRunAt: row.next_run_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

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

const nextDailyRun = (runTime = '02:00:00') => {
  const [hours, minutes, seconds] = normalizeRunTime(runTime).split(':').map((part) => Number(part));
  const next = new Date();
  next.setHours(hours, minutes, seconds, 0);
  if (next <= new Date()) next.setDate(next.getDate() + 1);
  return next;
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
  await fs.promises.mkdir(localBackupDir(), { recursive: true });
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
  const filePath = path.join(localBackupDir(), fileName);
  await persistProgress({
    stage: 'writing',
    label: 'Writing backup file',
    percent: 99,
    currentTable: null,
    tablesCompleted,
    totalTables: plans.length,
    rowsExported,
    totalRows,
  }, { force: true });
  await fs.promises.writeFile(filePath, archiveBuffer);
  const stats = await fs.promises.stat(filePath);
  return {
    fileName,
    filePath,
    sizeBytes: stats.size,
    checksum,
    rowCounts,
    metadata: {
      archiveFormat: 'zip',
      contentType: 'application/zip',
      innerFileName,
      uncompressedBytes: Buffer.byteLength(serialized),
    },
  };
};

const runBackupJob = async (job, req) => {
  const startedAt = new Date();
  await job.update({ status: 'running', started_at: startedAt, error_message: null });
  await audit('backup_job_started', req, { job });
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
        storageProvider: 'local',
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
      storage_provider: 'local',
      file_path: artifact.filePath,
      file_name: artifact.fileName,
      size_bytes: artifact.sizeBytes,
      checksum_sha256: artifact.checksum,
      content_type: artifact.metadata?.contentType || 'application/zip',
      metadata: { generatedAt: completedAt.toISOString(), ...(artifact.metadata || {}) },
    });
    await audit('backup_job_succeeded', req, { job, details: { fileName: artifact.fileName } });
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
    requested_by: getActorId(req),
    metadata: {
      retentionDays,
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

const getStats = async (req) => {
  ensureSuperAdmin(req);
  const [totalBackupCount, successCount, activeSchedules, lastSuccessfulBackup, nextScheduledBackup, storageTotal] =
    await Promise.all([
      BackupJob.count(),
      BackupJob.count({ where: { status: 'success' } }),
      BackupSchedule.count({ where: { enabled: true } }),
      BackupJob.findOne({ where: { status: 'success' }, order: [['completed_at', 'DESC']] }),
      BackupSchedule.findOne({ where: { enabled: true }, order: [['next_run_at', 'ASC']] }),
      BackupJob.sum('file_size_bytes', { where: { status: 'success' } }),
    ]);
  return {
    totalBackupCount,
    successRate: totalBackupCount ? Math.round((successCount / totalBackupCount) * 100) : 0,
    activeSchedules,
    totalStorageUsed: Number(storageTotal || 0),
    databaseStorageTotal: Number(storageTotal || 0),
    lastSuccessfulBackup: lastSuccessfulBackup ? mapJob(lastSuccessfulBackup) : null,
    nextScheduledBackup: nextScheduledBackup ? mapSchedule(nextScheduledBackup) : null,
    storageUsage: {
      provider: 'local',
      backupPrefix: localBackupDir(),
      backupFolder: {
        totalBytes: Number(storageTotal || 0),
        objectCount: successCount,
      },
    },
  };
};

const listJobs = async (req) => {
  ensureSuperAdmin(req);
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
  if (!job || job.status !== 'success') {
    throw new AppError('Backup file is not available', 404, { code: 'BACKUP_FILE_NOT_AVAILABLE' });
  }
  await audit('backup_download_requested', req, { job });
  return {
    provider: 'local',
    signedUrl: `/api/v1/super-admin/backups/jobs/${job.id}/file`,
    expiresInSeconds: runtimeConfig.backup.signedUrlTtlSec,
  };
};

const downloadLocalFile = async (req, res) => {
  ensureSuperAdmin(req);
  const job = await BackupJob.findByPk(req.params.id);
  if (!job || job.status !== 'success' || !job.file_path || !(await fileExists(job.file_path))) {
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
    const retentionDays = toInt(job.metadata?.retentionDays, runtimeConfig.backup.defaultRetentionDays, { min: 1, max: 365 });
    const basis = job.completed_at || job.created_at;
    if (!basis || now - new Date(basis).getTime() < retentionDays * 24 * 60 * 60 * 1000) continue;
    if (job.file_path && await fileExists(job.file_path)) {
      await fs.promises.unlink(job.file_path);
      deleted += 1;
    }
    await job.update({ metadata: { ...(job.metadata || {}), cleanedUpAt: new Date().toISOString() } });
    await audit('backup_file_cleaned_up', req, { job });
  }
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
  const payload = {
    scope,
    tenant_id: tenantId,
    frequency: 'daily',
    timezone: body.timezone || 'Asia/Kolkata',
    run_time: runTime,
    enabled: boolValue(body.enabled, true),
    retention_days: toInt(body.retentionDays, runtimeConfig.backup.defaultRetentionDays, { min: 1, max: 365 }),
    include_storage_metadata: boolValue(body.includeStorageMetadata, true),
    include_storage_files: boolValue(body.includeStorageFiles, false),
    updated_by: getActorId(req),
    updated_at: new Date(),
    next_run_at: nextDailyRun(runTime),
  };
  let schedule;
  if (req.params.id || body.id) {
    schedule = await BackupSchedule.findByPk(req.params.id || body.id);
    if (!schedule) throw new AppError('Backup schedule not found', 404, { code: 'BACKUP_SCHEDULE_NOT_FOUND' });
    await schedule.update(payload);
    await audit('backup_schedule_updated', req, { schedule });
  } else {
    schedule = await BackupSchedule.create({ ...payload, created_by: getActorId(req) });
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

const runScheduledBackups = async (req) => {
  ensureCronAccess(req);
  const now = new Date();
  const schedules = await BackupSchedule.findAll({
    where: {
      enabled: true,
      [Op.or]: [{ next_run_at: null }, { next_run_at: { [Op.lte]: now } }],
    },
    order: [['next_run_at', 'ASC']],
  });
  const results = [];
  for (const schedule of schedules) {
    const job = await createAndRunJob(req, { schedule, triggeredBy: 'scheduled' });
    await schedule.update({ last_run_at: new Date(), next_run_at: nextDailyRun(schedule.run_time || '02:00:00') });
    results.push(mapJob(job));
  }
  return { checkedAt: now, processed: results.length, jobs: results };
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
  runScheduledBackups,
};
