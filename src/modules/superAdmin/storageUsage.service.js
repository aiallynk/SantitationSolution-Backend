'use strict';

const { Op } = require('sequelize');
const {
  Tenant,
  Inspection,
  InspectionMedia,
} = require('../../models');
const AppError = require('../../core/errors/AppError');
const { logger } = require('../../core/logging/logger');
const {
  calculateS3Usage,
  calculateS3UsageByTenantPrefix,
  getS3Config,
  headObjectFromS3,
  normalizeS3ObjectKey,
} = require('../media/s3.service');
const { deriveObjectKeyFromUrl } = require('../media/mediaUrl.service');

const SUCCESSFUL_UPLOAD_STATUSES = ['confirmed', 'uploaded'];
const DEFAULT_TENANT_PREFIX_BASE = 'sanitation/';

const toFiniteNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / Math.pow(1024, index);

  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 2)} ${units[index]}`;
}

function getErrorStatusCode(error) {
  return Number(error?.$metadata?.httpStatusCode || error?.statusCode || error?.status || 0);
}

function resolveS3UsageErrorCode(error, operation = 'list') {
  const awsCode = String(error?.Code || error?.code || error?.name || '').trim();
  const statusCode = getErrorStatusCode(error);
  const lowerMessage = String(error?.message || '').toLowerCase();

  if (
    awsCode === 'AccessDenied' ||
    awsCode === 'AccessDeniedException' ||
    statusCode === 403 ||
    lowerMessage.includes('access denied')
  ) {
    return operation === 'head' ? 'S3_HEAD_PERMISSION_DENIED' : 'S3_LIST_PERMISSION_DENIED';
  }
  if (awsCode === 'NoSuchBucket' || (statusCode === 404 && lowerMessage.includes('bucket'))) {
    return 'S3_BUCKET_NOT_FOUND';
  }
  if (
    awsCode === 'CredentialsProviderError' ||
    awsCode === 'UnrecognizedClientException' ||
    awsCode === 'InvalidAccessKeyId' ||
    lowerMessage.includes('could not load credentials') ||
    lowerMessage.includes('missing credentials')
  ) {
    return 'S3_CREDENTIALS_MISSING';
  }
  if (awsCode === 'AuthorizationHeaderMalformed' || lowerMessage.includes('region')) {
    return 'S3_REGION_MISMATCH';
  }
  return 'S3_USAGE_CALCULATION_FAILED';
}

function throwS3UsageError(error, operation = 'list') {
  if (error instanceof AppError) {
    throw error;
  }

  const code = resolveS3UsageErrorCode(error, operation);
  const statusCode = ['S3_LIST_PERMISSION_DENIED', 'S3_HEAD_PERMISSION_DENIED'].includes(code) ? 403 : 500;
  throw new AppError('Unable to calculate S3 usage', statusCode, {
    code,
    details: {
      errorCode: code,
      operation,
      awsErrorCode: error?.Code || error?.code || error?.name || null,
      awsStatusCode: getErrorStatusCode(error) || null,
      message: error?.message || null,
    },
  });
}

function assertS3UsageConfigured() {
  const config = getS3Config();
  const missing = [];

  if (!config.region) missing.push('AWS_REGION');
  if (!config.bucket) missing.push('AWS_S3_BUCKET or AWS_S3_BUCKET_NAME or S3_BUCKET');

  if (missing.length > 0) {
    throw new AppError('Unable to calculate S3 usage', 500, {
      code: 'S3_USAGE_CONFIG_MISSING',
      details: {
        errorCode: 'S3_USAGE_CONFIG_MISSING',
        missing,
      },
    });
  }

  if (!config.enabled) {
    throw new AppError('Unable to calculate S3 usage', 500, {
      code: 'S3_CREDENTIALS_MISSING',
      details: {
        errorCode: 'S3_CREDENTIALS_MISSING',
        message: 'Configure AWS credentials or attach an IAM role to the deployed backend.',
      },
    });
  }

  return config;
}

function buildS3UsageWarning(error, operation = 'list') {
  if (error instanceof AppError) {
    return {
      code: error.code || error.details?.errorCode || 'S3_USAGE_UNAVAILABLE',
      operation,
      message: error.details?.message || error.message || 'S3 usage is unavailable; using database media records.',
      missing: error.details?.missing || undefined,
      awsErrorCode: error.details?.awsErrorCode || null,
      awsStatusCode: error.details?.awsStatusCode || null,
    };
  }

  const code = resolveS3UsageErrorCode(error, operation);
  return {
    code,
    operation,
    message: error?.message || 'S3 usage is unavailable; using database media records.',
    awsErrorCode: error?.Code || error?.code || error?.name || null,
    awsStatusCode: getErrorStatusCode(error) || null,
  };
}

function dbOnlyTenantUsagePayload({ tenantId, dbUsage, warning = null, bucket = null, prefix = null }) {
  const safeDbUsage = { ...(dbUsage || {}) };
  delete safeDbUsage.objects;
  const totalBytes = toFiniteNumber(safeDbUsage.totalBytes);
  const objectCount = toFiniteNumber(safeDbUsage.objectCount);
  const lastCalculatedAt = new Date().toISOString();

  return {
    success: true,
    scope: 'tenant',
    tenantId,
    bucket,
    prefix: prefix || tenantPrefix(tenantId),
    totalBytes,
    formattedSize: safeDbUsage.formattedSize || formatBytes(totalBytes),
    objectCount,
    source: 'db_media_records',
    storageWarning: warning,
    dbUsage: {
      ...safeDbUsage,
      formattedSize: formatBytes(totalBytes),
    },
    prefixUsage: null,
    latestModifiedAt: safeDbUsage.latestUploadAt || null,
    lastCalculatedAt,
  };
}

function buildPlatformTenantRows({
  tenantIds,
  tenantNameMap,
  dbMap,
  prefixMap = new Map(),
  bucket = null,
  forceDbSource = false,
}) {
  return tenantIds
    .map((tenantId) => {
      const tenant = tenantNameMap.get(tenantId) || {};
      const chosen = chooseTenantUsageSource({
        tenantId,
        dbUsage: dbMap.get(tenantId),
        prefixUsage: prefixMap.get(tenantId),
      });
      const totalBytes = toFiniteNumber(chosen.totalBytes);
      const source = forceDbSource ? 'db_media_records' : chosen.source;

      return {
        tenantId,
        tenantName: tenant.name || null,
        tenantCode: tenant.code || null,
        bucket,
        prefix: chosen.prefix || tenantPrefix(tenantId),
        totalBytes,
        usedBytes: totalBytes,
        formattedSize: chosen.formattedSize || formatBytes(totalBytes),
        objectCount: toFiniteNumber(chosen.objectCount),
        source,
        dbMissingSizeCount: toFiniteNumber(chosen.dbMissingSizeCount || chosen.missingSizeCount),
        latestModifiedAt: chosen.latestModifiedAt || chosen.latestUploadAt || null,
      };
    })
    .filter((row) => row.totalBytes > 0 || row.objectCount > 0 || row.dbMissingSizeCount > 0)
    .sort((a, b) => b.totalBytes - a.totalBytes);
}

function summarizePlatformTenantRows(tenantRows) {
  let latestModifiedAt = null;

  for (const row of tenantRows || []) {
    if (row.latestModifiedAt && (!latestModifiedAt || row.latestModifiedAt > latestModifiedAt)) {
      latestModifiedAt = row.latestModifiedAt;
    }
  }

  return {
    totalBytes: (tenantRows || []).reduce((sum, row) => sum + toFiniteNumber(row.totalBytes), 0),
    objectCount: (tenantRows || []).reduce((sum, row) => sum + toFiniteNumber(row.objectCount), 0),
    latestModifiedAt,
  };
}

function buildPlatformUsagePayload({
  tenantRows,
  bucket = null,
  bucketUsage = null,
  tenantPrefixUsage = null,
  warning = null,
}) {
  const tenantTotals = summarizePlatformTenantRows(tenantRows);
  const totalBytes = bucketUsage?.totalBytes ?? tenantTotals.totalBytes;
  const objectCount = bucketUsage?.objectCount ?? tenantTotals.objectCount;

  return {
    success: true,
    scope: 'platform',
    bucket,
    prefix: '',
    totalBytes,
    usedBytes: totalBytes,
    formattedSize: formatBytes(totalBytes),
    objectCount,
    latestModifiedAt: bucketUsage?.latestModifiedAt || tenantTotals.latestModifiedAt,
    lastCalculatedAt: new Date().toISOString(),
    tenantPrefixBase: DEFAULT_TENANT_PREFIX_BASE,
    tenants: tenantRows,
    source: bucketUsage ? 's3_bucket' : 'db_media_records',
    storageWarning: warning,
    pagination: {
      pageCount: bucketUsage?.pageCount || 0,
      tenantPrefixPageCount: tenantPrefixUsage?.pageCount || 0,
      truncated: Boolean(bucketUsage?.truncated || tenantPrefixUsage?.truncated),
    },
  };
}

function ensureSuperAdmin(req) {
  if (!req.user?.isSuperAdmin) {
    throw new AppError('Only super admin can access this endpoint', 403, { code: 'SUPER_ADMIN_ONLY' });
  }
}

function tenantPrefix(tenantId) {
  return `${DEFAULT_TENANT_PREFIX_BASE}${tenantId}/`;
}

function getRowValue(row, key) {
  if (!row) return null;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  if (typeof row.get === 'function') return row.get(key);
  return null;
}

function getRowTenantId(row) {
  return (
    getRowValue(row, 'tenant_id') ||
    row?.Inspection?.tenant_id ||
    row?.Inspection?.get?.('tenant_id') ||
    row?.inspection?.tenant_id ||
    null
  );
}

function positiveByteValue(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function resolveMediaSize(row) {
  const metadata = getRowValue(row, 'metadata') || {};
  return positiveByteValue(
    getRowValue(row, 'content_length'),
    metadata.bytes,
    metadata.contentLength,
    metadata.content_length,
    metadata.fileSize,
    metadata.size
  );
}

function resolveMediaObjectKey(row) {
  const metadata = getRowValue(row, 'metadata') || {};
  const storageKey =
    getRowValue(row, 'storage_key') ||
    metadata.storageKey ||
    metadata.objectKey ||
    metadata.s3Key ||
    metadata.key ||
    '';
  const normalizedStorageKey = normalizeS3ObjectKey(storageKey);
  if (normalizedStorageKey) return normalizedStorageKey;

  return deriveObjectKeyFromUrl(getRowValue(row, 'file_url')) || '';
}

function resolveLatestUploadAt(row) {
  const candidates = [
    getRowValue(row, 'uploaded_at'),
    getRowValue(row, 'updated_at'),
    getRowValue(row, 'created_at'),
  ];
  for (const value of candidates) {
    if (!value) continue;
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function summarizeMediaRowsForStorage(rows, { tenantId = null, includeObjectDetails = false } = {}) {
  const byTenant = new Map();

  for (const row of rows || []) {
    const resolvedTenantId = String(tenantId || getRowTenantId(row) || '').trim();
    if (!resolvedTenantId) continue;

    const current = byTenant.get(resolvedTenantId) || {
      tenantId: resolvedTenantId,
      totalBytes: 0,
      objectCount: 0,
      recordCount: 0,
      missingSizeCount: 0,
      missingStorageKeyCount: 0,
      latestUploadAt: null,
      objects: new Map(),
    };

    current.recordCount += 1;
    const metadata = getRowValue(row, 'metadata') || {};
    if (String(metadata.provider || '').toLowerCase() === 'local') {
      byTenant.set(resolvedTenantId, current);
      continue;
    }

    const objectKey = resolveMediaObjectKey(row);
    if (!objectKey) {
      current.missingStorageKeyCount += 1;
      byTenant.set(resolvedTenantId, current);
      continue;
    }

    const bytes = resolveMediaSize(row);
    const latestUploadAt = resolveLatestUploadAt(row);
    const existing = current.objects.get(objectKey);
    if (!existing) {
      current.objects.set(objectKey, { objectKey, bytes, latestUploadAt });
    } else {
      if (bytes != null) {
        existing.bytes = existing.bytes == null ? bytes : Math.max(existing.bytes, bytes);
      }
      if (latestUploadAt && (!existing.latestUploadAt || latestUploadAt > existing.latestUploadAt)) {
        existing.latestUploadAt = latestUploadAt;
      }
    }
    if (latestUploadAt && (!current.latestUploadAt || latestUploadAt > current.latestUploadAt)) {
      current.latestUploadAt = latestUploadAt;
    }

    byTenant.set(resolvedTenantId, current);
  }

  return [...byTenant.values()].map((summary) => {
    let totalBytes = 0;
    let missingSizeCount = 0;
    for (const object of summary.objects.values()) {
      if (object.bytes == null) {
        missingSizeCount += 1;
      } else {
        totalBytes += Number(object.bytes || 0);
      }
    }

    const payload = {
      tenantId: summary.tenantId,
      totalBytes,
      formattedSize: formatBytes(totalBytes),
      objectCount: summary.objects.size,
      recordCount: summary.recordCount,
      missingSizeCount,
      missingStorageKeyCount: summary.missingStorageKeyCount,
      latestUploadAt: summary.latestUploadAt,
      source: 'db_media_records',
    };

    if (includeObjectDetails) {
      payload.objects = [...summary.objects.values()];
    }

    return payload;
  });
}

function applyHeadObjectSizes(summary, headResults) {
  if (!summary?.objects) return summary;
  const byKey = new Map((headResults || []).map((item) => [item.objectKey, item]));
  const rows = summary.objects.map((object) => {
    const head = byKey.get(object.objectKey);
    return {
      ...object,
      bytes: object.bytes ?? positiveByteValue(head?.contentLength),
      latestUploadAt:
        object.latestUploadAt ||
        (head?.lastModified ? new Date(head.lastModified).toISOString() : null),
    };
  });

  return summarizeMediaRowsForStorage(
    rows.map((row) => ({
      tenant_id: summary.tenantId,
      storage_key: row.objectKey,
      content_length: row.bytes,
      uploaded_at: row.latestUploadAt,
      metadata: {},
    })),
    { tenantId: summary.tenantId, includeObjectDetails: true }
  )[0] || summary;
}

function chooseTenantUsageSource({ dbUsage, prefixUsage, tenantId }) {
  const db = dbUsage || {
    tenantId,
    totalBytes: 0,
    objectCount: 0,
    missingSizeCount: 0,
    source: 'db_media_records',
  };
  const prefix = prefixUsage || {
    tenantId,
    totalBytes: 0,
    objectCount: 0,
    prefix: tenantPrefix(tenantId),
    source: 's3_prefix',
  };

  if (db.objectCount > 0 && Number(db.missingSizeCount || 0) === 0 && db.totalBytes > 0) {
    return {
      ...db,
      source: 'db_media_records',
      prefix: prefix.prefix || tenantPrefix(tenantId),
    };
  }

  if (prefix.totalBytes > 0 || prefix.objectCount > 0) {
    return {
      ...prefix,
      tenantId,
      formattedSize: formatBytes(prefix.totalBytes),
      source: 's3_prefix',
      dbTotalBytes: db.totalBytes,
      dbObjectCount: db.objectCount,
      dbMissingSizeCount: db.missingSizeCount,
    };
  }

  return {
    ...db,
    tenantId,
    formattedSize: formatBytes(db.totalBytes),
    prefix: prefix.prefix || tenantPrefix(tenantId),
  };
}

async function calculateUsageOrThrow({ prefix = '', tenantId = null, operation = 'list' } = {}) {
  const config = assertS3UsageConfigured();
  try {
    const usage = await calculateS3Usage({
      bucketName: config.bucket,
      prefix,
    });
    if (!usage) {
      throw new AppError('Unable to calculate S3 usage', 500, {
        code: 'S3_CREDENTIALS_MISSING',
        details: {
          errorCode: 'S3_CREDENTIALS_MISSING',
          message: 'S3 client was not created. Configure AWS credentials or IAM role for the backend.',
        },
      });
    }
    logger.debug('[S3_USAGE] calculated', {
      bucket: config.bucket,
      prefix,
      tenantId,
      objects: usage.objectCount,
      totalBytes: usage.totalBytes,
    });
    return usage;
  } catch (error) {
    throwS3UsageError(error, operation);
  }
}

async function calculateTenantDbUsage(tenantId, { includeObjectDetails = false } = {}) {
  const rows = await InspectionMedia.findAll({
    attributes: [
      'id',
      'storage_key',
      'file_url',
      'content_length',
      'metadata',
      'uploaded_at',
      'updated_at',
      'created_at',
    ],
    where: {
      upload_status: { [Op.in]: SUCCESSFUL_UPLOAD_STATUSES },
      [Op.or]: [
        { storage_key: { [Op.ne]: null } },
        { file_url: { [Op.ne]: null } },
      ],
    },
    include: [
      {
        model: Inspection,
        attributes: ['tenant_id'],
        where: { tenant_id: tenantId },
        required: true,
      },
    ],
  });

  return summarizeMediaRowsForStorage(rows, { tenantId, includeObjectDetails })[0] || {
    tenantId,
    totalBytes: 0,
    formattedSize: '0 B',
    objectCount: 0,
    recordCount: 0,
    missingSizeCount: 0,
    missingStorageKeyCount: 0,
    latestUploadAt: null,
    source: 'db_media_records',
    objects: includeObjectDetails ? [] : undefined,
  };
}

async function calculateTenantDbUsageWithHeadFallback(tenantId) {
  const dbUsage = await calculateTenantDbUsage(tenantId, { includeObjectDetails: true });
  const missingObjects = (dbUsage.objects || []).filter((object) => object.bytes == null);
  if (missingObjects.length === 0) return dbUsage;

  const headResults = [];
  for (const object of missingObjects) {
    try {
      const head = await headObjectFromS3(object.objectKey, { throwOnError: true });
      if (head?.contentLength != null) {
        headResults.push(head);
      }
    } catch (error) {
      const code = resolveS3UsageErrorCode(error, 'head');
      const statusCode = getErrorStatusCode(error);
      if (code === 'S3_HEAD_PERMISSION_DENIED' || statusCode === 403) {
        throwS3UsageError(error, 'head');
      }
      logger.warn('Unable to head S3 object while calculating tenant storage', {
        tenantId,
        objectKey: object.objectKey,
        code: error?.code || error?.name || null,
        message: error?.message || null,
      });
    }
  }

  return applyHeadObjectSizes(dbUsage, headResults);
}

async function calculateTenantStorageUsage(tenantId) {
  let config = null;
  let configWarning = null;
  try {
    config = assertS3UsageConfigured();
  } catch (error) {
    configWarning = buildS3UsageWarning(error, 'list');
  }
  const prefix = tenantPrefix(tenantId);
  const dbUsage = config
    ? await calculateTenantDbUsageWithHeadFallback(tenantId).catch(async (error) => {
        const code = resolveS3UsageErrorCode(error, 'head');
        if (code === 'S3_HEAD_PERMISSION_DENIED') {
          logger.warn('Falling back to DB media sizes because S3 head permission is unavailable', {
            tenantId,
            code,
          });
          return calculateTenantDbUsage(tenantId, { includeObjectDetails: true });
        }
        throw error;
      })
    : await calculateTenantDbUsage(tenantId, { includeObjectDetails: true });

  if (!config) {
    return dbOnlyTenantUsagePayload({
      tenantId,
      dbUsage,
      warning: configWarning,
      prefix,
    });
  }

  let prefixUsage = null;
  let warning = null;
  try {
    prefixUsage = await calculateUsageOrThrow({ prefix, tenantId });
  } catch (error) {
    warning = buildS3UsageWarning(error, 'list');
    logger.warn('Falling back to DB media storage usage because S3 tenant prefix usage failed', {
      tenantId,
      code: warning.code,
      operation: warning.operation,
      awsStatusCode: warning.awsStatusCode,
    });
    return dbOnlyTenantUsagePayload({
      tenantId,
      dbUsage,
      warning,
      bucket: config.bucket,
      prefix,
    });
  }

  const chosen = chooseTenantUsageSource({ dbUsage, prefixUsage, tenantId });
  const totalBytes = toFiniteNumber(chosen.totalBytes);
  const objectCount = toFiniteNumber(chosen.objectCount);
  const lastCalculatedAt = new Date().toISOString();

  logger.debug('[S3_USAGE] tenant usage selected', {
    bucket: config.bucket,
    prefix,
    tenantId,
    objects: objectCount,
    totalBytes,
    source: chosen.source,
  });

  const safeDbUsage = { ...dbUsage };
  delete safeDbUsage.objects;
  return {
    success: true,
    scope: 'tenant',
    tenantId,
    bucket: config.bucket,
    prefix,
    totalBytes,
    formattedSize: chosen.formattedSize || formatBytes(totalBytes),
    objectCount,
    source: chosen.source,
    storageWarning: warning,
    dbUsage: {
      ...safeDbUsage,
      formattedSize: formatBytes(safeDbUsage.totalBytes || 0),
    },
    prefixUsage: prefixUsage ? {
      ...prefixUsage,
      formattedSize: formatBytes(prefixUsage.totalBytes || 0),
    } : null,
    latestModifiedAt: chosen.latestModifiedAt || prefixUsage?.latestModifiedAt || dbUsage.latestUploadAt || null,
    lastCalculatedAt,
  };
}

async function getTenantDbSummaries() {
  const rows = await InspectionMedia.findAll({
    attributes: [
      'id',
      'storage_key',
      'file_url',
      'content_length',
      'metadata',
      'uploaded_at',
      'updated_at',
      'created_at',
    ],
    where: {
      upload_status: { [Op.in]: SUCCESSFUL_UPLOAD_STATUSES },
      [Op.or]: [
        { storage_key: { [Op.ne]: null } },
        { file_url: { [Op.ne]: null } },
      ],
    },
    include: [
      {
        model: Inspection,
        attributes: ['tenant_id'],
        required: true,
      },
    ],
  });

  return summarizeMediaRowsForStorage(rows);
}

async function getPlatformStorageUsage(req) {
  ensureSuperAdmin(req);
  const tenants = await Tenant.findAll({
    attributes: ['id', 'name', 'code'],
    raw: true,
  });
  const tenantIds = tenants.map((tenant) => tenant.id);
  const dbSummaries = await getTenantDbSummaries();
  const dbMap = new Map((dbSummaries || []).map((row) => [row.tenantId, row]));
  const tenantNameMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  let config = null;
  let configWarning = null;

  try {
    config = assertS3UsageConfigured();
  } catch (error) {
    configWarning = buildS3UsageWarning(error, 'list');
  }

  if (!config) {
    const tenantRows = buildPlatformTenantRows({
      tenantIds,
      tenantNameMap,
      dbMap,
      bucket: null,
      forceDbSource: true,
    });

    logger.debug('[S3_USAGE] platform usage using DB media records', {
      reason: configWarning?.code || null,
      objects: tenantRows.reduce((sum, row) => sum + toFiniteNumber(row.objectCount), 0),
      totalBytes: tenantRows.reduce((sum, row) => sum + toFiniteNumber(row.totalBytes), 0),
      tenantCount: tenantRows.length,
    });

    return buildPlatformUsagePayload({
      tenantRows,
      warning: configWarning,
    });
  }

  try {
    const [bucketUsage, tenantPrefixUsage] = await Promise.all([
      calculateS3Usage({
        bucketName: config.bucket,
        prefix: '',
      }),
      calculateS3UsageByTenantPrefix({
        bucketName: config.bucket,
        basePrefix: DEFAULT_TENANT_PREFIX_BASE,
        knownTenantIds: tenantIds,
      }),
    ]);

    const prefixMap = new Map((tenantPrefixUsage?.tenants || []).map((row) => [row.tenantId, row]));

    const tenantRows = buildPlatformTenantRows({
      tenantIds,
      tenantNameMap,
      dbMap,
      prefixMap,
      bucket: config.bucket,
    });

    logger.debug('[S3_USAGE] platform usage calculated', {
      bucket: config.bucket,
      prefix: '',
      objects: bucketUsage.objectCount,
      totalBytes: bucketUsage.totalBytes,
      tenantCount: tenantRows.length,
    });

    return buildPlatformUsagePayload({
      tenantRows,
      bucket: config.bucket,
      bucketUsage,
      tenantPrefixUsage,
      warning: configWarning,
    });
  } catch (error) {
    const warning = buildS3UsageWarning(error, 'list');
    logger.warn('Falling back to DB media storage usage because S3 platform usage failed', {
      code: warning.code,
      operation: warning.operation,
      awsStatusCode: warning.awsStatusCode,
    });
    const tenantRows = buildPlatformTenantRows({
      tenantIds,
      tenantNameMap,
      dbMap,
      bucket: config.bucket,
      forceDbSource: true,
    });

    return buildPlatformUsagePayload({
      tenantRows,
      bucket: config.bucket,
      warning,
    });
  }
}

async function getSuperAdminTenantStorageUsage(req) {
  ensureSuperAdmin(req);
  const tenantId = req.params.id || req.params.tenantId;
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id'] });
  if (!tenant) {
    throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }
  return calculateTenantStorageUsage(tenantId);
}

async function getTenantStorageUsageForRequest(req) {
  const tenantId = req.user?.tenantId || req.user?.tenant_id || req.headers?.['x-tenant-id'];
  const normalizedTenantId = String(tenantId || '').trim();
  if (!normalizedTenantId) {
    throw new AppError('Tenant context is required', 403, { code: 'TENANT_CONTEXT_REQUIRED' });
  }
  return calculateTenantStorageUsage(normalizedTenantId);
}

module.exports = {
  SUCCESSFUL_UPLOAD_STATUSES,
  formatBytes,
  resolveS3UsageErrorCode,
  summarizeMediaRowsForStorage,
  chooseTenantUsageSource,
  calculateTenantStorageUsage,
  getPlatformStorageUsage,
  getSuperAdminTenantStorageUsage,
  getTenantStorageUsageForRequest,
};
