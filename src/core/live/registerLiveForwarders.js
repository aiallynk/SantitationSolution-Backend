const { eventBus, EVENTS } = require('./eventBus');
const { broadcast: broadcastSse } = require('./sseBroker');
const { broadcast: broadcastWs } = require('./wsBroker');
const { publishLiveEvent } = require('./liveRedisBridge');

const broadcastLocal = (event, payload, payloadScope = null) => {
  broadcastSse(event, payload, payloadScope);
  broadcastWs(event, payload, payloadScope);
};

const forwardEvent = async (event, payload, payloadScope = null) => {
  broadcastLocal(event, payload, payloadScope);
  await publishLiveEvent({ event, payload, payloadScope });
};

const registerLiveForwarders = () => {
  eventBus.on(EVENTS.INSPECTION_UPDATED, (payload) => {
    void forwardEvent(EVENTS.INSPECTION_UPDATED, payload, { tenantId: payload.tenantId || null });
  });
  eventBus.on(EVENTS.ANALYSIS_COMPLETED, (payload) => {
    void forwardEvent(EVENTS.ANALYSIS_COMPLETED, payload, { tenantId: payload.tenantId || null });
  });
  eventBus.on(EVENTS.ALERT_CREATED, (payload) => {
    void forwardEvent(EVENTS.ALERT_CREATED, payload, { tenantId: payload.tenantId || null });
  });
  eventBus.on(EVENTS.ALERT_UPDATED, (payload) => {
    void forwardEvent(EVENTS.ALERT_UPDATED, payload, { tenantId: payload.tenantId || null });
  });
  eventBus.on(EVENTS.SENSOR_READING, (payload) => {
    void forwardEvent(EVENTS.SENSOR_READING, payload, { tenantId: payload.tenantId || null });
  });
  eventBus.on(EVENTS.FACILITY_METRICS_UPDATED, (payload) => {
    void forwardEvent(EVENTS.FACILITY_METRICS_UPDATED, payload, { tenantId: payload.tenantId || null });
  });
};

module.exports = {
  registerLiveForwarders,
  broadcastLocal,
};
