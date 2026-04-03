const IORedis = require('ioredis');
const { isRedisEnabled } = require('../queue/queueManager');

const CHANNEL = String(process.env.REDIS_LIVE_CHANNEL || 'sanitation:live:events').trim();
const SERVER_ID =
  String(process.env.LIVE_SERVER_ID || '').trim() ||
  `live-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

let publisher = null;
let subscriber = null;
let started = false;
let eventHandler = null;
let redisLiveErrorLogged = false;

const buildRedisClient = () =>
  new IORedis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

const logRedisLiveError = (prefix, error) => {
  if (redisLiveErrorLogged) {
    return;
  }
  redisLiveErrorLogged = true;
  // eslint-disable-next-line no-console
  console.error(`${prefix}:`, error.message);
};

const safeParse = (value) => {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
};

const startLiveRedisBridge = async ({ onEvent } = {}) => {
  eventHandler = onEvent || null;
  if (started || !isRedisEnabled() || !process.env.REDIS_URL) {
    return false;
  }

  publisher = buildRedisClient();
  subscriber = buildRedisClient();
  subscriber.on('error', (error) => {
    logRedisLiveError('Redis live subscriber error', error);
  });
  publisher.on('error', (error) => {
    logRedisLiveError('Redis live publisher error', error);
  });

  try {
    await subscriber.subscribe(CHANNEL);
  } catch (error) {
    logRedisLiveError('Redis live subscribe failed', error);
    await closeLiveRedisBridge();
    return false;
  }
  subscriber.on('message', (channel, rawMessage) => {
    if (channel !== CHANNEL || !eventHandler) return;
    const message = safeParse(rawMessage);
    if (!message || message.serverId === SERVER_ID) {
      return;
    }
    eventHandler(message.event, message.payload, message.payloadScope || null);
  });
  started = true;
  return true;
};

const publishLiveEvent = async ({ event, payload, payloadScope = null } = {}) => {
  if (!started || !publisher || !event) {
    return false;
  }

  const envelope = {
    serverId: SERVER_ID,
    event,
    payload,
    payloadScope,
    timestamp: new Date().toISOString(),
  };

  try {
    await publisher.publish(CHANNEL, JSON.stringify(envelope));
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Redis live publish failed:', error.message);
    return false;
  }
};

const closeLiveRedisBridge = async () => {
  const actions = [];
  if (subscriber) {
    actions.push(subscriber.quit());
  }
  if (publisher) {
    actions.push(publisher.quit());
  }

  await Promise.allSettled(actions);
  subscriber = null;
  publisher = null;
  started = false;
  eventHandler = null;
  redisLiveErrorLogged = false;
};

module.exports = {
  startLiveRedisBridge,
  publishLiveEvent,
  closeLiveRedisBridge,
};
