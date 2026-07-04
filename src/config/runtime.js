const path = require('path');
const dotenv = require('dotenv');
const { defaults } = require('./defaults');

dotenv.config({
  path: path.resolve(__dirname, '../../.env'),
  override: false,
  quiet: true,
});

const rawEnv = process.env;

const asText = (value, fallback = '') => {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : fallback;
};

const asBool = (value, fallback = false) => {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const asNumber = (value, fallback, options = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const min = Number.isFinite(options.min) ? options.min : null;
  const max = Number.isFinite(options.max) ? options.max : null;
  let next = parsed;
  if (min !== null && next < min) next = min;
  if (max !== null && next > max) next = max;
  return Number.isInteger(fallback) ? Math.trunc(next) : next;
};

const normalizeBaseUrl = (value) => {
  const normalized = asText(value, '');
  if (!normalized) return '';
  const withoutSlash = normalized.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(withoutSlash)) return '';
  return withoutSlash;
};

const isPlaceholderSecret = (value) => {
  const normalized = asText(value, '').toLowerCase();
  if (!normalized) return true;
  return (
    normalized.includes('change-me') ||
    normalized.includes('replace_with') ||
    normalized.includes('your_') ||
    normalized.includes('generate_') ||
    normalized === 'secret' ||
    normalized === 'password'
  );
};

const nodeEnv = asText(rawEnv.NODE_ENV, 'development').toLowerCase();
const isProduction = nodeEnv === 'production';
const defaultLogLevel = isProduction ? 'info' : 'debug';

const requestTimeoutMs = asNumber(rawEnv.SERVER_REQUEST_TIMEOUT_MS, 120_000, { min: 15_000 });
const headersTimeoutMs = Math.max(
  defaults.server.headersTimeoutMs,
  requestTimeoutMs + 1_000
);
const keepAliveTimeoutMs = defaults.server.keepAliveTimeoutMs;

const autoRunMigrations = isProduction ? false : true;
const autoRunMigrationsStrict = isProduction;

const deprecatedEnvKeys = [
  'DB_HOST',
  'DB_PORT',
  'DB_NAME',
  'DB_USER',
  'DB_PASS',
  'PUBLIC_FEEDBACK_PROTOCOL',
  'PUBLIC_FEEDBACK_HOST',
  'PUBLIC_FEEDBACK_PORT',
  'RENDER_EXTERNAL_URL',
  'JWT_ALGORITHM',
  'REDIS_REQUIRED_IN_PROD',
  'QUEUE_ATTEMPTS',
  'QUEUE_BACKOFF_MS',
  'QUEUE_REMOVE_ON_COMPLETE',
  'QUEUE_REMOVE_ON_FAIL',
  'QUEUE_DLQ_REMOVE_ON_COMPLETE',
  'QUEUE_DLQ_REMOVE_ON_FAIL',
  'QUEUE_WORKER_CONCURRENCY',
  'ANALYSIS_WORKER_CONCURRENCY',
  'ANALYSIS_INLINE_CONCURRENCY',
  'ANALYSIS_INLINE_QUEUE_MAX',
  'ANALYSIS_QUEUE_ATTEMPTS',
  'ANALYSIS_QUEUE_BACKOFF_MS',
  'ANALYSIS_QUEUE_REMOVE_COMPLETE',
  'ANALYSIS_DEDUP_WINDOW_MS',
  'ANALYSIS_INLINE_JOB_TIMEOUT_MS',
  'ANALYSIS_STALE_WATCHDOG_INTERVAL_MS',
  'ANALYSIS_PROCESSING_STALE_MS',
  'IMAGE_SESSION_RECONCILE_INTERVAL_MS',
  'IMAGE_SESSION_RECONCILE_BATCH_SIZE',
  'IMAGE_SESSION_RECONCILE_MAX_ATTEMPTS',
  'IMAGE_SESSION_STALE_MS',
  'SSE_HEARTBEAT_MS',
  'WS_HEARTBEAT_MS',
  'ANALYSIS_CONFIDENCE_THRESHOLD',
  'ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD',
  'ANALYSIS_REJECT_CONFIDENCE_THRESHOLD',
  'ANALYSIS_SCORE_SPREAD_GAIN',
  'ANALYSIS_ALWAYS_SCORE_ON_FAILURE',
  'ANALYSIS_BLUR_VARIANCE_MIN',
  'ANALYSIS_BRIGHTNESS_MIN',
  'ANALYSIS_BRIGHTNESS_MAX',
  'ANALYSIS_VALIDATION_MAX_DIMENSION',
  'ANALYSIS_FRAUD_SIMILARITY_THRESHOLD',
  'ANALYSIS_MEDIA_MAX_BYTES',
  'ANALYSIS_MEDIA_FETCH_TIMEOUT_MS',
  'IDEMPOTENCY_LOCK_MS',
  'IDEMPOTENCY_TTL_MS',
  'IDEMPOTENCY_RESPONSE_MAX_BYTES',
  'TEMP_FILE_JANITOR_INTERVAL_MS',
  'TEMP_FILE_JANITOR_MAX_DELETE_PER_RUN',
  'TEMP_FILE_MAX_AGE_MS',
  'TEMP_UPLOAD_SUBDIR',
  'ALERT_ODOR_PPM_THRESHOLD',
  'ALERT_AMMONIA_PPM_THRESHOLD',
  'ALERT_H2S_PPM_THRESHOLD',
  'ALERT_METHANE_PPM_THRESHOLD',
  'SERVER_HEADERS_TIMEOUT_MS',
  'SERVER_KEEPALIVE_TIMEOUT_MS',
  'QR_V2_SIGNING_SECRET',
  'SIM_API_BASE_URL',
  'SIM_USERNAME',
  'SIM_PASSWORD',
  'SIM_INTERVAL_MS',
  'SIM_DEVICE_LIMIT',
];

const runtimeConfig = Object.freeze({
  env: nodeEnv,
  isProduction,
  app: {
    port: asNumber(rawEnv.PORT, 5000, { min: 1, max: 65_535 }),
    trustProxy: asNumber(rawEnv.TRUST_PROXY, 1, { min: 0 }),
    apiDocsEnabled: asBool(rawEnv.API_DOCS_ENABLED, !isProduction),
    localMediaServeEnabled: asBool(rawEnv.LOCAL_MEDIA_SERVE_ENABLED, !isProduction),
    corsOrigin: asText(rawEnv.CORS_ORIGIN, ''),
    corsAllowAll: asBool(rawEnv.CORS_ALLOW_ALL, false),
    jsonBodyLimit: asText(rawEnv.JSON_BODY_LIMIT, '2mb'),
  },
  logging: {
    level: asText(rawEnv.LOG_LEVEL, defaultLogLevel).toLowerCase(),
    serviceName: asText(rawEnv.LOG_SERVICE_NAME, 'sanitation-backend'),
    /** `pretty` = short human lines (default in development). `json` = one-line JSON (default in production). */
    format: (() => {
      const v = asText(rawEnv.LOG_FORMAT, '').toLowerCase();
      if (v === 'pretty' || v === 'json') return v;
      return isProduction ? 'json' : 'pretty';
    })(),
    requestLoggingEnabled: defaults.logging.requestLoggingEnabled,
    requestLoggingVerbose: defaults.logging.requestLoggingVerbose,
    requestLoggingSlowMs: defaults.logging.requestLoggingSlowMs,
  },
  security: {
    rateLimitWindowMs: asNumber(rawEnv.RATE_LIMIT_WINDOW_MS, 60_000, { min: 1_000 }),
    rateLimitMax: asNumber(rawEnv.RATE_LIMIT_MAX, 300, { min: 10 }),
    supervisorRateLimitMax: asNumber(rawEnv.SUPERVISOR_RATE_LIMIT_MAX, 2000, { min: 50 }),
    ingestRateLimitMax: defaults.app.ingestRateLimitMax,
    sensorIngestRateLimitMax: asNumber(
      rawEnv.SENSOR_INGEST_RATE_LIMIT_MAX,
      defaults.app.sensorIngestRateLimitMax,
      { min: 60 }
    ),
  },
  server: {
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs,
    gracefulShutdownTimeoutMs: asNumber(rawEnv.GRACEFUL_SHUTDOWN_TIMEOUT_MS, 25_000, {
      min: 5_000,
    }),
    dbStartupMaxAttempts: defaults.server.dbStartupMaxAttempts,
    dbStartupRetryDelayMs: defaults.server.dbStartupRetryDelayMs,
    autoRunMigrations,
    autoRunMigrationsStrict,
    autoBackfillToiletQrOnBoot: defaults.server.autoBackfillToiletQrOnBoot,
    qrForceRegenerateOnBoot: defaults.server.qrForceRegenerateOnBoot,
    analysisBootStrict: defaults.server.analysisBootStrict,
    analysisWorkerEmbedded: defaults.server.analysisWorkerEmbedded,
  },
  database: {
    url: asText(rawEnv.DATABASE_URL, ''),
    ssl: asBool(rawEnv.DB_SSL, false),
    poolMax: asNumber(rawEnv.DB_POOL_MAX, 20, { min: 1, max: 200 }),
    poolMin: asNumber(rawEnv.DB_POOL_MIN, 2, { min: 0, max: 50 }),
    poolAcquire: 30_000,
    poolIdle: 10_000,
    poolEvict: 1_000,
    poolMaxUses: 5_000,
    queryTimeoutMs: asNumber(rawEnv.DB_QUERY_TIMEOUT_MS, 15_000, { min: 1_000 }),
    connectionTimeoutMs: asNumber(rawEnv.DB_CONNECTION_TIMEOUT_MS, 10_000, { min: 1_000 }),
    statementTimeoutMs: 15_000,
    idleInTxnTimeoutMs: 15_000,
    retryMax: 2,
    loggingEnabled: false,
  },
  auth: {
    jwtSecret: asText(rawEnv.JWT_SECRET, ''),
    jwtRefreshSecret: asText(rawEnv.JWT_REFRESH_SECRET, ''),
    jwtAlgorithm: 'HS256',
    accessTokenTtl: asText(rawEnv.JWT_ACCESS_EXPIRES_IN, '15m'),
    refreshTokenTtl: asText(rawEnv.JWT_REFRESH_EXPIRES_IN, '30d'),
    passwordResetTtlMs: asNumber(rawEnv.PASSWORD_RESET_TTL_MS, 900_000, { min: 60_000 }),
    qrV2SigningSecret: '',
  },
  urls: {
    apiPublicBaseUrl: normalizeBaseUrl(rawEnv.API_PUBLIC_BASE_URL),
    publicFeedbackBaseUrl: normalizeBaseUrl(
      rawEnv.PUBLIC_FEEDBACK_BASE_URL || rawEnv.API_PUBLIC_BASE_URL
    ),
  },
  media: {
    maxFileSizeBytes: asNumber(rawEnv.MEDIA_MAX_FILE_SIZE, 8 * 1024 * 1024, {
      min: 1 * 1024 * 1024,
      max: 30 * 1024 * 1024,
    }),
    s3FallbackToLocal: asBool(rawEnv.S3_FALLBACK_TO_LOCAL, !isProduction),
    s3PresignedPutTtlSec: asNumber(rawEnv.S3_PRESIGNED_URL_TTL_SEC, 900, { min: 60, max: 3_600 }),
    s3PresignedGetTtlSec: asNumber(rawEnv.S3_PRESIGNED_GET_TTL_SEC, 900, { min: 60, max: 3_600 }),
    s3ObjectMaxBufferBytes: defaults.media.s3ObjectMaxBufferBytes,
    uploadDiagnosticsLogsEnabled: defaults.media.uploadDiagnosticsLogsEnabled,
    tempUploadSubdir: defaults.media.tempUploadSubdir,
    tempFileJanitorEnabled: asBool(rawEnv.TEMP_FILE_JANITOR_ENABLED, true),
    tempFileJanitorIntervalMs: defaults.media.tempFileJanitorIntervalMs,
    tempFileMaxAgeMs: defaults.media.tempFileMaxAgeMs,
    tempFileJanitorMaxDeletePerRun: defaults.media.tempFileJanitorMaxDeletePerRun,
    cloudinary: {
      cloudName: asText(rawEnv.CLOUDINARY_CLOUD_NAME, ''),
      apiKey: asText(rawEnv.CLOUDINARY_API_KEY, ''),
      apiSecret: asText(rawEnv.CLOUDINARY_API_SECRET, ''),
    },
    s3: {
      region: asText(rawEnv.AWS_REGION, asText(rawEnv.AWS_DEFAULT_REGION, '')),
      bucket: asText(
        rawEnv.AWS_S3_BUCKET,
        asText(rawEnv.AWS_S3_BUCKET_NAME, asText(rawEnv.S3_BUCKET, asText(rawEnv.S3_BUCKET_NAME, '')))
      ),
      accessKeyId: asText(rawEnv.AWS_ACCESS_KEY_ID, ''),
      secretAccessKey: asText(rawEnv.AWS_SECRET_ACCESS_KEY, ''),
      sessionToken: asText(rawEnv.AWS_SESSION_TOKEN, ''),
      endpoint: asText(rawEnv.AWS_S3_ENDPOINT, ''),
      forcePathStyle: asBool(rawEnv.AWS_S3_FORCE_PATH_STYLE, false),
      publicBaseUrl: asText(rawEnv.AWS_S3_PUBLIC_BASE_URL, ''),
      objectAcl: asText(rawEnv.AWS_S3_OBJECT_ACL, ''),
      mediaUrlMode: asText(rawEnv.S3_MEDIA_URL_MODE, 'locator').toLowerCase(),
      enforcePrivateAcl: asBool(rawEnv.S3_ENFORCE_PRIVATE_ACL, true),
      serverSideEncryption: asText(rawEnv.AWS_S3_SERVER_SIDE_ENCRYPTION, 'AES256'),
      kmsKeyId: asText(rawEnv.AWS_S3_KMS_KEY_ID, ''),
      bucketKeyEnabled: asBool(rawEnv.AWS_S3_BUCKET_KEY_ENABLED, true),
    },
  },
  backup: {
    storageProvider: asText(
      rawEnv.BACKUP_STORAGE_PROVIDER,
      asText(rawEnv.AWS_S3_BUCKET, '') ? 's3' : 'local',
    ).toLowerCase(),
    bucketName: asText(rawEnv.BACKUP_BUCKET_NAME, asText(rawEnv.AWS_S3_BUCKET, '')),
    prefix: asText(rawEnv.BACKUP_STORAGE_PREFIX, 'sanitation/backups'),
    usagePrefix: asText(rawEnv.BACKUP_USAGE_PREFIX, 'sanitation'),
    includeBucketUsage: asBool(rawEnv.BACKUP_INCLUDE_BUCKET_USAGE, true),
    localDir: asText(rawEnv.BACKUP_LOCAL_DIR, 'db-backups'),
    signedUrlTtlSec: asNumber(rawEnv.BACKUP_SIGNED_URL_TTL_SEC, 600, { min: 60, max: 900 }),
    cronSecret: asText(rawEnv.BACKUP_CRON_SECRET, ''),
    schedulerIntervalMs: asNumber(rawEnv.BACKUP_SCHEDULER_INTERVAL_MS, 30_000, { min: 10_000 }),
    defaultRetentionDays: asNumber(rawEnv.BACKUP_RETENTION_DAYS, 7, { min: 1, max: 365 }),
    exportPageSize: asNumber(rawEnv.BACKUP_EXPORT_PAGE_SIZE, 1000, { min: 100, max: 5000 }),
  },
  redis: {
    enabled: asBool(rawEnv.REDIS_ENABLED, false),
    url: asText(rawEnv.REDIS_URL, ''),
    liveChannel: defaults.queue.redisLiveChannel,
    requiredInProduction: defaults.queue.redisRequiredInProduction,
  },
  queue: {
    attempts: defaults.queue.attempts,
    backoffMs: defaults.queue.backoffMs,
    removeOnComplete: defaults.queue.removeOnComplete,
    removeOnFail: defaults.queue.removeOnFail,
    dlqRemoveOnComplete: defaults.queue.dlqRemoveOnComplete,
    dlqRemoveOnFail: defaults.queue.dlqRemoveOnFail,
    workerConcurrency: defaults.queue.workerConcurrency,
    analysisWorkerConcurrency: defaults.queue.analysisWorkerConcurrency,
    analysisQueueAttempts: defaults.queue.analysisQueueAttempts,
    analysisQueueBackoffMs: defaults.queue.analysisQueueBackoffMs,
    analysisQueueRemoveOnComplete: defaults.queue.analysisQueueRemoveOnComplete,
    analysisInlineTimeoutMs: defaults.queue.analysisInlineTimeoutMs,
    analysisInlineConcurrency: defaults.queue.analysisInlineConcurrency,
    analysisInlineQueueMax: defaults.queue.analysisInlineQueueMax,
    analysisDedupWindowMs: defaults.queue.analysisDedupWindowMs,
    analysisStaleWatchdogIntervalMs: defaults.queue.analysisStaleWatchdogIntervalMs,
    analysisProcessingStaleMs: defaults.queue.analysisProcessingStaleMs,
  },
  idempotency: {
    lockMs: defaults.idempotency.lockMs,
    ttlMs: defaults.idempotency.ttlMs,
    responseMaxBytes: defaults.idempotency.responseMaxBytes,
  },
  publicApi: {
    defaultNearbyRadiusMeters: asNumber(rawEnv.PUBLIC_API_DEFAULT_RADIUS_METERS, 2000, {
      min: 50,
      max: 50000,
    }),
    maxNearbyRadiusMeters: asNumber(rawEnv.PUBLIC_API_MAX_RADIUS_METERS, 10000, {
      min: 100,
      max: 100000,
    }),
    defaultNearbyLimit: asNumber(rawEnv.PUBLIC_API_DEFAULT_LIMIT, 20, {
      min: 1,
      max: 1000,
    }),
    maxNearbyLimit: asNumber(rawEnv.PUBLIC_API_MAX_LIMIT, 100, {
      min: 1,
      max: 1000,
    }),
    cleanlinessStaleHours: asNumber(rawEnv.PUBLIC_API_CLEANLINESS_STALE_HOURS, 72, {
      min: 1,
      max: 2160,
    }),
    includeUnknownCleanlinessWhenMinZero: asBool(
      rawEnv.PUBLIC_API_INCLUDE_UNKNOWN_CLEANLINESS_WHEN_MIN_ZERO,
      true
    ),
    apiKeyHashSecret: asText(rawEnv.PUBLIC_API_KEY_HASH_SECRET, ''),
  },
  live: {
    sseHeartbeatMs: defaults.live.sseHeartbeatMs,
    wsHeartbeatMs: defaults.live.wsHeartbeatMs,
    serverId: '',
  },
  analysis: {
    provider: asText(rawEnv.ANALYSIS_PROVIDER, 'openai').toLowerCase(),
    triggerOnUpload: asBool(rawEnv.ANALYSIS_TRIGGER_ON_UPLOAD, true),
    openaiApiKey: asText(rawEnv.OPENAI_API_KEY, ''),
    openaiModel: asText(rawEnv.OPENAI_ANALYSIS_MODEL, 'gpt-4o-mini'),
    openaiBaseUrl: asText(rawEnv.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
    openaiTimeoutMs: asNumber(rawEnv.OPENAI_ANALYSIS_TIMEOUT_MS, 45_000, {
      min: 5_000,
      max: 180_000,
    }),
    openaiMaxImages: asNumber(rawEnv.OPENAI_ANALYSIS_MAX_IMAGES, 4, {
      min: 1,
      max: 12,
    }),
    confidenceThreshold: defaults.analysis.confidenceThreshold,
    reviewConfidenceThreshold: defaults.analysis.reviewConfidenceThreshold,
    rejectConfidenceThreshold: defaults.analysis.rejectConfidenceThreshold,
    scoreSpreadGain: defaults.analysis.scoreSpreadGain,
    alwaysScoreOnFailure: defaults.analysis.alwaysScoreOnFailure,
    blurVarianceMin: defaults.analysis.blurVarianceMin,
    brightnessMin: defaults.analysis.brightnessMin,
    brightnessMax: defaults.analysis.brightnessMax,
    validationMaxDimension: defaults.analysis.validationMaxDimension,
    fraudSimilarityThreshold: defaults.analysis.fraudSimilarityThreshold,
    mediaMaxBytes: defaults.analysis.mediaMaxBytes,
    mediaFetchTimeoutMs: defaults.analysis.mediaFetchTimeoutMs,
    aiImageMaxRetries: defaults.analysis.aiImageMaxRetries,
    aiRetryBaseDelayMs: defaults.analysis.aiRetryBaseDelayMs,
    jobLeaseMs: defaults.analysis.jobLeaseMs,
    improvementThreshold: defaults.analysis.improvementThreshold,
  },
  imageSession: {
    reconcileIntervalMs: defaults.imageSession.reconcileIntervalMs,
    reconcileBatchSize: defaults.imageSession.reconcileBatchSize,
    reconcileMaxAttempts: defaults.imageSession.reconcileMaxAttempts,
    staleMs: defaults.imageSession.staleMs,
  },
  diagnostics: {
    analysisStaleMs: defaults.diagnostics.analysisStaleMs,
    imageSessionStaleMs: defaults.diagnostics.imageSessionStaleMs,
  },
  alerts: {
    odorPpmThreshold: defaults.alerts.odorPpmThreshold,
    ammoniaPpmThreshold: defaults.alerts.ammoniaPpmThreshold,
    h2sPpmThreshold: defaults.alerts.h2sPpmThreshold,
    methanePpmThreshold: defaults.alerts.methanePpmThreshold,
    // BLE wand environmental thresholds (configurable via env; null disables a
    // bound). MQ channels stay disabled by default until calibrated.
    sensor: {
      temperature: {
        highWarningC: asNumber(rawEnv.SENSOR_TEMP_HIGH_WARNING_C, defaults.alerts.sensor.temperature.highWarningC),
        highCriticalC: asNumber(rawEnv.SENSOR_TEMP_HIGH_CRITICAL_C, defaults.alerts.sensor.temperature.highCriticalC),
        lowWarningC: asNumber(rawEnv.SENSOR_TEMP_LOW_WARNING_C, defaults.alerts.sensor.temperature.lowWarningC),
        lowCriticalC: asNumber(rawEnv.SENSOR_TEMP_LOW_CRITICAL_C, defaults.alerts.sensor.temperature.lowCriticalC),
      },
      humidity: {
        highWarningPct: asNumber(rawEnv.SENSOR_HUMIDITY_HIGH_WARNING_PCT, defaults.alerts.sensor.humidity.highWarningPct),
        highCriticalPct: asNumber(rawEnv.SENSOR_HUMIDITY_HIGH_CRITICAL_PCT, defaults.alerts.sensor.humidity.highCriticalPct),
        lowWarningPct: asNumber(rawEnv.SENSOR_HUMIDITY_LOW_WARNING_PCT, defaults.alerts.sensor.humidity.lowWarningPct),
        lowCriticalPct: asNumber(rawEnv.SENSOR_HUMIDITY_LOW_CRITICAL_PCT, defaults.alerts.sensor.humidity.lowCriticalPct),
      },
      mq135: {
        warning: asNumber(rawEnv.SENSOR_MQ135_WARNING, defaults.alerts.sensor.mq135.warning),
        critical: asNumber(rawEnv.SENSOR_MQ135_CRITICAL, defaults.alerts.sensor.mq135.critical),
      },
      mq137: {
        warning: asNumber(rawEnv.SENSOR_MQ137_WARNING, defaults.alerts.sensor.mq137.warning),
        critical: asNumber(rawEnv.SENSOR_MQ137_CRITICAL, defaults.alerts.sensor.mq137.critical),
      },
      battery: {
        lowWarningPct: asNumber(rawEnv.SENSOR_BATTERY_LOW_WARNING_PCT, defaults.alerts.sensor.battery.lowWarningPct),
        lowCriticalPct: asNumber(rawEnv.SENSOR_BATTERY_LOW_CRITICAL_PCT, defaults.alerts.sensor.battery.lowCriticalPct),
      },
      offline: {
        warningMinutes: asNumber(rawEnv.SENSOR_OFFLINE_WARNING_MINUTES, defaults.alerts.sensor.offline.warningMinutes),
        criticalMinutes: asNumber(rawEnv.SENSOR_OFFLINE_CRITICAL_MINUTES, defaults.alerts.sensor.offline.criticalMinutes),
      },
    },
  },
  automation: {
    criticalComplaintValues: asText(
      rawEnv.CRITICAL_COMPLAINT_VALUES,
      defaults.automation.criticalComplaintValues.join(',')
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    repeatedComplaintWindowMinutes: asNumber(
      rawEnv.CRITICAL_REPEATED_COMPLAINT_WINDOW_MINUTES,
      defaults.automation.repeatedComplaintWindowMinutes,
      { min: 1 }
    ),
    repeatedComplaintThreshold: asNumber(
      rawEnv.CRITICAL_REPEATED_COMPLAINT_THRESHOLD,
      defaults.automation.repeatedComplaintThreshold,
      { min: 2 }
    ),
    workerLocationFreshnessMinutes: asNumber(
      rawEnv.WORKER_LOCATION_FRESHNESS_MINUTES,
      defaults.automation.workerLocationFreshnessMinutes,
      { min: 1 }
    ),
    maxActiveTasksPerWorker: asNumber(
      rawEnv.WORKER_MAX_ACTIVE_TASKS,
      defaults.automation.maxActiveTasksPerWorker,
      { min: 1 }
    ),
    lowMobileBatteryThreshold: asNumber(
      rawEnv.WORKER_LOW_BATTERY_THRESHOLD,
      defaults.automation.lowMobileBatteryThreshold,
      { min: 0, max: 100 }
    ),
    assignmentRadiusKm: asNumber(
      rawEnv.WORKER_ASSIGNMENT_RADIUS_KM,
      defaults.automation.assignmentRadiusKm,
      { min: 0 }
    ),
    acceptReminderMinutes: asNumber(
      rawEnv.TASK_ACCEPT_REMINDER_MINUTES,
      defaults.automation.acceptReminderMinutes,
      { min: 1 }
    ),
    startReminderMinutes: asNumber(
      rawEnv.TASK_START_REMINDER_MINUTES,
      defaults.automation.startReminderMinutes,
      { min: 1 }
    ),
    slaWarningMinutes: asNumber(
      rawEnv.TASK_SLA_WARNING_MINUTES,
      defaults.automation.slaWarningMinutes,
      { min: 1 }
    ),
    reminderJobIntervalMs: asNumber(
      rawEnv.TASK_REMINDER_JOB_INTERVAL_MS,
      defaults.automation.reminderJobIntervalMs,
      { min: 10_000 }
    ),
    offlineEscalationMinutes: asNumber(
      rawEnv.WORKER_OFFLINE_ESCALATION_MINUTES,
      defaults.automation.offlineEscalationMinutes,
      { min: 1 }
    ),
    mapPollingIntervalMs: asNumber(
      rawEnv.SUPERVISOR_MAP_POLLING_INTERVAL_MS,
      defaults.automation.mapPollingIntervalMs,
      { min: 5_000 }
    ),
    slaMinutesByPriority: {
      critical: asNumber(
        rawEnv.TASK_SLA_CRITICAL_MINUTES,
        defaults.automation.slaMinutesByPriority.critical,
        { min: 1 }
      ),
      high: asNumber(
        rawEnv.TASK_SLA_HIGH_MINUTES,
        defaults.automation.slaMinutesByPriority.high,
        { min: 1 }
      ),
      medium: asNumber(
        rawEnv.TASK_SLA_MEDIUM_MINUTES,
        defaults.automation.slaMinutesByPriority.medium,
        { min: 1 }
      ),
      low: asNumber(
        rawEnv.TASK_SLA_LOW_MINUTES,
        defaults.automation.slaMinutesByPriority.low,
        { min: 1 }
      ),
    },
  },
  deprecated: {
    activeKeys: deprecatedEnvKeys.filter((key) => rawEnv[key] !== undefined),
  },
});

const validateRuntimeConfig = ({ requireAnalysis = false } = {}) => {
  const errors = [];

  if (!runtimeConfig.database.url) {
    errors.push('DATABASE_URL is required.');
  }

  if (runtimeConfig.isProduction) {
    if (isPlaceholderSecret(runtimeConfig.auth.jwtSecret)) {
      errors.push('JWT_SECRET must be a strong non-placeholder value.');
    }
    if (isPlaceholderSecret(runtimeConfig.auth.jwtRefreshSecret)) {
      errors.push('JWT_REFRESH_SECRET must be a strong non-placeholder value.');
    }
    if (!runtimeConfig.app.corsAllowAll && !runtimeConfig.app.corsOrigin) {
      errors.push('CORS_ORIGIN is required when CORS_ALLOW_ALL=false in production.');
    }
  }

  if (runtimeConfig.redis.enabled && !runtimeConfig.redis.url) {
    errors.push('REDIS_URL must be set when REDIS_ENABLED=true.');
  }

  if (
    requireAnalysis &&
    runtimeConfig.analysis.provider === 'openai' &&
    runtimeConfig.analysis.triggerOnUpload &&
    !runtimeConfig.analysis.openaiApiKey
  ) {
    errors.push(
      'OPENAI_API_KEY is required when ANALYSIS_PROVIDER=openai and ANALYSIS_TRIGGER_ON_UPLOAD=true.'
    );
  }

  return {
    ok: errors.length === 0,
    errors,
  };
};

module.exports = {
  runtimeConfig,
  validateRuntimeConfig,
};
