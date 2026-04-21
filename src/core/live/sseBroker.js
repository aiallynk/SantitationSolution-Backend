const clients = new Map();
let clientCounter = 0;
const { runtimeConfig } = require('../../config/runtime');

const setupSseHeaders = (res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
};

const sendEvent = (res, event, payload) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

const registerClient = (req, res, scope = {}) => {
  setupSseHeaders(res);
  const id = `client-${++clientCounter}`;
  const client = {
    id,
    res,
    scope,
    connectedAt: new Date(),
  };

  clients.set(id, client);
  sendEvent(res, 'connected', {
    clientId: id,
    requestId: req.requestId || null,
    timestamp: new Date().toISOString(),
  });

  req.on('close', () => {
    clients.delete(id);
  });

  return client;
};

const shouldDeliver = (clientScope, payloadScope) => {
  if (!payloadScope) return true;

  if (payloadScope.userId) {
    if (!clientScope.userId) return false;
    if (String(payloadScope.userId) !== String(clientScope.userId)) {
      return false;
    }
  }

  if (clientScope.roleCode === 'super_admin' && !payloadScope.userId) return true;

  if (payloadScope.tenantId && clientScope.tenantId && payloadScope.tenantId !== clientScope.tenantId) {
    return false;
  }

  return true;
};

const broadcast = (event, payload, payloadScope = null) => {
  for (const client of clients.values()) {
    if (!shouldDeliver(client.scope, payloadScope)) {
      continue;
    }
    sendEvent(client.res, event, payload);
  }
};

const startHeartbeat = () => {
  setInterval(() => {
    for (const client of clients.values()) {
      sendEvent(client.res, 'ping', { timestamp: new Date().toISOString() });
    }
  }, runtimeConfig.live.sseHeartbeatMs).unref();
};

module.exports = {
  registerClient,
  broadcast,
  startHeartbeat,
};
