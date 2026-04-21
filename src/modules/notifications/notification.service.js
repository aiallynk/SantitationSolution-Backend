const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  NotificationEvent,
  NotificationPreference,
  NotificationDeviceToken,
  NotificationDeliveryLog,
  InspectionTask,
  Inspection,
  Complaint,
  Alert,
  PlatformUser,
} = require('../../models');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const {
  NotificationTypes,
  NotificationPriorities,
  NotificationDeliveryStates,
  NotificationAudienceKinds,
  NotificationPlatforms,
  NotificationBroadcastAudiences,
  DEFAULT_NOTIFICATION_TYPES,
  DEFAULT_PREFERENCE_BY_TYPE,
} = require('./notification.constants');
const {
  uniqueIds,
  resolveUsersByRoleAndScope,
  resolveTenantAdminIds,
  resolveSupervisorIds,
  resolvePlatformAdminIds,
  resolveDirectSupervisorIdsForWorker,
} = require('./notification.recipientResolver');
const { ROLE_CODES } = require('../../core/rbac/personaFamilies');
const { sendPushBatch } = require('./notification.fcm');
const { uploadImage, removeTempFile } = require('../media/storage.service');
const { resolveMediaUrl } = require('../media/mediaUrl.service');
const { runtimeConfig } = require('../../config/runtime');

const IN_APP_CHANNEL = 'in_app';
const PUSH_CHANNEL = 'push_mobile';
const MOBILE_PUSH_PLATFORMS = ['android', 'ios'];
const WEB_PUSH_PLATFORMS = ['web'];
const BROADCAST_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const VALID_PLATFORMS = Object.values(NotificationPlatforms);
const INVALID_FCM_TOKEN_CODES = [
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
];
const MAX_BROADCAST_RECIPIENTS = 2000;
const BROADCAST_ALLOWED_ROLE_CODES = new Set([
  ROLE_CODES.PLATFORM_OPS,
  ROLE_CODES.TENANT_ADMIN,
  ROLE_CODES.COUNTRY_ADMIN,
  ROLE_CODES.STATE_ADMIN,
  ROLE_CODES.DISTRICT_ADMIN,
  ROLE_CODES.CITY_ADMIN,
  ROLE_CODES.ZONE_ADMIN,
  ROLE_CODES.FACILITY_MANAGER,
]);

const toShortId = (value) => String(value || '').trim().slice(0, 8).toUpperCase();
const maskToken = (value) => {
  const token = String(value || '').trim();
  if (token.length <= 14) {
    return token;
  }
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
};

const normalizePublicBaseUrl = (value) => {
  const normalized = String(value || '').trim().replace(/\/+$/, '');
  if (!normalized) return '';
  if (!/^https?:\/\//i.test(normalized)) return '';
  return normalized;
};

const resolveApiPublicBaseUrl = () => {
  const configured = normalizePublicBaseUrl(runtimeConfig.urls.apiPublicBaseUrl);
  if (configured) {
    return configured;
  }

  const protocol = runtimeConfig.isProduction ? 'https' : 'http';
  const host = 'localhost';
  const port = Number(runtimeConfig.app.port || 5000);
  const safePort = Number.isFinite(port) && port > 0 ? port : 5000;
  const includePort = !(
    (protocol === 'http' && safePort === 80) ||
    (protocol === 'https' && safePort === 443)
  );
  return `${protocol}://${host}${includePort ? `:${safePort}` : ''}`;
};

const toAbsolutePublicUrl = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith('data:')) {
    return normalized;
  }
  const base = resolveApiPublicBaseUrl();
  const path = normalized.startsWith('/')
    ? normalized
    : `/${normalized.replace(/^\/+/, '')}`;
  return `${base}${path}`;
};

const resolveBroadcastImageUrl = async (value) => {
  const normalized = sanitizeText(value, 1200);
  if (!normalized) return null;
  if (/^https?:\/\//i.test(normalized) || normalized.startsWith('data:')) {
    return normalized;
  }

  const resolved = await resolveMediaUrl({
    fileUrl: normalized,
  });
  if (!resolved) return null;
  return toAbsolutePublicUrl(resolved);
};

const normalizePriority = (value, fallback = NotificationPriorities.MEDIUM) => {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (!Object.values(NotificationPriorities).includes(normalized)) {
    return fallback;
  }
  return normalized;
};

const normalizeNotificationType = (value, fallback = NotificationTypes.SYSTEM) => {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (!Object.values(NotificationTypes).includes(normalized)) {
    return fallback;
  }
  return normalized;
};

const normalizeState = (value, fallback = NotificationDeliveryStates.SENT) => {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (!Object.values(NotificationDeliveryStates).includes(normalized)) {
    return fallback;
  }
  return normalized;
};

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const toBoolean = (value, fallback = false) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const normalizeRoleCodes = (roleCodes = []) =>
  uniqueIds((Array.isArray(roleCodes) ? roleCodes : []).map((code) => String(code || '').trim().toLowerCase()));

const normalizeBroadcastAudience = (value) => {
  const normalized = String(value || NotificationBroadcastAudiences.SELF).trim().toLowerCase();
  if (!Object.values(NotificationBroadcastAudiences).includes(normalized)) {
    return NotificationBroadcastAudiences.SELF;
  }
  return normalized;
};

const normalizeBroadcastTemplate = (value) => {
  const normalized = String(value || 'custom').trim().toLowerCase();
  if (!['custom', 'alert', 'test'].includes(normalized)) {
    return 'custom';
  }
  return normalized;
};

const resolveBroadcastTemplateDefaults = (template) => {
  if (template === 'alert') {
    return {
      eventType: 'manual.alert.broadcast',
      notificationType: NotificationTypes.ALERT,
      priority: NotificationPriorities.HIGH,
      route: '/ops/alerts',
      iconKey: 'alert',
      severity: 'warning',
      title: 'Operational alert',
      body: 'Please review the latest operational alert update.',
    };
  }

  if (template === 'test') {
    return {
      eventType: 'manual.test.broadcast',
      notificationType: NotificationTypes.SYSTEM,
      priority: NotificationPriorities.MEDIUM,
      route: '/ops/overview',
      iconKey: 'system',
      severity: 'info',
      title: 'Notification test',
      body: 'This is a test notification broadcast.',
    };
  }

  return {
    eventType: 'manual.broadcast',
    notificationType: NotificationTypes.SYSTEM,
    priority: NotificationPriorities.MEDIUM,
    route: '/ops/overview',
    iconKey: 'system',
    severity: 'info',
    title: 'Broadcast notification',
    body: 'Please review this platform update.',
  };
};

const assertCanBroadcastNotifications = (user) => {
  if (!user) {
    throw new AppError('Authentication required', 401, {
      code: 'AUTH_REQUIRED',
    });
  }
  if (user.isSuperAdmin) return;

  const roleCodes = normalizeRoleCodes(user.roleCodes || user.allRoleCodes || []);
  const allowed = roleCodes.some((roleCode) => BROADCAST_ALLOWED_ROLE_CODES.has(roleCode));
  if (!allowed) {
    throw new AppError(
      'Only super admin and ops-admin personas can broadcast notifications',
      403,
      { code: 'NOTIFICATION_BROADCAST_FORBIDDEN' }
    );
  }
};

const resolveBroadcastTenantId = ({
  user,
  audience,
  requestedTenantId = null,
}) => {
  const tenantId = requestedTenantId ? String(requestedTenantId).trim() : null;
  if (user?.isSuperAdmin) {
    if (tenantId) {
      return tenantId;
    }
    if (
      audience === NotificationBroadcastAudiences.SELF ||
      audience === NotificationBroadcastAudiences.USER_IDS
    ) {
      return null;
    }
    throw new AppError(
      'tenantId is required for this broadcast audience when using super admin',
      400,
      { code: 'TENANT_ID_REQUIRED' }
    );
  }

  const actorTenantId = user?.tenantId ? String(user.tenantId).trim() : '';
  if (!actorTenantId) {
    throw new AppError('Tenant context is required for broadcast', 403, {
      code: 'TENANT_CONTEXT_REQUIRED',
    });
  }
  if (tenantId && tenantId !== actorTenantId) {
    throw new AppError('Broadcast tenant must match authenticated tenant scope', 403, {
      code: 'TENANT_SCOPE_FORBIDDEN',
    });
  }
  return actorTenantId;
};

const resolveTenantActiveRecipients = async ({ tenantId }) => {
  if (!tenantId) return [];
  const rows = await PlatformUser.findAll({
    where: {
      tenant_id: tenantId,
      status: 'active',
    },
    attributes: ['id'],
    limit: MAX_BROADCAST_RECIPIENTS + 1,
  });
  return uniqueIds(rows.map((row) => row.id));
};

const resolveUserIdRecipients = async ({
  userIds = [],
  tenantId = null,
  isSuperAdmin = false,
}) => {
  const normalizedUserIds = uniqueIds(userIds);
  if (normalizedUserIds.length === 0) return [];

  const where = {
    id: { [Op.in]: normalizedUserIds },
    status: 'active',
  };
  if (tenantId) {
    where.tenant_id = tenantId;
  } else if (!isSuperAdmin) {
    where.tenant_id = null;
  }

  const rows = await PlatformUser.findAll({
    where,
    attributes: ['id'],
  });
  return uniqueIds(rows.map((row) => row.id));
};

const resolveBroadcastRecipients = async ({
  req,
  audience,
  tenantId = null,
  roleCodes = [],
  userIds = [],
}) => {
  if (audience === NotificationBroadcastAudiences.SELF) {
    return uniqueIds([req.user.id]);
  }

  if (audience === NotificationBroadcastAudiences.TENANT_USERS) {
    return resolveTenantActiveRecipients({ tenantId });
  }

  if (audience === NotificationBroadcastAudiences.ROLES_IN_TENANT) {
    const normalizedRoleCodes = normalizeRoleCodes(roleCodes);
    if (normalizedRoleCodes.length === 0) {
      throw new AppError('roleCodes is required for roles_in_tenant audience', 400, {
        code: 'VALIDATION_ERROR',
      });
    }
    return resolveUsersByRoleAndScope({
      roleCodes: normalizedRoleCodes,
      tenantId,
    });
  }

  if (audience === NotificationBroadcastAudiences.USER_IDS) {
    return resolveUserIdRecipients({
      userIds,
      tenantId,
      isSuperAdmin: Boolean(req.user?.isSuperAdmin),
    });
  }

  throw new AppError('Unsupported broadcast audience', 400, {
    code: 'VALIDATION_ERROR',
  });
};

const mapNotificationRow = (row) => ({
  id: row.id,
  tenantId: row.tenant_id || null,
  userId: row.user_id || null,
  eventType: row.event_type,
  notificationType: row.notification_type || NotificationTypes.SYSTEM,
  channel: row.channel,
  priority: row.priority || NotificationPriorities.MEDIUM,
  title: row.title || row.payload?.title || null,
  body: row.body || row.payload?.body || row.payload?.message || null,
  shortBody: row.short_body || row.payload?.shortBody || null,
  entityType: row.entity_type || null,
  entityId: row.entity_id || null,
  route: row.route || row.payload?.route || null,
  iconKey: row.icon_key || null,
  severity: row.severity || null,
  audienceKind: row.audience_kind || null,
  payload: row.payload || {},
  metadata: row.metadata || {},
  status: row.status || 'sent',
  deliveryState: row.delivery_state || NotificationDeliveryStates.SENT,
  readAt: row.read_at || null,
  dismissedAt: row.dismissed_at || null,
  dedupeKey: row.dedupe_key || null,
  sentAt: row.sent_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  isRead: Boolean(row.read_at),
  isDismissed: Boolean(row.dismissed_at),
});

const mapLegacyNotificationRow = (row) => ({
  id: row.id,
  eventType: row.eventType,
  channel: row.channel,
  payload: row.payload,
  status: row.status,
  sentAt: row.sentAt,
  createdAt: row.createdAt,
});

const resolveDefaultPreference = (notificationType) => {
  const normalizedType = normalizeNotificationType(notificationType);
  return (
    DEFAULT_PREFERENCE_BY_TYPE[normalizedType] ||
    DEFAULT_PREFERENCE_BY_TYPE[NotificationTypes.SYSTEM]
  );
};

const mapPreferenceRow = (notificationType, row = null) => {
  const defaults = resolveDefaultPreference(notificationType);
  return {
    notificationType,
    inAppWebEnabled:
      row?.in_app_web_enabled !== undefined
        ? Boolean(row.in_app_web_enabled)
        : defaults.inAppWeb,
    inAppMobileEnabled:
      row?.in_app_mobile_enabled !== undefined
        ? Boolean(row.in_app_mobile_enabled)
        : defaults.inAppMobile,
    pushMobileEnabled:
      row?.push_mobile_enabled !== undefined
        ? Boolean(row.push_mobile_enabled)
        : defaults.pushMobile,
    pushWebEnabled:
      row?.push_web_enabled !== undefined
        ? Boolean(row.push_web_enabled)
        : defaults.pushWeb,
    emailEnabled:
      row?.email_enabled !== undefined ? Boolean(row.email_enabled) : defaults.email,
    smsEnabled: row?.sms_enabled !== undefined ? Boolean(row.sms_enabled) : defaults.sms,
  };
};

const mapDeviceTokenRow = (row) => ({
  id: row.id,
  userId: row.user_id,
  tenantId: row.tenant_id,
  platform: row.platform,
  token: row.token,
  deviceId: row.device_id || null,
  appVersion: row.app_version || null,
  locale: row.locale || null,
  metadata: row.metadata || {},
  lastActiveAt: row.last_active_at || null,
  disabledAt: row.disabled_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const getChannelSettingsForUser = async ({ userId, notificationType }) => {
  const normalizedType = normalizeNotificationType(notificationType);
  const row = await NotificationPreference.findOne({
    where: {
      user_id: userId,
      notification_type: normalizedType,
    },
  });
  const resolved = mapPreferenceRow(normalizedType, row);
  const pushMobileEnabled = Boolean(resolved.pushMobileEnabled);
  const pushWebEnabled = Boolean(resolved.pushWebEnabled);
  return {
    normalizedType,
    inAppEnabled: resolved.inAppWebEnabled || resolved.inAppMobileEnabled,
    pushMobileEnabled,
    pushWebEnabled,
    pushEnabled: pushMobileEnabled || pushWebEnabled,
    preference: resolved,
  };
};

const emitNotificationLive = (notificationRow) => {
  eventBus.emit(EVENTS.NOTIFICATION_CREATED, {
    id: notificationRow.id,
    tenantId: notificationRow.tenant_id || null,
    userId: notificationRow.user_id || null,
    notificationType: notificationRow.notification_type || NotificationTypes.SYSTEM,
    priority: notificationRow.priority || NotificationPriorities.MEDIUM,
    title: notificationRow.title || notificationRow.payload?.title || null,
    body: notificationRow.short_body || notificationRow.body || notificationRow.payload?.message || null,
    route: notificationRow.route || notificationRow.payload?.route || null,
    entityType: notificationRow.entity_type || null,
    entityId: notificationRow.entity_id || null,
    createdAt: notificationRow.created_at,
    deliveryState: notificationRow.delivery_state || NotificationDeliveryStates.SENT,
  });
};

const createDeliveryLog = async ({
  notificationId,
  userId,
  channel,
  provider = null,
  providerMessageId = null,
  deviceTokenId = null,
  status,
  errorCode = null,
  errorMessage = null,
  metadata = null,
}) => {
  return NotificationDeliveryLog.create({
    notification_id: notificationId,
    user_id: userId || null,
    channel,
    provider,
    provider_message_id: providerMessageId || null,
    device_token_id: deviceTokenId || null,
    status: String(status || 'PENDING').toUpperCase(),
    error_code: errorCode || null,
    error_message: errorMessage || null,
    attempted_at: new Date(),
    delivered_at:
      String(status || '').toUpperCase() === 'SENT' ? new Date() : null,
    metadata: metadata || null,
  });
};

const disableInvalidTokens = async (tokenIds = []) => {
  const ids = uniqueIds(tokenIds);
  if (ids.length === 0) return;
  await NotificationDeviceToken.update(
    {
      disabled_at: new Date(),
      updated_at: new Date(),
    },
    {
      where: {
        id: { [Op.in]: ids },
        disabled_at: null,
      },
    }
  );
};

const maybeDeliverPushForNotification = async ({
  notification,
  pushMobileEnabled,
  pushWebEnabled,
}) => {
  const allowedPlatforms = uniqueIds([
    ...(pushMobileEnabled ? MOBILE_PUSH_PLATFORMS : []),
    ...(pushWebEnabled ? WEB_PUSH_PLATFORMS : []),
  ]);
  if (allowedPlatforms.length === 0) return;

  const deviceTokens = await NotificationDeviceToken.findAll({
    where: {
      user_id: notification.user_id,
      platform: { [Op.in]: allowedPlatforms },
      disabled_at: null,
    },
    attributes: ['id', 'token', 'platform'],
  });

  if (deviceTokens.length === 0) {
    await createDeliveryLog({
      notificationId: notification.id,
      userId: notification.user_id,
      channel: PUSH_CHANNEL,
      provider: 'fcm',
      status: 'FAILED',
      errorCode: 'NO_ACTIVE_DEVICE_TOKEN',
      errorMessage: `No active push device token found for user on platforms: ${allowedPlatforms.join(', ')}`,
    });
    return;
  }

  const tokenByValue = new Map(deviceTokens.map((row) => [row.token, row]));
  const imageUrl = await resolveBroadcastImageUrl(
    notification.payload?.imageUrl ||
      notification.payload?.image ||
      notification.metadata?.imageUrl ||
      null
  );
  const pushResult = await sendPushBatch({
    tokens: deviceTokens.map((row) => row.token),
    title: notification.title || notification.payload?.title || 'Notification',
    body:
      notification.short_body ||
      notification.body ||
      notification.payload?.body ||
      notification.payload?.message ||
      'You have a new update',
    data: {
      notificationId: notification.id,
      tenantId: notification.tenant_id || '',
      route: notification.route || '',
      entityType: notification.entity_type || '',
      entityId: notification.entity_id || '',
      notificationType: notification.notification_type || NotificationTypes.SYSTEM,
      priority: notification.priority || NotificationPriorities.MEDIUM,
      ...(imageUrl ? { imageUrl } : {}),
    },
    imageUrl,
  });

  const invalidTokenIds = [];
  for (const response of pushResult.responses || []) {
    const tokenRow = tokenByValue.get(response.token);
    const isSuccess = Boolean(response.success);
    const code = response.errorCode || null;

    await createDeliveryLog({
      notificationId: notification.id,
      userId: notification.user_id,
      channel: PUSH_CHANNEL,
      provider: 'fcm',
      providerMessageId: response.messageId || null,
      deviceTokenId: tokenRow?.id || null,
      status: isSuccess ? 'SENT' : 'FAILED',
      errorCode: code,
      errorMessage: response.errorMessage || null,
      metadata: {
        enabled: pushResult.enabled,
      },
    });

    if (!isSuccess && code) {
      const normalizedCode = String(code).toLowerCase();
      if (
        INVALID_FCM_TOKEN_CODES.some((item) =>
          normalizedCode.includes(String(item).toLowerCase())
        )
      ) {
        if (tokenRow?.id) invalidTokenIds.push(tokenRow.id);
      }
    }
  }

  await disableInvalidTokens(invalidTokenIds);
};

const createNotificationRows = async ({
  recipients = [],
  eventType,
  notificationType,
  priority,
  title,
  body,
  shortBody = null,
  entityType = null,
  entityId = null,
  route = null,
  iconKey = null,
  severity = null,
  tenantId = null,
  geographyId = null,
  facilityId = null,
  audienceKind = NotificationAudienceKinds.TARGETED_LIST,
  createdByUserId = null,
  dedupeKey = null,
  metadata = null,
  payload = null,
}) => {
  const userIds = uniqueIds(recipients);
  if (userIds.length === 0) {
    return [];
  }

  const [activeRows, existingDedupeRows] = await Promise.all([
    PlatformUser.findAll({
      where: {
        id: { [Op.in]: userIds },
        status: 'active',
      },
      attributes: ['id'],
    }),
    dedupeKey
      ? NotificationEvent.findAll({
          where: {
            user_id: { [Op.in]: userIds },
            dedupe_key: dedupeKey,
          },
          attributes: ['id', 'user_id'],
          limit: userIds.length,
        })
      : Promise.resolve([]),
  ]);

  const activeUserIds = activeRows.map((row) => row.id);
  const dedupedUserIds = new Set((existingDedupeRows || []).map((row) => String(row.user_id)));
  const normalizedType = normalizeNotificationType(notificationType);
  const normalizedPriority = normalizePriority(priority);
  const now = new Date();
  const rowsToCreate = [];
  const channelSettingsByUser = new Map();

  for (const userId of activeUserIds) {
    if (dedupedUserIds.has(String(userId))) {
      continue;
    }

    const channelSettings = await getChannelSettingsForUser({
      userId,
      notificationType: normalizedType,
    });
    channelSettingsByUser.set(String(userId), channelSettings);

    if (!channelSettings.inAppEnabled && !channelSettings.pushEnabled) {
      continue;
    }

    const resolvedPayload = {
      ...(payload || {}),
      title,
      body,
      shortBody: shortBody || null,
      route: route || null,
      entityType: entityType || null,
      entityId: entityId ? String(entityId) : null,
      notificationType: normalizedType,
      priority: normalizedPriority,
      eventType,
      metadata: metadata || null,
    };

    rowsToCreate.push({
      tenant_id: tenantId || null,
      user_id: userId,
      event_type: String(eventType || 'system.event').slice(0, 120),
      channel: IN_APP_CHANNEL,
      notification_type: normalizedType,
      priority: normalizedPriority,
      title: title ? sanitizeText(title, 200) : null,
      body: body ? sanitizeText(body, 1200) : null,
      short_body: shortBody ? sanitizeText(shortBody, 280) : null,
      entity_type: entityType ? String(entityType).slice(0, 120) : null,
      entity_id: entityId ? String(entityId).slice(0, 120) : null,
      route: route ? String(route).slice(0, 320) : null,
      icon_key: iconKey ? String(iconKey).slice(0, 80) : null,
      severity: severity ? String(severity).slice(0, 20) : null,
      created_by_user_id: createdByUserId || null,
      geography_id: geographyId || null,
      facility_id: facilityId || null,
      audience_kind: audienceKind || null,
      payload: resolvedPayload,
      status: 'sent',
      delivery_state: NotificationDeliveryStates.SENT,
      read_at: null,
      dismissed_at: null,
      dedupe_key: dedupeKey ? String(dedupeKey).slice(0, 220) : null,
      metadata: {
        ...(metadata || {}),
        channels: {
          inAppEnabled: channelSettings.inAppEnabled,
          pushMobileEnabled: channelSettings.pushMobileEnabled,
          pushWebEnabled: channelSettings.pushWebEnabled,
          pushEnabled: channelSettings.pushEnabled,
        },
      },
      sent_at: now,
      created_at: now,
      updated_at: now,
    });
  }

  if (rowsToCreate.length === 0) {
    return [];
  }

  const createdRows = await NotificationEvent.bulkCreate(rowsToCreate, {
    returning: true,
  });

  for (const row of createdRows) {
    emitNotificationLive(row);
    const channelSettings = channelSettingsByUser.get(String(row.user_id));
    await maybeDeliverPushForNotification({
      notification: row,
      pushMobileEnabled: Boolean(channelSettings?.pushMobileEnabled),
      pushWebEnabled: Boolean(channelSettings?.pushWebEnabled),
    });
  }

  return createdRows;
};

const buildActionRoute = ({ action, entityId }) => {
  const entityValue = entityId ? String(entityId) : '';
  if (action.startsWith('task.')) {
    return entityValue ? `/ops/tasks/${entityValue}` : '/ops/tasks';
  }
  if (action.startsWith('inspection.')) {
    return entityValue ? `/ops/inspections/${entityValue}` : '/ops/inspections';
  }
  if (action.startsWith('analysis.')) {
    return entityValue ? `/ops/inspections/${entityValue}` : '/ops/inspections';
  }
  if (action.startsWith('complaint.')) {
    return entityValue ? `/ops/complaints/${entityValue}` : '/ops/complaints';
  }
  if (action.startsWith('alert.')) {
    return '/ops/alerts';
  }
  if (action.startsWith('incident.') || action.startsWith('crisis.')) {
    return '/ops/alerts';
  }
  if (action.startsWith('users.')) {
    return entityValue ? `/ops/users/${entityValue}` : '/ops/users';
  }
  if (action.startsWith('auth.')) {
    return '/ops/profile';
  }
  if (action.startsWith('super_admin.approval')) {
    return '/sa/approvals';
  }
  if (action.startsWith('super_admin.tenant')) {
    return '/sa/organizations';
  }
  if (action.startsWith('super_admin.')) {
    return '/sa/action-center';
  }
  if (action.startsWith('facility.') || action.startsWith('geography.') || action.startsWith('tenant.')) {
    return '/ops/admin';
  }
  return '/ops/overview';
};

const classifyAuditAction = ({ action, details = {} }) => {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!normalizedAction) return null;
  if (normalizedAction === 'complaint.dispatch') return null;

  if (normalizedAction.startsWith('task.')) {
    return {
      notificationType: NotificationTypes.TASK,
      priority:
        normalizedAction === 'task.create'
          ? NotificationPriorities.HIGH
          : NotificationPriorities.MEDIUM,
      title:
        normalizedAction === 'task.create'
          ? 'New task assigned'
          : normalizedAction === 'task.complete'
            ? 'Task completed'
            : 'Task updated',
      body:
        normalizedAction === 'task.create'
          ? 'A new operational task has been created in your scope.'
          : normalizedAction === 'task.complete'
            ? 'A task has been marked as completed.'
            : 'A task has changed status.',
      iconKey: 'task',
      severity: 'info',
    };
  }

  if (normalizedAction.startsWith('inspection.')) {
    const isReviewAction = normalizedAction === 'inspection.review';
    const isRejected =
      String(details?.reviewAction || '').toLowerCase() === 'rejected' ||
      String(details?.reviewAction || '').toLowerCase() === 'reinspection_required';
    return {
      notificationType: NotificationTypes.INSPECTION,
      priority: isReviewAction && isRejected ? NotificationPriorities.HIGH : NotificationPriorities.MEDIUM,
      title:
        normalizedAction === 'inspection.submit'
          ? 'Inspection submitted'
          : isReviewAction
            ? 'Inspection reviewed'
            : 'Inspection updated',
      body:
        normalizedAction === 'inspection.submit'
          ? 'Inspection evidence has been submitted for processing.'
          : isReviewAction
            ? 'Inspection review decision is available.'
            : 'Inspection workflow has new activity.',
      iconKey: 'inspection',
      severity: isReviewAction && isRejected ? 'warning' : 'info',
    };
  }

  if (normalizedAction.startsWith('analysis.')) {
    const overallStatus = String(details?.overallStatus || '').toLowerCase();
    const highSeverity = ['poor', 'critical'].includes(overallStatus);
    return {
      notificationType: NotificationTypes.AI_ALERT,
      priority: highSeverity ? NotificationPriorities.HIGH : NotificationPriorities.MEDIUM,
      title: 'AI analysis completed',
      body: highSeverity
        ? 'AI analysis flagged a hygiene risk that needs review.'
        : 'AI analysis results are available.',
      iconKey: 'ai',
      severity: highSeverity ? 'warning' : 'info',
    };
  }

  if (normalizedAction.startsWith('complaint.')) {
    return {
      notificationType: NotificationTypes.COMPLAINT,
      priority:
        normalizedAction === 'complaint.public_create' || normalizedAction === 'complaint.create'
          ? NotificationPriorities.HIGH
          : NotificationPriorities.MEDIUM,
      title:
        normalizedAction === 'complaint.resolve'
          ? 'Complaint resolved'
          : normalizedAction === 'complaint.assign'
            ? 'Complaint assigned'
            : 'Complaint update',
      body: 'Complaint workflow has new activity.',
      iconKey: 'complaint',
      severity: normalizedAction === 'complaint.resolve' ? 'info' : 'warning',
    };
  }

  if (normalizedAction.startsWith('alert.')) {
    return {
      notificationType: NotificationTypes.ALERT,
      priority: NotificationPriorities.HIGH,
      title:
        normalizedAction === 'alert.resolve'
          ? 'Alert resolved'
          : 'Alert acknowledged',
      body: 'Alert state changed in your operational scope.',
      iconKey: 'alert',
      severity: 'warning',
    };
  }

  if (normalizedAction.startsWith('incident.') || normalizedAction.startsWith('crisis.')) {
    return {
      notificationType: NotificationTypes.ALERT,
      priority: NotificationPriorities.CRITICAL,
      title: normalizedAction.startsWith('crisis.')
        ? 'Crisis update'
        : 'Incident update',
      body: 'An operational incident or crisis event needs immediate attention.',
      iconKey: 'alert',
      severity: 'critical',
    };
  }

  if (normalizedAction.startsWith('users.') || normalizedAction.startsWith('auth.')) {
    return {
      notificationType: NotificationTypes.ACCOUNT,
      priority: NotificationPriorities.MEDIUM,
      title: 'Account update',
      body: 'Your account access or profile details were updated.',
      iconKey: 'account',
      severity: 'info',
    };
  }

  if (normalizedAction.startsWith('super_admin.approval')) {
    return {
      notificationType: NotificationTypes.APPROVAL,
      priority: NotificationPriorities.HIGH,
      title: 'Approval workflow update',
      body: 'An approval item requires review or has changed status.',
      iconKey: 'approval',
      severity: 'warning',
    };
  }

  if (normalizedAction.startsWith('super_admin.')) {
    return {
      notificationType: NotificationTypes.SYSTEM,
      priority: NotificationPriorities.MEDIUM,
      title: 'Platform operations update',
      body: 'A super-admin operation was recorded.',
      iconKey: 'system',
      severity: 'info',
    };
  }

  if (
    normalizedAction.startsWith('facility.') ||
    normalizedAction.startsWith('geography.') ||
    normalizedAction.startsWith('tenant.') ||
    normalizedAction.startsWith('toilet_')
  ) {
    return {
      notificationType: NotificationTypes.FACILITY,
      priority: NotificationPriorities.MEDIUM,
      title: 'Facility configuration updated',
      body: 'Facility or geography setup has changed.',
      iconKey: 'facility',
      severity: 'info',
    };
  }

  return null;
};

const resolveAuditRecipients = async ({
  action,
  tenantId = null,
  entityType = null,
  entityId = null,
  actorUserId = null,
}) => {
  const recipients = new Set();
  let resolvedTenantId = tenantId || null;
  let resolvedFacilityId = null;
  let resolvedGeographyId = null;

  const addRecipients = (values = []) => {
    uniqueIds(values).forEach((value) => recipients.add(String(value)));
  };

  if (actorUserId) {
    addRecipients([actorUserId]);
  }

  let task = null;
  let inspection = null;
  let complaint = null;
  let alert = null;

  if (entityType === 'inspection_task' && entityId) {
    task = await InspectionTask.findByPk(entityId, {
      attributes: ['id', 'tenant_id', 'facility_id', 'assigned_to_user_id'],
    });
    if (task) {
      resolvedTenantId = task.tenant_id || resolvedTenantId;
      resolvedFacilityId = task.facility_id || null;
      addRecipients([task.assigned_to_user_id]);
    }
  }

  if (entityType === 'inspection' && entityId) {
    inspection = await Inspection.findByPk(entityId, {
      attributes: ['id', 'tenant_id', 'facility_id', 'inspector_user_id'],
    });
    if (inspection) {
      resolvedTenantId = inspection.tenant_id || resolvedTenantId;
      resolvedFacilityId = inspection.facility_id || null;
      addRecipients([inspection.inspector_user_id]);
    }
  }

  if (entityType === 'complaint' && entityId) {
    complaint = await Complaint.findByPk(entityId, {
      attributes: [
        'id',
        'tenant_id',
        'facility_id',
        'reporter_user_id',
        'assigned_to_user_id',
      ],
    });
    if (complaint) {
      resolvedTenantId = complaint.tenant_id || resolvedTenantId;
      resolvedFacilityId = complaint.facility_id || null;
      addRecipients([complaint.reporter_user_id, complaint.assigned_to_user_id]);
    }
  }

  if (entityType === 'alert' && entityId) {
    alert = await Alert.findByPk(entityId, {
      attributes: ['id', 'tenant_id', 'facility_id', 'assigned_to_user_id'],
    });
    if (alert) {
      resolvedTenantId = alert.tenant_id || resolvedTenantId;
      resolvedFacilityId = alert.facility_id || null;
      addRecipients([alert.assigned_to_user_id]);
    }
  }

  if (resolvedTenantId) {
    const tenantAdminIds = await resolveTenantAdminIds({ tenantId: resolvedTenantId });
    addRecipients(tenantAdminIds);
  }

  const normalizedAction = String(action || '').toLowerCase();
  if (
    resolvedTenantId &&
    (
      normalizedAction.startsWith('task.') ||
      normalizedAction.startsWith('inspection.') ||
      normalizedAction.startsWith('analysis.') ||
      normalizedAction.startsWith('complaint.') ||
      normalizedAction.startsWith('alert.') ||
      normalizedAction.startsWith('incident.') ||
      normalizedAction.startsWith('crisis.')
    )
  ) {
    const supervisorIds = await resolveSupervisorIds({
      tenantId: resolvedTenantId,
      geographyId: resolvedGeographyId,
      facilityId: resolvedFacilityId,
    });
    addRecipients(supervisorIds);
  }

  if (normalizedAction.startsWith('super_admin.')) {
    const platformAdminIds = await resolvePlatformAdminIds();
    addRecipients(platformAdminIds);
  }

  if (task?.assigned_to_user_id && normalizedAction.startsWith('task.')) {
    const directSupervisorIds = await resolveDirectSupervisorIdsForWorker({
      tenantId: resolvedTenantId,
      workerUserId: task.assigned_to_user_id,
    });
    addRecipients(directSupervisorIds);
  }

  return {
    recipientIds: Array.from(recipients.values()),
    tenantId: resolvedTenantId,
    facilityId: resolvedFacilityId,
    geographyId: resolvedGeographyId,
  };
};

const publishNotification = async ({
  recipients = [],
  eventType,
  notificationType = NotificationTypes.SYSTEM,
  priority = NotificationPriorities.MEDIUM,
  title,
  body,
  shortBody = null,
  entityType = null,
  entityId = null,
  route = null,
  iconKey = null,
  severity = null,
  tenantId = null,
  geographyId = null,
  facilityId = null,
  audienceKind = NotificationAudienceKinds.TARGETED_LIST,
  createdByUserId = null,
  dedupeKey = null,
  metadata = null,
  payload = null,
}) => {
  const createdRows = await createNotificationRows({
    recipients,
    eventType,
    notificationType,
    priority,
    title,
    body,
    shortBody,
    entityType,
    entityId,
    route,
    iconKey,
    severity,
    tenantId,
    geographyId,
    facilityId,
    audienceKind,
    createdByUserId,
    dedupeKey,
    metadata,
    payload,
  });

  return createdRows.map((row) => mapNotificationRow(row));
};

const publishFromAuditLog = async ({
  action,
  entityType = null,
  entityId = null,
  tenantId = null,
  actorUserId = null,
  details = null,
  requestId = null,
}) => {
  const descriptor = classifyAuditAction({
    action,
    details: details || {},
  });
  if (!descriptor) {
    return [];
  }

  const recipientContext = await resolveAuditRecipients({
    action,
    tenantId,
    entityType,
    entityId,
    actorUserId,
  });

  if (!recipientContext.recipientIds.length) {
    return [];
  }

  const route = buildActionRoute({ action: String(action || ''), entityId });
  const title = descriptor.title;
  const body = descriptor.body;
  const dedupeKey = `audit:${String(action || '').slice(0, 80)}:${String(entityType || '').slice(0, 80)}:${String(entityId || '').slice(0, 80)}:${String(requestId || '').slice(0, 80)}`;

  return publishNotification({
    recipients: recipientContext.recipientIds,
    eventType: String(action || 'audit.event'),
    notificationType: descriptor.notificationType,
    priority: descriptor.priority,
    title,
    body,
    shortBody: body,
    entityType,
    entityId,
    route,
    iconKey: descriptor.iconKey,
    severity: descriptor.severity,
    tenantId: recipientContext.tenantId || tenantId || null,
    geographyId: recipientContext.geographyId || null,
    facilityId: recipientContext.facilityId || null,
    audienceKind: NotificationAudienceKinds.AUDIT_ROUTED,
    createdByUserId: actorUserId || null,
    dedupeKey,
    metadata: {
      action,
      requestId: requestId || null,
      details: details || null,
    },
    payload: {
      action,
      entityType,
      entityId,
      requestId: requestId || null,
      detailSummary:
        details && typeof details === 'object' && !Array.isArray(details)
          ? Object.keys(details).slice(0, 8)
          : null,
      label: `${String(action || '').replace(/[._]/g, ' ')}`,
      ref: entityId ? `${String(entityType || 'entity')} ${toShortId(entityId)}` : null,
    },
  });
};

const getNotificationList = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query, {
    page: 1,
    limit: 25,
    maxLimit: 100,
  });

  const where = {
    user_id: req.user.id,
  };
  const includeDismissed = toBoolean(req.query.includeDismissed, false);
  if (!includeDismissed) {
    where.dismissed_at = null;
  }

  const unreadOnly = toBoolean(req.query.unreadOnly, false);
  if (unreadOnly) {
    where.read_at = null;
  }

  if (req.query.type) {
    where.notification_type = normalizeNotificationType(req.query.type);
  }
  if (req.query.priority) {
    where.priority = normalizePriority(req.query.priority);
  }

  if (req.user?.isSuperAdmin && req.query.tenantId) {
    where.tenant_id = req.query.tenantId;
  } else if (!req.user?.isSuperAdmin && req.user?.tenantId) {
    where.tenant_id = req.user.tenantId;
  }

  const dateFrom = toDateOrNull(req.query.dateFrom);
  const dateTo = toDateOrNull(req.query.dateTo);
  if (dateFrom || dateTo) {
    where.created_at = {};
    if (dateFrom) where.created_at[Op.gte] = dateFrom;
    if (dateTo) where.created_at[Op.lte] = dateTo;
  }

  const { rows, count } = await NotificationEvent.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map((row) => mapNotificationRow(row)),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getMyNotifications = async (req) => {
  const result = await getNotificationList({
    ...req,
    query: {
      ...req.query,
      includeDismissed: req.query.includeDismissed ?? false,
    },
  });
  return {
    items: result.items.map((item) =>
      mapLegacyNotificationRow({
        ...item,
        sentAt: item.sentAt,
        createdAt: item.createdAt,
      })
    ),
    meta: result.meta,
  };
};

const getUnreadCount = async (req) => {
  const where = {
    user_id: req.user.id,
    read_at: null,
    dismissed_at: null,
  };
  if (!req.user?.isSuperAdmin && req.user?.tenantId) {
    where.tenant_id = req.user.tenantId;
  } else if (req.user?.isSuperAdmin && req.query.tenantId) {
    where.tenant_id = req.query.tenantId;
  }

  const total = await NotificationEvent.count({ where });
  return { unreadCount: total };
};

const markNotificationRead = async (req) => {
  const row = await NotificationEvent.findOne({
    where: {
      id: req.params.id,
      user_id: req.user.id,
    },
  });
  if (!row) {
    return null;
  }

  if (!row.read_at) {
    await row.update({
      read_at: new Date(),
      delivery_state: NotificationDeliveryStates.READ,
      updated_at: new Date(),
    });
  }
  return mapNotificationRow(row);
};

const markAllNotificationsRead = async (req) => {
  const where = {
    user_id: req.user.id,
    read_at: null,
    dismissed_at: null,
  };
  if (!req.user?.isSuperAdmin && req.user?.tenantId) {
    where.tenant_id = req.user.tenantId;
  } else if (req.user?.isSuperAdmin && req.query.tenantId) {
    where.tenant_id = req.query.tenantId;
  }

  const [updatedCount] = await NotificationEvent.update(
    {
      read_at: new Date(),
      delivery_state: NotificationDeliveryStates.READ,
      updated_at: new Date(),
    },
    { where }
  );
  return { updatedCount };
};

const dismissNotification = async (req) => {
  const row = await NotificationEvent.findOne({
    where: {
      id: req.params.id,
      user_id: req.user.id,
    },
  });
  if (!row) {
    return null;
  }
  await row.update({
    dismissed_at: new Date(),
    delivery_state: NotificationDeliveryStates.DISMISSED,
    updated_at: new Date(),
  });
  return mapNotificationRow(row);
};

const getNotificationPreferences = async (req) => {
  const rows = await NotificationPreference.findAll({
    where: { user_id: req.user.id },
  });
  const byType = new Map(rows.map((row) => [row.notification_type, row]));
  const items = DEFAULT_NOTIFICATION_TYPES.map((type) =>
    mapPreferenceRow(type, byType.get(type) || null)
  );
  return {
    items,
    byType: Object.fromEntries(items.map((item) => [item.notificationType, item])),
  };
};

const upsertPreferenceRow = async ({ userId, input }) => {
  const notificationType = normalizeNotificationType(input.notificationType);
  const existing = await NotificationPreference.findOne({
    where: {
      user_id: userId,
      notification_type: notificationType,
    },
  });
  const defaults = resolveDefaultPreference(notificationType);
  const payload = {
    user_id: userId,
    notification_type: notificationType,
    in_app_web_enabled: toBoolean(
      input.inAppWebEnabled,
      defaults.inAppWeb
    ),
    in_app_mobile_enabled: toBoolean(
      input.inAppMobileEnabled,
      defaults.inAppMobile
    ),
    push_mobile_enabled: toBoolean(
      input.pushMobileEnabled,
      defaults.pushMobile
    ),
    push_web_enabled: toBoolean(
      input.pushWebEnabled,
      defaults.pushWeb
    ),
    email_enabled: toBoolean(input.emailEnabled, defaults.email),
    sms_enabled: toBoolean(input.smsEnabled, defaults.sms),
    updated_at: new Date(),
  };
  if (existing) {
    await existing.update(payload);
    return existing;
  }
  return NotificationPreference.create(payload);
};

const patchNotificationPreferences = async (req) => {
  const payloadItems = Array.isArray(req.body?.items)
    ? req.body.items
    : Array.isArray(req.body?.preferences)
      ? req.body.preferences
      : req.body?.notificationType
        ? [req.body]
        : [];

  for (const item of payloadItems) {
    if (!item || !item.notificationType) continue;
    // eslint-disable-next-line no-await-in-loop
    await upsertPreferenceRow({
      userId: req.user.id,
      input: item,
    });
  }
  return getNotificationPreferences(req);
};

const registerDeviceToken = async (req) => {
  const token = String(req.body?.token || '').trim();
  if (!token) {
    throw new AppError('token is required', 400, { code: 'VALIDATION_ERROR' });
  }

  const platform = String(req.body?.platform || '').trim().toLowerCase();
  if (!platform) {
    throw new AppError('platform is required', 400, { code: 'VALIDATION_ERROR' });
  }
  if (!VALID_PLATFORMS.includes(platform)) {
    throw new AppError(
      `platform must be one of ${VALID_PLATFORMS.join(', ')}`,
      400,
      { code: 'VALIDATION_ERROR' }
    );
  }

  const now = new Date();
  const existing = await NotificationDeviceToken.findOne({
    where: { token },
  });

  const payload = {
    user_id: req.user.id,
    tenant_id: req.user.tenantId || null,
    platform,
    token,
    device_id: req.body?.deviceId ? String(req.body.deviceId).slice(0, 180) : null,
    app_version: req.body?.appVersion ? String(req.body.appVersion).slice(0, 80) : null,
    locale: req.body?.locale ? String(req.body.locale).slice(0, 32) : null,
    metadata:
      req.body?.metadata && typeof req.body.metadata === 'object'
        ? req.body.metadata
        : null,
    last_active_at: now,
    disabled_at: null,
    updated_at: now,
  };

  let row = existing;
  if (row) {
    await row.update(payload);
  } else {
    row = await NotificationDeviceToken.create({
      ...payload,
      created_at: now,
    });
  }
  return mapDeviceTokenRow(row);
};

const removeDeviceToken = async (req) => {
  const token = String(req.body?.token || req.query?.token || '').trim();
  const platform = String(req.body?.platform || req.query?.platform || '').trim().toLowerCase();
  const where = {
    user_id: req.user.id,
    disabled_at: null,
  };
  if (token) {
    where.token = token;
  }
  if (platform) {
    where.platform = platform;
  }

  const [updatedCount] = await NotificationDeviceToken.update(
    {
      disabled_at: new Date(),
      updated_at: new Date(),
    },
    { where }
  );
  return { updatedCount };
};

const uploadBroadcastImage = async (req) => {
  assertCanBroadcastNotifications(req.user);

  const filePath = req.file?.path;
  if (!filePath) {
    throw new AppError('image file is required', 400, {
      code: 'IMAGE_REQUIRED',
    });
  }

  const rawFileSize = Number(req.file?.size || 0);
  if (rawFileSize > BROADCAST_IMAGE_MAX_BYTES) {
    throw new AppError('Image must be less than 2MB', 400, {
      code: 'IMAGE_TOO_LARGE',
    });
  }

  const tenantScope =
    sanitizeText(req.body?.tenantId || req.user?.tenantId || null, 120) ||
    'platform';
  const folder = `sanitation/${tenantScope}/notifications/broadcast`;

  let uploaded;
  try {
    uploaded = await uploadImage(filePath, folder);
  } finally {
    await removeTempFile(filePath);
  }

  const resolvedUrl = await resolveMediaUrl({
    fileUrl: uploaded?.fileUrl || null,
    storageKey: uploaded?.storageKey || null,
  });

  const imageUrl = toAbsolutePublicUrl(
    resolvedUrl || uploaded?.fileUrl || null
  );
  if (!imageUrl) {
    throw new AppError('Unable to resolve uploaded image URL', 500, {
      code: 'IMAGE_UPLOAD_URL_RESOLVE_FAILED',
    });
  }

  return {
    imageUrl,
    fileUrl: imageUrl,
    storageKey: uploaded?.storageKey || null,
    bytes: Number(uploaded?.metadata?.bytes || rawFileSize || 0) || 0,
    maxBytes: BROADCAST_IMAGE_MAX_BYTES,
  };
};

const sendBroadcast = async (req) => {
  assertCanBroadcastNotifications(req.user);

  const audience = normalizeBroadcastAudience(req.body?.audience);
  const template = normalizeBroadcastTemplate(req.body?.template);
  const templateDefaults = resolveBroadcastTemplateDefaults(template);
  const tenantId = resolveBroadcastTenantId({
    user: req.user,
    audience,
    requestedTenantId: req.body?.tenantId || req.query?.tenantId || null,
  });

  const recipients = await resolveBroadcastRecipients({
    req,
    audience,
    tenantId,
    roleCodes: req.body?.roleCodes,
    userIds: req.body?.userIds,
  });

  const recipientCount = recipients.length;
  if (recipientCount === 0) {
    throw new AppError('No eligible recipients found for broadcast', 404, {
      code: 'BROADCAST_RECIPIENTS_NOT_FOUND',
    });
  }
  if (recipientCount > MAX_BROADCAST_RECIPIENTS) {
    throw new AppError(
      `Recipient scope is too broad (${recipientCount}). Narrow audience to ${MAX_BROADCAST_RECIPIENTS} or fewer users.`,
      400,
      { code: 'BROADCAST_RECIPIENTS_LIMIT_EXCEEDED' }
    );
  }

  const eventType =
    sanitizeText(
      req.body?.eventType || templateDefaults.eventType || 'manual.broadcast',
      120
    ) || 'manual.broadcast';
  const title =
    sanitizeText(req.body?.title || templateDefaults.title || 'Broadcast notification', 200) ||
    'Broadcast notification';
  const body =
    sanitizeText(
      req.body?.body || templateDefaults.body || 'Please review this platform update.',
      1200
    ) || 'Please review this platform update.';
  const shortBody =
    sanitizeText(req.body?.shortBody || body, 280) || null;
  const route =
    sanitizeText(req.body?.route || templateDefaults.route || '/ops/overview', 320) || null;
  const iconKey = sanitizeText(req.body?.iconKey || templateDefaults.iconKey || '', 80) || null;
  const severity =
    sanitizeText(req.body?.severity || templateDefaults.severity || '', 20) || null;
  const entityType = sanitizeText(req.body?.entityType || 'broadcast', 120) || 'broadcast';
  const entityId = sanitizeText(req.body?.entityId || '', 120) || null;
  const dedupeKey = sanitizeText(req.body?.dedupeKey || '', 220) || null;
  const notificationType = normalizeNotificationType(
    req.body?.notificationType || templateDefaults.notificationType,
    templateDefaults.notificationType
  );
  const priority = normalizePriority(
    req.body?.priority || templateDefaults.priority,
    templateDefaults.priority
  );

  const metadataInput =
    req.body?.metadata &&
    typeof req.body.metadata === 'object' &&
    !Array.isArray(req.body.metadata)
      ? req.body.metadata
      : {};
  const payloadInput =
    req.body?.payload &&
    typeof req.body.payload === 'object' &&
    !Array.isArray(req.body.payload)
      ? req.body.payload
      : {};
  const imageUrl = await resolveBroadcastImageUrl(
    req.body?.imageUrl || payloadInput?.imageUrl || metadataInput?.imageUrl || null
  );

  const metadata = {
    ...metadataInput,
    source: 'manual_broadcast',
    audience,
    template,
    requestedTenantId: tenantId || null,
    requestedByUserId: req.user.id,
    requestedByRole: Array.isArray(req.user.roleCodes)
      ? req.user.roleCodes[0] || null
      : null,
    ...(imageUrl ? { imageUrl } : {}),
  };
  const payload = {
    ...payloadInput,
    title,
    body,
    shortBody,
    route,
    audience,
    template,
    requestedByUserId: req.user.id,
    broadcastedAt: new Date().toISOString(),
    ...(imageUrl ? { imageUrl } : {}),
  };

  const dryRun = toBoolean(req.body?.dryRun, false);
  if (dryRun) {
    return {
      dryRun: true,
      audience,
      template,
      tenantId: tenantId || null,
      imageUrl: imageUrl || null,
      recipientCount,
      recipientsPreview: recipients.slice(0, 20),
    };
  }

  const createdRows = await publishNotification({
    recipients,
    eventType,
    notificationType,
    priority,
    title,
    body,
    shortBody,
    entityType,
    entityId,
    route,
    iconKey,
    severity,
    tenantId: tenantId || null,
    audienceKind: NotificationAudienceKinds.TARGETED_LIST,
    createdByUserId: req.user.id,
    dedupeKey,
    metadata,
    payload,
  });

  return {
    dryRun: false,
    audience,
    template,
    tenantId: tenantId || null,
    imageUrl: imageUrl || null,
    recipientCount,
    createdCount: createdRows.length,
    notificationIds: createdRows.slice(0, 50).map((row) => row.id),
  };
};

const sendTestPush = async (req) => {
  assertCanBroadcastNotifications(req.user);

  const title = sanitizeText(
    req.body?.title || 'Green Toilet Test Notification',
    120
  );
  const body = sanitizeText(
    req.body?.body ||
      'This is a test notification from the sanitation backend.',
    800
  );
  const data =
    req.body?.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data)
      ? req.body.data
      : {};

  const providedTokens = [
    ...(Array.isArray(req.body?.tokens) ? req.body.tokens : []),
    ...(req.body?.token ? [req.body.token] : []),
  ]
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const where = {
    disabled_at: null,
  };
  if (providedTokens.length > 0) {
    where.token = { [Op.in]: [...new Set(providedTokens)] };
  } else {
    where.user_id = req.user.id;
  }

  if (!req.user?.isSuperAdmin) {
    where.user_id = req.user.id;
  }

  const deviceTokens = await NotificationDeviceToken.findAll({
    where,
    attributes: ['id', 'user_id', 'token', 'platform'],
  });

  if (deviceTokens.length === 0) {
    throw new AppError('No active push device token found', 404, {
      code: 'NO_ACTIVE_DEVICE_TOKEN',
    });
  }

  const pushResult = await sendPushBatch({
    tokens: deviceTokens.map((row) => row.token),
    title,
    body,
    data: {
      ...data,
      testPush: true,
      source: 'notifications.test-push',
      requestedByUserId: req.user.id,
    },
  });

  const tokenByValue = new Map(deviceTokens.map((row) => [row.token, row]));
  const invalidTokenIds = [];
  for (const response of pushResult.responses || []) {
    if (response.success) {
      continue;
    }
    const code = String(response.errorCode || '').toLowerCase();
    const isInvalid = INVALID_FCM_TOKEN_CODES.some((item) =>
      code.includes(String(item).toLowerCase())
    );
    if (!isInvalid) {
      continue;
    }
    const tokenRow = tokenByValue.get(response.token);
    if (tokenRow?.id) {
      invalidTokenIds.push(tokenRow.id);
    }
  }
  await disableInvalidTokens(invalidTokenIds);

  return {
    enabled: pushResult.enabled,
    sentCount: pushResult.sentCount,
    failedCount: pushResult.failedCount,
    requestedTokenCount: deviceTokens.length,
    responses: (pushResult.responses || []).map((response) => ({
      token: maskToken(response.token),
      success: Boolean(response.success),
      messageId: response.messageId || null,
      errorCode: response.errorCode || null,
      errorMessage: response.errorMessage || null,
    })),
  };
};

module.exports = {
  getMyNotifications,
  getNotificationList,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  dismissNotification,
  getNotificationPreferences,
  patchNotificationPreferences,
  registerDeviceToken,
  removeDeviceToken,
  uploadBroadcastImage,
  sendBroadcast,
  sendTestPush,
  publishNotification,
  publishFromAuditLog,
};
