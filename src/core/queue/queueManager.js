const { Queue, Worker } = require('bullmq');
const IORedis = require('ioredis');

const queues = new Map();
const workers = [];
let redisConnection = null;

const isRedisEnabled = () =>
  Boolean(process.env.REDIS_URL && String(process.env.REDIS_ENABLED || 'true').toLowerCase() === 'true');

const getRedisConnection = () => {
  if (!isRedisEnabled()) {
    return null;
  }
  if (!redisConnection) {
    redisConnection = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
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

  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'completed',
    'failed',
    'delayed',
    'paused'
  );

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

const registerWorker = (name, processor) => {
  const connection = getRedisConnection();
  if (!connection) {
    return null;
  }

  const worker = new Worker(name, processor, { connection });
  workers.push(worker);
  return worker;
};

const addJob = async (name, jobName, payload, options = {}) => {
  const queue = getQueue(name);
  if (!queue) {
    return null;
  }

  return queue.add(jobName, payload, {
    attempts: Number(process.env.QUEUE_ATTEMPTS || 3),
    backoff: {
      type: 'exponential',
      delay: Number(process.env.QUEUE_BACKOFF_MS || 1000),
    },
    removeOnComplete: true,
    removeOnFail: false,
    ...options,
  });
};

const closeQueues = async () => {
  await Promise.all([...queues.values()].map((queue) => queue.close()));
  await Promise.all(workers.map((worker) => worker.close()));
  if (redisConnection) {
    await redisConnection.quit();
  }
};

module.exports = {
  addJob,
  registerWorker,
  getQueueMetrics,
  closeQueues,
  isRedisEnabled,
};
