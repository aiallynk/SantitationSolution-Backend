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
const { execSync } = require('child_process');
const net = require('net');

const PORT = Number(process.env.PORT || 5000);
const DB_STARTUP_MAX_ATTEMPTS = Number(process.env.DB_STARTUP_MAX_ATTEMPTS || 4);
const DB_STARTUP_RETRY_DELAY_MS = Number(process.env.DB_STARTUP_RETRY_DELAY_MS || 2000);

let server = null;

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

      // eslint-disable-next-line no-console
      console.warn(
        `${label} failed with a transient DB/network error (attempt ${attempt}/${attempts}): ${error.message}`
      );
      // eslint-disable-next-line no-console
      console.warn(`Retrying ${label.toLowerCase()} in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  return null;
};

const shouldProbeRedis = () =>
  Boolean(
    process.env.REDIS_URL &&
      String(process.env.REDIS_ENABLED || 'true').toLowerCase() === 'true'
  );

const probeRedisConnectivity = async () => {
  if (!shouldProbeRedis()) {
    return true;
  }

  let url;
  try {
    url = new URL(process.env.REDIS_URL);
  } catch (_) {
    // eslint-disable-next-line no-console
    console.warn('REDIS_URL is invalid. Disabling Redis features for this process.');
    process.env.REDIS_ENABLED = 'false';
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
        // eslint-disable-next-line no-console
        console.warn(
          `Redis is not reachable at ${host}:${port}${reason ? ` (${reason})` : ''}. Falling back to local mode.`
        );
        process.env.REDIS_ENABLED = 'false';
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

const shouldAutoRunMigrations = () => {
  const configured = String(process.env.AUTO_RUN_MIGRATIONS || '').trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production';
};

const shouldFailOnMigrationError = () => {
  const configured = String(process.env.AUTO_RUN_MIGRATIONS_STRICT || '').trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return String(process.env.NODE_ENV || 'development').toLowerCase() !== 'production';
};

const runPendingMigrations = async () => {
  if (!shouldAutoRunMigrations()) {
    return;
  }

  try {
    // eslint-disable-next-line no-console
    console.log('Checking and applying pending database migrations...');
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
    // eslint-disable-next-line no-console
    console.log('Database migrations are up to date');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto migration failed. Continue with current schema. Error:', error.message);
    if (shouldFailOnMigrationError()) {
      throw error;
    }
  }
};

const shouldAutoBackfillQrOnBoot = () => {
  const configured = String(process.env.AUTO_BACKFILL_TOILET_QR_ON_BOOT || '')
    .trim()
    .toLowerCase();
  if (configured === 'false') return false;
  if (configured === 'true') return true;
  return true;
};

const shouldFailOnAnalysisConfigError = () => {
  const configured = String(process.env.ANALYSIS_BOOT_STRICT || '').trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return false;
};

const isAnalysisTriggerOnUploadEnabled = () =>
  String(process.env.ANALYSIS_TRIGGER_ON_UPLOAD || 'true').trim().toLowerCase() === 'true';

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

  // eslint-disable-next-line no-console
  console.warn(`${message} Continuing boot with AI analysis disabled.`);

  if (isAnalysisTriggerOnUploadEnabled()) {
    process.env.ANALYSIS_TRIGGER_ON_UPLOAD = 'false';
    // eslint-disable-next-line no-console
    console.warn('ANALYSIS_TRIGGER_ON_UPLOAD has been forced to false for this process.');
  }
};

const backfillToiletQrOnBoot = async () => {
  if (!shouldAutoBackfillQrOnBoot()) {
    return;
  }

  try {
    const forceRegenerate =
      String(process.env.QR_FORCE_REGENERATE_ON_BOOT || 'false').trim().toLowerCase() ===
      'true';
    const units = await ToiletUnit.findAll({
      attributes: ['id', 'code', 'qr_code'],
    });
    const result = await ensureQrImagesForToilets(units, {
      forceRegenerate,
    });
    // eslint-disable-next-line no-console
    console.log(
      `Toilet QR bootstrap completed: total=${result.total} generated=${result.generated} skipped=${result.skipped} failed=${result.failed} forceRegenerate=${forceRegenerate}`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Toilet QR bootstrap failed:', error.message);
  }
};

const bootstrap = async () => {
  try {
    validateAnalysisConfigAtBoot();
    await runPendingMigrations();
    await runWithTransientDbRetry('Database connection', async () => {
      await sequelize.authenticate();
    });
    // eslint-disable-next-line no-console
    console.log('Database connection established');
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
      // eslint-disable-next-line no-console
      console.error('Live Redis bridge unavailable, using single-node live events:', error.message);
    }

    const runEmbeddedWorker =
      String(process.env.ANALYSIS_WORKER_EMBEDDED || 'true').toLowerCase() === 'true';
    if (isRedisEnabled() && runEmbeddedWorker) {
      registerAnalysisWorker();
      // eslint-disable-next-line no-console
      console.log('Analysis worker registered (embedded mode)');
    } else if (isRedisEnabled()) {
      // eslint-disable-next-line no-console
      console.log('Analysis worker is expected to run as a separate process');
    } else {
      if (String(process.env.REDIS_REQUIRED_IN_PROD || 'false').toLowerCase() === 'true' &&
          String(process.env.NODE_ENV || 'development').toLowerCase() === 'production') {
        throw new Error('Redis queue is mandatory in production and is currently unavailable');
      }
      // eslint-disable-next-line no-console
      console.warn('Redis disabled: analysis queue running in inline fallback mode');
    }

    startAnalysisJobWatchdog();
    startImageSessionReconciler();

    server = app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Server is running on port ${PORT}`);
    });
    startWebSocketServer(server);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Server bootstrap failed:', error);
    process.exit(1);
  }
};

const gracefulShutdown = async (signal) => {
  // eslint-disable-next-line no-console
  console.log(`Received ${signal}. Starting graceful shutdown...`);
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
    await closeQueues();
    await sequelize.close();
    // eslint-disable-next-line no-console
    console.log('Shutdown complete');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Shutdown encountered errors:', error);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

bootstrap();
