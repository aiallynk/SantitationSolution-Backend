require('../config/env');

const net = require('net');
const { sequelize } = require('../models');
const { registerAnalysisWorker } = require('../modules/analysis/analysis.queue');
const { assertOpenAiAnalysisConfigured } = require('../modules/analysis/openaiAnalysis.service');
const { closeQueues, isRedisEnabled } = require('../core/queue/queueManager');

let worker = null;

const probeRedisConnectivity = async () => {
  if (
    !process.env.REDIS_URL ||
    String(process.env.REDIS_ENABLED || 'true').toLowerCase() !== 'true'
  ) {
    return false;
  }

  let url;
  try {
    url = new URL(process.env.REDIS_URL);
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
    // eslint-disable-next-line no-console
    console.log('Analysis worker DB connection established');

    const redisReachable = await probeRedisConnectivity();
    if (!redisReachable) {
      // eslint-disable-next-line no-console
      console.error('Redis is not reachable; analysis worker requires a running Redis instance.');
      process.exit(1);
      return;
    }

    if (!isRedisEnabled()) {
      // eslint-disable-next-line no-console
      console.error('Redis is disabled; analysis worker requires REDIS_ENABLED=true');
      process.exit(1);
      return;
    }

    worker = registerAnalysisWorker();
    if (!worker) {
      // eslint-disable-next-line no-console
      console.error('Failed to register analysis worker');
      process.exit(1);
      return;
    }

    // eslint-disable-next-line no-console
    console.log('Analysis worker started and listening for jobs');
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Analysis worker bootstrap failed:', error);
    process.exitCode = 1;
  }
};

const gracefulShutdown = async (signal) => {
  // eslint-disable-next-line no-console
  console.log(`Received ${signal}. Shutting down analysis worker...`);
  try {
    if (worker) {
      await worker.close();
    }
    await closeQueues();
    await sequelize.close();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Analysis worker shutdown failed:', error);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

bootstrap();
