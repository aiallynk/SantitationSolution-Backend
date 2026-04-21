const { EventEmitter } = require('events');

const eventBus = new EventEmitter();
eventBus.setMaxListeners(200);

const EVENTS = Object.freeze({
  INSPECTION_UPDATED: 'inspection.updated',
  ANALYSIS_COMPLETED: 'analysis.completed',
  ALERT_CREATED: 'alert.created',
  ALERT_UPDATED: 'alert.updated',
  SENSOR_READING: 'sensor.reading',
  FACILITY_METRICS_UPDATED: 'facility.metrics.updated',
  NOTIFICATION_CREATED: 'notification.created',
});

module.exports = {
  eventBus,
  EVENTS,
};
