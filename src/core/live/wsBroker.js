const { WebSocketServer } = require('ws');
const { getAuthContextFromToken } = require('../middleware/auth');
const { runtimeConfig } = require('../../config/runtime');

const clients = new Map();
let wsServer = null;
let heartbeatTimer = null;
let clientCounter = 0;

const shouldDeliver = (clientScope, payloadScope) => {
  if (!payloadScope) return true;
  if (clientScope.isSuperAdmin || clientScope.roleCode === 'super_admin') return true;

  if (payloadScope.tenantId && clientScope.tenantId && payloadScope.tenantId !== clientScope.tenantId) {
    return false;
  }

  return true;
};

const sendEvent = (socket, event, payload) => {
  if (!socket || socket.readyState !== 1) {
    return;
  }
  socket.send(
    JSON.stringify({
      event,
      data: payload,
      timestamp: new Date().toISOString(),
    })
  );
};

const normalizeConnectionContext = (request) => {
  const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token') || null;
  const tenantId = url.searchParams.get('tenantId') || null;
  return { token, tenantId };
};

const registerWebSocketClient = async ({ socket, request }) => {
  const context = normalizeConnectionContext(request);
  const user = await getAuthContextFromToken({
    token: context.token,
    tenantId: context.tenantId,
  });

  const id = `ws-${++clientCounter}`;
  const scope = {
    userId: user.id,
    tenantId: user.tenantId || null,
    roleCode: user.roleCodes?.[0] || null,
    isSuperAdmin: Boolean(user.isSuperAdmin),
  };

  clients.set(id, {
    id,
    socket,
    scope,
    connectedAt: new Date(),
  });

  sendEvent(socket, 'connected', {
    clientId: id,
    mode: 'websocket',
    tenantId: scope.tenantId,
  });

  socket.on('close', () => {
    clients.delete(id);
  });
  socket.on('error', () => {
    clients.delete(id);
  });
};

const startWebSocketServer = (httpServer) => {
  if (wsServer || !httpServer) {
    return wsServer;
  }

  wsServer = new WebSocketServer({
    server: httpServer,
    path: '/api/v1/live/ws',
  });

  wsServer.on('connection', async (socket, request) => {
    try {
      await registerWebSocketClient({ socket, request });
    } catch (error) {
      sendEvent(socket, 'error', {
        code: error.statusCode || 401,
        message: error.message || 'Unauthorized websocket connection',
      });
      socket.close(1008, 'Unauthorized');
    }
  });

  const heartbeatMs = Math.max(runtimeConfig.live.wsHeartbeatMs, 10_000);
  heartbeatTimer = setInterval(() => {
    for (const client of clients.values()) {
      sendEvent(client.socket, 'ping', { timestamp: new Date().toISOString() });
    }
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  return wsServer;
};

const broadcast = (event, payload, payloadScope = null) => {
  for (const client of clients.values()) {
    if (!shouldDeliver(client.scope, payloadScope)) {
      continue;
    }
    sendEvent(client.socket, event, payload);
  }
};

const closeWebSocketServer = async () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  for (const client of clients.values()) {
    try {
      client.socket.close(1001, 'Server shutdown');
    } catch (error) {
      // ignore close errors
    }
  }
  clients.clear();

  if (!wsServer) {
    return;
  }

  await new Promise((resolve) => {
    wsServer.close(() => resolve());
  });
  wsServer = null;
};

module.exports = {
  startWebSocketServer,
  closeWebSocketServer,
  broadcast,
};
