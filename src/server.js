const app = require('./app');
const { sequelize, ToiletUnit } = require('./models');
const { registerAnalysisWorker } = require('./modules/analysis/analysis.queue');
const { registerLiveForwarders } = require('./core/live/registerLiveForwarders');
const { startHeartbeat } = require('./core/live/sseBroker');
const { startWebSocketServer, closeWebSocketServer } = require('./core/live/wsBroker');
const { startLiveRedisBridge, closeLiveRedisBridge } = require('./core/live/liveRedisBridge');
const { broadcastLocal } = require('./core/live/registerLiveForwarders');
const { closeQueues, isRedisEnabled } = require('./core/queue/queueManager');
const { ensureQrImagesForToilets } = require('./modules/platform/toiletQr.service');
const { assertOpenAiAnalysisConfigured } = require('./modules/analysis/openaiAnalysis.service');
const { execSync } = require('child_process');
const net = require('net');

const PORT = Number(process.env.PORT || 5000);

let server = null;

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
    execSync('npx sequelize-cli db:migrate', {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: process.env,
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

const backfillToiletQrOnBoot = async () => {
  if (!shouldAutoBackfillQrOnBoot()) {
    return;
  }

  try {
    const units = await ToiletUnit.findAll({
      attributes: ['id', 'code', 'qr_code'],
    });
    const result = await ensureQrImagesForToilets(units);
    // eslint-disable-next-line no-console
    console.log(
      `Toilet QR bootstrap completed: total=${result.total} generated=${result.generated} skipped=${result.skipped} failed=${result.failed}`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('Toilet QR bootstrap failed:', error.message);
  }
};

const bootstrap = async () => {
  try {
    assertOpenAiAnalysisConfigured();
    await runPendingMigrations();
    await sequelize.authenticate();
    // eslint-disable-next-line no-console
    console.log('Database connection established');
    await backfillToiletQrOnBoot();
    await probeRedisConnectivity();

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
      // eslint-disable-next-line no-console
      console.warn('Redis disabled: analysis queue running in inline fallback mode');
    }

    server = app.listen(PORT, () => {
      // eslint-disable-next-line no-console
      console.log(`Server is running on port ${PORT}`);
    });
    startWebSocketServer(server);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Server bootstrap failed:', error);
    process.exitCode = 1;
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
