const app = require('./app');
const { sequelize } = require('./models');
const { registerAnalysisWorker } = require('./modules/analysis/analysis.queue');
const { registerLiveForwarders } = require('./core/live/registerLiveForwarders');
const { startHeartbeat } = require('./core/live/sseBroker');
const { startWebSocketServer, closeWebSocketServer } = require('./core/live/wsBroker');
const { startLiveRedisBridge, closeLiveRedisBridge } = require('./core/live/liveRedisBridge');
const { broadcastLocal } = require('./core/live/registerLiveForwarders');
const { closeQueues, isRedisEnabled } = require('./core/queue/queueManager');

const PORT = Number(process.env.PORT || 5000);

let server = null;

const bootstrap = async () => {
  try {
    await sequelize.authenticate();
    // eslint-disable-next-line no-console
    console.log('Database connection established');

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

    if (isRedisEnabled()) {
      registerAnalysisWorker();
      // eslint-disable-next-line no-console
      console.log('Analysis worker registered (Redis mode)');
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
