const NotificationChannels = Object.freeze({
  IN_APP_WEB: 'IN_APP_WEB',
  IN_APP_MOBILE: 'IN_APP_MOBILE',
  PUSH_MOBILE: 'PUSH_MOBILE',
  PUSH_WEB: 'PUSH_WEB',
  EMAIL_READY: 'EMAIL_READY',
  SMS_READY: 'SMS_READY',
});

const NotificationTypes = Object.freeze({
  TASK: 'TASK',
  INSPECTION: 'INSPECTION',
  AI_ALERT: 'AI_ALERT',
  APPROVAL: 'APPROVAL',
  COMPLAINT: 'COMPLAINT',
  SYSTEM: 'SYSTEM',
  ACCOUNT: 'ACCOUNT',
  FACILITY: 'FACILITY',
  REPORT: 'REPORT',
  ALERT: 'ALERT',
});

const NotificationPriorities = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

const NotificationDeliveryStates = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  READ: 'READ',
  DISMISSED: 'DISMISSED',
});

const NotificationAudienceKinds = Object.freeze({
  USER: 'USER',
  ROLE_IN_TENANT: 'ROLE_IN_TENANT',
  SUPERVISORS_IN_WARD: 'SUPERVISORS_IN_WARD',
  SUPERVISORS_IN_ZONE: 'SUPERVISORS_IN_ZONE',
  TENANT_ADMINS: 'TENANT_ADMINS',
  PLATFORM_ADMINS: 'PLATFORM_ADMINS',
  WORKER_SUPERVISOR: 'WORKER_SUPERVISOR',
  TARGETED_LIST: 'TARGETED_LIST',
  AUDIT_ROUTED: 'AUDIT_ROUTED',
});

const NotificationPlatforms = Object.freeze({
  ANDROID: 'android',
  IOS: 'ios',
  WEB: 'web',
});

const NotificationBroadcastAudiences = Object.freeze({
  SELF: 'self',
  TENANT_USERS: 'tenant_users',
  ROLES_IN_TENANT: 'roles_in_tenant',
  USER_IDS: 'user_ids',
});

const DEFAULT_NOTIFICATION_TYPES = Object.freeze([
  NotificationTypes.TASK,
  NotificationTypes.INSPECTION,
  NotificationTypes.AI_ALERT,
  NotificationTypes.APPROVAL,
  NotificationTypes.COMPLAINT,
  NotificationTypes.SYSTEM,
  NotificationTypes.ACCOUNT,
  NotificationTypes.FACILITY,
  NotificationTypes.REPORT,
  NotificationTypes.ALERT,
]);

const DEFAULT_PREFERENCE_BY_TYPE = Object.freeze({
  [NotificationTypes.TASK]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: true,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.INSPECTION]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: true,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.AI_ALERT]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: true,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.APPROVAL]: {
    inAppWeb: true,
    inAppMobile: false,
    pushMobile: false,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.COMPLAINT]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: true,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.SYSTEM]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: true,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.ACCOUNT]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: false,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.FACILITY]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: false,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.REPORT]: {
    inAppWeb: true,
    inAppMobile: false,
    pushMobile: false,
    pushWeb: true,
    email: false,
    sms: false,
  },
  [NotificationTypes.ALERT]: {
    inAppWeb: true,
    inAppMobile: true,
    pushMobile: true,
    pushWeb: true,
    email: false,
    sms: false,
  },
});

module.exports = {
  NotificationChannels,
  NotificationTypes,
  NotificationPriorities,
  NotificationDeliveryStates,
  NotificationAudienceKinds,
  NotificationPlatforms,
  NotificationBroadcastAudiences,
  DEFAULT_NOTIFICATION_TYPES,
  DEFAULT_PREFERENCE_BY_TYPE,
};
