require('../config/env');
const {
  logger,
  installGlobalConsoleBridge,
} = require('../core/logging/logger');
installGlobalConsoleBridge();

const net = require('net');
const { sequelize } = require('../models');
const { registerAnalysisWorker } = require('../modules/analysis/analysis.queue');
const { assertOpenAiAnalysisConfigured } = require('../modules/analysis/openaiAnalysis.service');
const {
  closeQueues,
  isRedisEnabled,
  assertQueueRuntimePolicy,
} = require('../core/queue/queueManager');
const { runtimeConfig } = require('../config/runtime');

let worker = null;
let shuttingDown = false;

const probeRedisConnectivity = async () => {
  if (
    !runtimeConfig.redis.url ||
    !runtimeConfig.redis.enabled
  ) {
    return false;
  }

  let url;
  try {
    url = new URL(runtimeConfig.redis.url);
  } catch (_) {
    return false;
  }

  const host = url.hostname || '127.0.0.1';
  const port = Number(url.port || 6379);

  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
};

const bootstrap = async () => {
  try {
    assertOpenAiAnalysisConfigured();
    await sequelize.authenticate();
    logger.info('Analysis worker DB connection established');

    const redisReachable = await probeRedisConnectivity();
    if (!redisReachable) {
      logger.error(
        'Redis is not reachable; analysis worker requires a running Redis instance.'
      );
      process.exit(1);
      return;
    }

    if (!isRedisEnabled()) {
      logger.error('Redis is disabled; analysis worker requires REDIS_ENABLED=true');
      process.exit(1);
      return;
    }
    assertQueueRuntimePolicy();

    worker = registerAnalysisWorker();
    if (!worker) {
      logger.error('Failed to register analysis worker');
      process.exit(1);
      return;
    }

    logger.info('Analysis worker started and listening for jobs');
  } catch (error) {
    logger.error('Analysis worker bootstrap failed', { error });
    process.exitCode = 1;
  }
};

const gracefulShutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down analysis worker', { signal });
  try {
    if (worker) {
      await worker.close();
    }
    await closeQueues();
    await sequelize.close();
  } catch (error) {
    logger.error('Analysis worker shutdown failed', { error });
    exitCode = 1;
  } finally {
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
  logger.error('Unhandled promise rejection in analysis worker', { reason });
  void gracefulShutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception in analysis worker', { error });
  void gracefulShutdown('uncaughtException', 1);
});

bootstrap();
