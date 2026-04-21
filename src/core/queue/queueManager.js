const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');
const { runtimeConfig } = require('../../config/runtime');
const { logger } = require('../logging/logger');

const queues = new Map();
const workers = [];
let redisConnection = null;
let redisSuppressed = false;
let redisErrorLogged = false;
let redisFallbackLogged = false;

const isProduction = () => runtimeConfig.isProduction;

const isRedisRequiredInProd = () => Boolean(runtimeConfig.redis.requiredInProduction);

const isRedisEnabled = () =>
  Boolean(
    !redisSuppressed &&
      runtimeConfig.redis.url &&
      runtimeConfig.redis.enabled
  );

const isConnectionRefusedError = (error) => {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  return code === 'ECONNREFUSED' || message.includes('econnrefused');
};

const logRedisFallback = (reason) => {
  if (redisFallbackLogged) {
    return;
  }
  redisFallbackLogged = true;
  logger.warn('Redis unavailable. Falling back to in-process queue mode.', {
    reason: String(reason || 'unknown'),
  });
};

const resolveBullRetention = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.floor(asNumber);
  }
  return fallback;
};

const suppressRedis = (reason) => {
  redisSuppressed = true;
  logRedisFallback(reason);
  if (redisConnection) {
    try {
      redisConnection.disconnect();
    } catch (_) {
      // ignore
    }
    redisConnection = null;
  }
};

const assertQueueRuntimePolicy = () => {
  if (!isProduction() || !isRedisRequiredInProd()) {
    return true;
  }

  if (!runtimeConfig.redis.url) {
    throw new Error(
      'REDIS_REQUIRED_IN_PROD=true but REDIS_URL is missing. Refusing inline queue mode in production.'
    );
  }

  if (!runtimeConfig.redis.enabled) {
    throw new Error(
      'REDIS_REQUIRED_IN_PROD=true but REDIS_ENABLED is false. Refusing inline queue mode in production.'
    );
  }

  if (redisSuppressed) {
    throw new Error(
      'Redis was suppressed due connectivity issues and REDIS_REQUIRED_IN_PROD=true. Queue fallback is disabled in production.'
    );
  }

  return true;
};

const getRedisConnection = () => {
  if (!isRedisEnabled()) {
    return null;
  }
  if (!redisConnection) {
    redisConnection = new IORedis(runtimeConfig.redis.url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    redisConnection.on('error', (error) => {
      if (!redisErrorLogged) {
        redisErrorLogged = true;
        logger.error('Redis connection error', { error: error.message });
      }
      if (isConnectionRefusedError(error)) {
        suppressRedis(error.message || 'ECONNREFUSED');
      }
    });
  }
  return redisConnection;
};

const getQueue = (name) => {
  if (queues.has(name)) {
    return queues.get(name);
  }

  const connection = getRedisConnection();
  if (!connection) {
    return null;
  }

  const queue = new Queue(name, { connection });
  queues.set(name, queue);
  return queue;
};

const resolveWorkerConcurrency = (name, fallback = 1) => {
  const queueSpecific =
    String(name || '').toLowerCase() === 'inspection-analysis'
      ? runtimeConfig.queue.analysisWorkerConcurrency
      : null;
  if (Number.isFinite(queueSpecific) && queueSpecific > 0) return queueSpecific;
  const globalValue = Number(runtimeConfig.queue.workerConcurrency || fallback);
  return Number.isFinite(globalValue) && globalValue > 0 ? globalValue : fallback;
};

const getQueueMetrics = async (name) => {
  const queue = getQueue(name);
  if (!queue) {
    return {
      queueName: name,
      enabled: false,
      counts: {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      },
    };
  }

  let counts;
  try {
    counts = await queue.getJobCounts(
      'waiting',
      'active',
      'completed',
      'failed',
      'delayed',
      'paused'
    );
  } catch (error) {
    if (isConnectionRefusedError(error)) {
      suppressRedis(error.message || 'ECONNREFUSED');
    }
    return {
      queueName: name,
      enabled: false,
      counts: {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        paused: 0,
      },
    };
  }

  return {
    queueName: name,
    enabled: true,
    counts: {
      waiting: Number(counts.waiting || 0),
      active: Number(counts.active || 0),
      completed: Number(counts.completed || 0),
      failed: Number(counts.failed || 0),
      delayed: Number(counts.delayed || 0),
      paused: Number(counts.paused || 0),
    },
  };
};

const registerWorker = (name, processor, options = {}) => {
  const connection = getRedisConnection();
  if (!connection) {
    return null;
  }

  try {
    const worker = new Worker(name, processor, {
      connection,
      concurrency: resolveWorkerConcurrency(name, Number(options.concurrency || 1)),
      ...options,
    });
    worker.on('error', (error) => {
      if (isConnectionRefusedError(error)) {
        suppressRedis(error.message || 'ECONNREFUSED');
      }
    });
    workers.push(worker);
    return worker;
  } catch (error) {
    if (isConnectionRefusedError(error)) {
      suppressRedis(error.message || 'ECONNREFUSED');
      return null;
    }
    throw error;
  }
};

const addJob = async (name, jobName, payload, options = {}) => {
  const queue = getQueue(name);
  if (!queue) {
    return null;
  }

  try {
    return await queue.add(jobName, payload, {
      attempts: Number(runtimeConfig.queue.attempts || 3),
      backoff: {
        type: 'exponential',
        delay: Number(runtimeConfig.queue.backoffMs || 1000),
      },
      removeOnComplete: resolveBullRetention(runtimeConfig.queue.removeOnComplete, 200),
      removeOnFail: resolveBullRetention(runtimeConfig.queue.removeOnFail, 1000),
      ...options,
    });
  } catch (error) {
    if (isConnectionRefusedError(error)) {
      suppressRedis(error.message || 'ECONNREFUSED');
      return null;
    }
    throw error;
  }
};

const addDeadLetterJob = async (name, payload, options = {}) =>
  addJob(
    `${name}.dlq`,
    'dead-letter',
    payload,
    {
      attempts: 1,
      backoff: {
        type: 'fixed',
        delay: 1000,
      },
      removeOnComplete: resolveBullRetention(
        runtimeConfig.queue.dlqRemoveOnComplete,
        50
      ),
      removeOnFail: resolveBullRetention(runtimeConfig.queue.dlqRemoveOnFail, 500),
      ...options,
    }
  );

const closeQueues = async () => {
  await Promise.all([...queues.values()].map((queue) => queue.close().catch(() => null)));
  await Promise.all(workers.map((worker) => worker.close().catch(() => null)));
  if (redisConnection) {
    await redisConnection.quit().catch(() => null);
  }
  queues.clear();
  workers.length = 0;
  redisConnection = null;
};

module.exports = {
  addJob,
  addDeadLetterJob,
  registerWorker,
  getQueueMetrics,
  closeQueues,
  isRedisEnabled,
  assertQueueRuntimePolicy,
};
