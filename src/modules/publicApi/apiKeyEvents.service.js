const { ApiKeyEvent, NotificationEvent } = require('../../models');
const { logger } = require('../../core/logging/logger');

const EVENT_TYPES = Object.freeze({
  KEY_CREATED: 'KEY_CREATED',
  KEY_REVOKED: 'KEY_REVOKED',
  KEY_REGENERATED: 'KEY_REGENERATED',
  KEY_LIMIT_UPDATED: 'KEY_LIMIT_UPDATED',
  KEY_SCOPE_UPDATED: 'KEY_SCOPE_UPDATED',
  KEY_EXPIRED: 'KEY_EXPIRED',
  KEY_USED_FIRST_TIME: 'KEY_USED_FIRST_TIME',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  HIGH_USAGE_DETECTED: 'HIGH_USAGE_DETECTED',
  INVALID_KEY_ATTEMPTS_DETECTED: 'INVALID_KEY_ATTEMPTS_DETECTED',
  REVOKED_KEY_USED: 'REVOKED_KEY_USED',
  EXPIRED_KEY_USED: 'EXPIRED_KEY_USED',
});

const recordApiKeyEvent = async ({
  apiProjectId = null,
  apiKeyId = null,
  eventType,
  actorUserId = null,
  requestIp = null,
  userAgent = null,
  metadata = {},
  notify = false,
} = {}) => {
  if (!eventType) return null;
  const event = await ApiKeyEvent.create({
    api_project_id: apiProjectId,
    api_key_id: apiKeyId,
    event_type: eventType,
    actor_user_id: actorUserId,
    request_ip: requestIp,
    user_agent: userAgent,
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {},
  });

  if (notify) {
    try {
      await NotificationEvent.create({
        tenant_id: null,
        user_id: null,
        event_type: 'api_access.alert',
        channel: 'in_app',
        notification_type: 'SYSTEM',
        priority: 'HIGH',
        title: 'External API access alert',
        body: String(metadata?.message || eventType).slice(0, 1200),
        short_body: String(metadata?.message || eventType).slice(0, 280),
        entity_type: 'api_key',
        entity_id: apiKeyId || apiProjectId || null,
        route: '/sa/api-access',
        icon_key: 'shield',
        severity: metadata?.severity || 'warning',
        audience_kind: 'role',
        payload: {
          eventType,
          apiProjectId,
          apiKeyId,
          ...metadata,
        },
        status: 'sent',
        delivery_state: 'SENT',
        sent_at: new Date(),
      });
    } catch (error) {
      logger.warn('Unable to create API access notification event', {
        eventType,
        apiProjectId,
        apiKeyId,
        error: error.message,
      });
    }
  }

  return event;
};

module.exports = {
  EVENT_TYPES,
  recordApiKeyEvent,
};
