require('./config/env');
const { logger, installGlobalConsoleBridge } = require('./core/logging/logger');
const { markReady, markNotReady } = require('./core/runtime/readiness');
const { runtimeConfig, validateRuntimeConfig } = require('./config/runtime');
const {
  startTempFileJanitor,
  stopTempFileJanitor,
} = require('./core/runtime/tempFileJanitor');

installGlobalConsoleBridge();

const app = require('./app');
const { sequelize, ToiletUnit } = require('./models');
const { registerAnalysisWorker } = require('./modules/analysis/analysis.queue');
const { registerLiveForwarders } = require('./core/live/registerLiveForwarders');
const { startHeartbeat } = require('./core/live/sseBroker');
const { startWebSocketServer, closeWebSocketServer } = require('./core/live/wsBroker');
const { startLiveRedisBridge, closeLiveRedisBridge } = require('./core/live/liveRedisBridge');
const { broadcastLocal } = require('./core/live/registerLiveForwarders');
const {
  closeQueues,
  isRedisEnabled,
  assertQueueRuntimePolicy,
} = require('./core/queue/queueManager');
const { ensureQrImagesForToilets } = require('./modules/platform/toiletQr.service');
const { getOpenAiAnalysisConfigState } = require('./modules/analysis/openaiAnalysis.service');
const {
  startAnalysisJobWatchdog,
  stopAnalysisJobWatchdog,
} = require('./modules/analysis/analysisJobWatchdog.service');
const {
  startImageSessionReconciler,
  stopImageSessionReconciler,
} = require('./modules/inspections/imageSessionReconciler.service');
const {
  startReminderScheduler,
  stopReminderScheduler,
} = require('./modules/automation/reminder.service');
const { execSync } = require('child_process');
const net = require('net');

const PORT = runtimeConfig.app.port;
const DB_STARTUP_MAX_ATTEMPTS = runtimeConfig.server.dbStartupMaxAttempts;
const DB_STARTUP_RETRY_DELAY_MS = runtimeConfig.server.dbStartupRetryDelayMs;
const SERVER_REQUEST_TIMEOUT_MS = runtimeConfig.server.requestTimeoutMs;
const SERVER_HEADERS_TIMEOUT_MS = runtimeConfig.server.headersTimeoutMs;
const SERVER_KEEPALIVE_TIMEOUT_MS = runtimeConfig.server.keepAliveTimeoutMs;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = runtimeConfig.server.gracefulShutdownTimeoutMs;

let server = null;
let shutdownInProgress = false;

const TRANSIENT_DB_ERROR_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

const TRANSIENT_DB_ERROR_PATTERNS = [
  /getaddrinfo (ENOTFOUND|EAI_AGAIN)/i,
  /SequelizeConnection(?:Error|RefusedError|TimedOutError|AcquireTimeoutError)/i,
  /could not connect to server/i,
  /Connection terminated unexpectedly/i,
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
];

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const collectErrorDetails = (error) => {
  if (!error || typeof error !== 'object') {
    return [];
  }

  const fields = ['message', 'name', 'code', 'stack'];
  const details = fields
    .map((field) => error[field])
    .filter((value) => typeof value === 'string' && value.trim().length > 0);

  ['stdout', 'stderr'].forEach((field) => {
    if (error[field]) {
      details.push(String(error[field]));
    }
  });

  ['parent', 'original'].forEach((nestedField) => {
    const nested = error[nestedField];
    if (!nested || typeof nested !== 'object') {
      return;
    }

    fields.forEach((field) => {
      const value = nested[field];
      if (typeof value === 'string' && value.trim().length > 0) {
        details.push(value);
      }
    });
  });

  return details;
};

const isTransientDatabaseError = (error) => {
  if (!error) {
    return false;
  }

  const allCodes = [
    error.code,
    error.parent?.code,
    error.original?.code,
    error.errno,
    error.parent?.errno,
    error.original?.errno,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).toUpperCase());

  if (allCodes.some((code) => TRANSIENT_DB_ERROR_CODES.has(code))) {
    return true;
  }

  const detailText = collectErrorDetails(error).join('\n');
  return TRANSIENT_DB_ERROR_PATTERNS.some((pattern) => pattern.test(detailText));
};

const getRetryConfig = () => {
  const attempts = Number.isFinite(DB_STARTUP_MAX_ATTEMPTS) && DB_STARTUP_MAX_ATTEMPTS > 0
    ? DB_STARTUP_MAX_ATTEMPTS
    : 4;
  const delayMs = Number.isFinite(DB_STARTUP_RETRY_DELAY_MS) && DB_STARTUP_RETRY_DELAY_MS > 0
    ? DB_STARTUP_RETRY_DELAY_MS
    : 2000;

  return { attempts, delayMs };
};

const runWithTransientDbRetry = async (label, operation) => {
  const { attempts, delayMs } = getRetryConfig();

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const shouldRetry = isTransientDatabaseError(error) && attempt < attempts;
      if (!shouldRetry) {
        throw error;
      }

      logger.warn('Transient DB/network error during startup operation', {
        operation: label,
        attempt,
        attempts,
        error: error.message,
        retryInMs: delayMs,
      });
      await sleep(delayMs);
    }
  }

  return null;
};

const shouldProbeRedis = () =>
  Boolean(runtimeConfig.redis.url && runtimeConfig.redis.enabled);

const probeRedisConnectivity = async () => {
  if (!shouldProbeRedis()) {
    return true;
  }

  let url;
  try {
    url = new URL(runtimeConfig.redis.url);
  } catch (_) {
    logger.warn('REDIS_URL is invalid. Disabling Redis features for this process.');
    runtimeConfig.redis.enabled = false;
    return false;
  }

  const host = url.hostname || '127.0.0.1';
  const port = Number(url.port || 6379);
  const timeoutMs = 1000;

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok, reason = null) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (!ok) {
        logger.warn('Redis is not reachable. Falling back to local mode.', {
          host,
          port,
          reason: reason || null,
        });
        runtimeConfig.redis.enabled = false;
      }
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, error.message));
    socket.connect(port, host);
  });
};

const shouldAutoRunMigrations = () => Boolean(runtimeConfig.server.autoRunMigrations);

const shouldFailOnMigrationError = () => Boolean(runtimeConfig.server.autoRunMigrationsStrict);

const runPendingMigrations = async () => {
  if (!shouldAutoRunMigrations()) {
    return;
  }

  try {
    logger.info('Checking and applying pending database migrations');
    await runWithTransientDbRetry('Database migration check', async () => {
      try {
        const output = execSync('npx sequelize-cli db:migrate', {
          cwd: process.cwd(),
          stdio: 'pipe',
          env: process.env,
          encoding: 'utf8',
        });
        if (output) {
          process.stdout.write(output);
        }
      } catch (error) {
        if (error.stdout) {
          process.stdout.write(String(error.stdout));
        }
        if (error.stderr) {
          process.stderr.write(String(error.stderr));
        }
        throw error;
      }
    });
    logger.info('Database migrations are up to date');
  } catch (error) {
    logger.error('Auto migration failed. Continue with current schema.', {
      error: error.message,
    });
    if (shouldFailOnMigrationError()) {
      throw error;
    }
  }
};

const shouldAutoBackfillQrOnBoot = () => {
  return Boolean(runtimeConfig.server.autoBackfillToiletQrOnBoot);
};

const shouldFailOnAnalysisConfigError = () => Boolean(runtimeConfig.server.analysisBootStrict);

const isAnalysisTriggerOnUploadEnabled = () => Boolean(runtimeConfig.analysis.triggerOnUpload);

const startHttpServer = () =>
  new Promise((resolve, reject) => {
    const candidate = app.listen(PORT);
    candidate.once('error', (error) => reject(error));
    candidate.once('listening', () => resolve(candidate));
  });

const validateAnalysisConfigAtBoot = () => {
  const state = getOpenAiAnalysisConfigState();
  if (state.ok) {
    return;
  }

  const strictMode = shouldFailOnAnalysisConfigError();
  const message =
    `AI analysis configuration is invalid (${state.code || 'UNKNOWN'}): ${state.reason || 'Unknown reason'}.`;

  if (strictMode) {
    const error = new Error(`${message} Set ANALYSIS_BOOT_STRICT=false to continue boot without AI analysis.`);
    error.code = state.code || 'AI_BOOT_CONFIG_INVALID';
    throw error;
  }

  logger.warn(`${message} Continuing boot with AI analysis disabled.`);

  if (isAnalysisTriggerOnUploadEnabled()) {
    runtimeConfig.analysis.triggerOnUpload = false;
    logger.warn('ANALYSIS_TRIGGER_ON_UPLOAD has been forced to false for this process.');
  }
};

const backfillToiletQrOnBoot = async () => {
  if (!shouldAutoBackfillQrOnBoot()) {
    return;
  }

  try {
    const forceRegenerate = Boolean(runtimeConfig.server.qrForceRegenerateOnBoot);
    const units = await ToiletUnit.findAll({
      attributes: ['id', 'code', 'qr_code'],
    });
    const result = await ensureQrImagesForToilets(units, {
      forceRegenerate,
    });
    logger.info('Toilet QR bootstrap completed', {
      total: result.total,
      generated: result.generated,
      skipped: result.skipped,
      failed: result.failed,
      forceRegenerate,
    });
  } catch (error) {
    logger.warn('Toilet QR bootstrap failed', { error: error.message });
  }
};

const bootstrap = async () => {
  try {
    const configValidation = validateRuntimeConfig({
      requireAnalysis: runtimeConfig.analysis.triggerOnUpload,
    });
    if (!configValidation.ok) {
      throw new Error(`Invalid runtime config: ${configValidation.errors.join(' | ')}`);
    }
    if (runtimeConfig.deprecated.activeKeys.length > 0) {
      logger.warn('Deprecated environment variables detected; these are ignored now', {
        keys: runtimeConfig.deprecated.activeKeys,
      });
    }

    markNotReady('bootstrapping');
    validateAnalysisConfigAtBoot();
    await runPendingMigrations();
    await runWithTransientDbRetry('Database connection', async () => {
      await sequelize.authenticate();
    });
    logger.info('Database connection established');
    await backfillToiletQrOnBoot();
    await probeRedisConnectivity();
    assertQueueRuntimePolicy();

    registerLiveForwarders();
    startHeartbeat();
    try {
      await startLiveRedisBridge({
        onEvent: (event, payload, payloadScope) => {
          broadcastLocal(event, payload, payloadScope);
        },
      });
    } catch (error) {
      logger.warn('Live Redis bridge unavailable, using single-node live events', {
        error: error.message,
      });
    }

    const runEmbeddedWorker = Boolean(runtimeConfig.server.analysisWorkerEmbedded);
    if (isRedisEnabled() && runEmbeddedWorker) {
      registerAnalysisWorker();
      logger.info('Analysis worker registered (embedded mode)');
    } else if (isRedisEnabled()) {
      logger.info('Analysis worker is expected to run as a separate process');
    } else {
      if (runtimeConfig.redis.requiredInProduction && runtimeConfig.isProduction) {
        throw new Error('Redis queue is mandatory in production and is currently unavailable');
      }
      logger.warn('Redis disabled: analysis queue running in inline fallback mode');
    }

    startAnalysisJobWatchdog();
    startImageSessionReconciler();
    startReminderScheduler();
    startTempFileJanitor();

    server = await startHttpServer();
    server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
    server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
    server.keepAliveTimeout = SERVER_KEEPALIVE_TIMEOUT_MS;
    startWebSocketServer(server);
    logger.info('Server is running', {
      port: PORT,
      requestTimeoutMs: SERVER_REQUEST_TIMEOUT_MS,
      keepAliveTimeoutMs: SERVER_KEEPALIVE_TIMEOUT_MS,
    });
    markReady('serving');
  } catch (error) {
    if (error?.code === 'EADDRINUSE') {
      logger.error('Server bootstrap failed: configured port is already in use', {
        port: PORT,
        code: error.code,
      });
    }
    logger.error('Server bootstrap failed', { error });
    markNotReady('bootstrap_failed');
    process.exit(1);
  }
};

const gracefulShutdown = async (signal, exitCode = 0) => {
  if (shutdownInProgress) {
    return;
  }
  shutdownInProgress = true;
  markNotReady(`shutting_down:${signal}`);
  logger.info('Received shutdown signal. Starting graceful shutdown.', { signal });

  const hardStopTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing process exit.', {
      timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
  hardStopTimer.unref?.();

  try {
    if (server) {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    }
    await closeWebSocketServer();
    await closeLiveRedisBridge();
    stopAnalysisJobWatchdog();
    stopImageSessionReconciler();
    stopReminderScheduler();
    stopTempFileJanitor();
    await closeQueues();
    await sequelize.close();
    logger.info('Shutdown complete');
  } catch (error) {
    logger.error('Shutdown encountered errors', { error });
    exitCode = 1;
  } finally {
    clearTimeout(hardStopTimer);
    process.exit(exitCode);
  }
};

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
  void gracefulShutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  void gracefulShutdown('uncaughtException', 1);
});

bootstrap();
