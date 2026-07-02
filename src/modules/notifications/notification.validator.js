const { isUuid, inEnum, isBlank } = require('../../utils/validators');
const {
  NotificationTypes,
  NotificationPriorities,
  NotificationPlatforms,
  NotificationBroadcastAudiences,
} = require('./notification.constants');

const VALID_TYPES = Object.values(NotificationTypes);
const VALID_PRIORITIES = Object.values(NotificationPriorities);
const VALID_PLATFORMS = Object.values(NotificationPlatforms);
const VALID_BROADCAST_AUDIENCES = Object.values(
  NotificationBroadcastAudiences
);
const VALID_BROADCAST_TEMPLATES = ['custom', 'alert', 'test'];

const validateNotificationListQuery = (req) => {
  const errors = [];
  if (!isBlank(req.query.type) && !inEnum(String(req.query.type).toUpperCase(), VALID_TYPES)) {
    errors.push(`type must be one of ${VALID_TYPES.join(', ')}`);
  }
  if (!isBlank(req.query.priority) && !inEnum(String(req.query.priority).toUpperCase(), VALID_PRIORITIES)) {
    errors.push(`priority must be one of ${VALID_PRIORITIES.join(', ')}`);
  }
  if (!isBlank(req.query.dateFrom) && Number.isNaN(new Date(req.query.dateFrom).getTime())) {
    errors.push('dateFrom must be a valid ISO datetime');
  }
  if (!isBlank(req.query.dateTo) && Number.isNaN(new Date(req.query.dateTo).getTime())) {
    errors.push('dateTo must be a valid ISO datetime');
  }
  return errors;
};

const validateNotificationIdParam = (req) => {
  const errors = [];
  if (!isUuid(req.params.id)) {
    errors.push('id must be a valid UUID');
  }
  return errors;
};

const validateNotificationPreferencesPatch = (req) => {
  const errors = [];
  const rows = Array.isArray(req.body?.items)
    ? req.body.items
    : Array.isArray(req.body?.preferences)
      ? req.body.preferences
      : req.body?.notificationType
        ? [req.body]
        : [];

  if (rows.length === 0) {
    errors.push('items or preferences payload is required');
    return errors;
  }

  rows.forEach((row, index) => {
    const label = `items[${index}]`;
    const type = String(row?.notificationType || '').toUpperCase();
    if (!VALID_TYPES.includes(type)) {
      errors.push(`${label}.notificationType must be one of ${VALID_TYPES.join(', ')}`);
    }
  });
  return errors;
};

const validateDeviceTokenRegister = (req) => {
  const errors = [];
  if (isBlank(req.body?.token)) {
    errors.push('token is required');
  }
  const platform = String(req.body?.platform || '').trim().toLowerCase();
  if (isBlank(platform)) {
    errors.push('platform is required');
  } else if (!VALID_PLATFORMS.includes(platform)) {
    errors.push(`platform must be one of ${VALID_PLATFORMS.join(', ')}`);
  }
  return errors;
};

const validateDeviceTokenDelete = () => [];

const validateTestPushSend = (req) => {
  const errors = [];
  if (!isBlank(req.body?.title) && String(req.body.title).trim().length > 120) {
    errors.push('title must be 120 characters or fewer');
  }
  if (!isBlank(req.body?.body) && String(req.body.body).trim().length > 800) {
    errors.push('body must be 800 characters or fewer');
  }
  if (req.body?.data !== undefined && (typeof req.body.data !== 'object' || Array.isArray(req.body.data) || req.body.data === null)) {
    errors.push('data must be an object when provided');
  }

  if (req.body?.token !== undefined && isBlank(req.body.token)) {
    errors.push('token must be a non-empty string when provided');
  }

  if (req.body?.tokens !== undefined) {
    if (!Array.isArray(req.body.tokens)) {
      errors.push('tokens must be an array when provided');
    } else if (req.body.tokens.some((item) => isBlank(item))) {
      errors.push('tokens array cannot contain empty values');
    }
  }
  return errors;
};

const validateBroadcastSend = (req) => {
  const errors = [];
  const audience = String(
    req.body?.audience || NotificationBroadcastAudiences.SELF
  )
    .trim()
    .toLowerCase();
  if (!VALID_BROADCAST_AUDIENCES.includes(audience)) {
    errors.push(
      `audience must be one of ${VALID_BROADCAST_AUDIENCES.join(', ')}`
    );
  }

  const template = String(req.body?.template || 'custom')
    .trim()
    .toLowerCase();
  if (!VALID_BROADCAST_TEMPLATES.includes(template)) {
    errors.push(
      `template must be one of ${VALID_BROADCAST_TEMPLATES.join(', ')}`
    );
  }

  const title = String(req.body?.title || '').trim();
  if (!title) {
    errors.push('title is required');
  } else if (title.length > 200) {
    errors.push('title must be 200 characters or fewer');
  }

  const body = String(req.body?.body || '').trim();
  if (!body) {
    errors.push('body is required');
  } else if (body.length > 1200) {
    errors.push('body must be 1200 characters or fewer');
  }

  if (
    req.body?.shortBody !== undefined &&
    String(req.body.shortBody).trim().length > 280
  ) {
    errors.push('shortBody must be 280 characters or fewer');
  }

  if (
    req.body?.eventType !== undefined &&
    String(req.body.eventType).trim().length > 120
  ) {
    errors.push('eventType must be 120 characters or fewer');
  }

  if (
    req.body?.route !== undefined &&
    String(req.body.route).trim().length > 320
  ) {
    errors.push('route must be 320 characters or fewer');
  }

  if (
    req.body?.imageUrl !== undefined &&
    String(req.body.imageUrl).trim().length > 1200
  ) {
    errors.push('imageUrl must be 1200 characters or fewer');
  }

  if (
    req.body?.notificationType !== undefined &&
    !inEnum(String(req.body.notificationType).toUpperCase(), VALID_TYPES)
  ) {
    errors.push(`notificationType must be one of ${VALID_TYPES.join(', ')}`);
  }

  if (
    req.body?.priority !== undefined &&
    !inEnum(String(req.body.priority).toUpperCase(), VALID_PRIORITIES)
  ) {
    errors.push(`priority must be one of ${VALID_PRIORITIES.join(', ')}`);
  }

  if (!isBlank(req.body?.tenantId) && !isUuid(req.body.tenantId)) {
    errors.push('tenantId must be a valid UUID when provided');
  }

  const roleCodes = Array.isArray(req.body?.roleCodes)
    ? req.body.roleCodes
    : [];
  if (audience === NotificationBroadcastAudiences.ROLES_IN_TENANT) {
    if (roleCodes.length === 0) {
      errors.push('roleCodes is required when audience=roles_in_tenant');
    } else if (roleCodes.some((item) => isBlank(item))) {
      errors.push('roleCodes must not contain blank values');
    }
  } else if (roleCodes.some((item) => isBlank(item))) {
    errors.push('roleCodes must not contain blank values');
  }

  const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  if (audience === NotificationBroadcastAudiences.USER_IDS) {
    if (userIds.length === 0) {
      errors.push('userIds is required when audience=user_ids');
    } else if (userIds.some((item) => !isUuid(item))) {
      errors.push('userIds must only contain valid UUID values');
    }
  } else if (userIds.some((item) => !isUuid(item))) {
    errors.push('userIds must only contain valid UUID values');
  }

  return errors;
};

module.exports = {
  validateNotificationListQuery,
  validateNotificationIdParam,
  validateNotificationPreferencesPatch,
  validateDeviceTokenRegister,
  validateDeviceTokenDelete,
  validateTestPushSend,
  validateBroadcastSend,
};
