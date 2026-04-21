const express = require('express');
const notificationController = require('./notification.controller');
const {
  validateNotificationListQuery,
  validateNotificationIdParam,
  validateNotificationPreferencesPatch,
  validateDeviceTokenRegister,
  validateDeviceTokenDelete,
  validateTestPushSend,
  validateBroadcastSend,
} = require('./notification.validator');
const { protect, requireRoles } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const { createImageDiskUpload } = require('../media/uploadPolicy');

const router = express.Router();
const NOTIFICATION_BROADCAST_ROLE_CODES = [
  'platform_ops',
  'tenant_admin',
  'country_admin',
  'state_admin',
  'district_admin',
  'city_admin',
  'zone_admin',
  'facility_manager',
];
const BROADCAST_IMAGE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const broadcastImageUpload = createImageDiskUpload({
  filenamePrefix: 'notification-broadcast',
  tempSubdir: 'notification-broadcast',
  maxFileSize: BROADCAST_IMAGE_UPLOAD_MAX_BYTES,
});

router.use('/notifications', protect);

// Legacy endpoint used by existing clients.
router.get('/notifications/my', notificationController.getMyNotifications);

router.get(
  '/notifications',
  validate(validateNotificationListQuery),
  notificationController.listNotifications
);
router.get('/notifications/unread-count', notificationController.getUnreadCount);
router.patch('/notifications/read-all', notificationController.markAllRead);
router.patch(
  '/notifications/:id/read',
  validate(validateNotificationIdParam),
  notificationController.markRead
);
router.patch(
  '/notifications/:id/dismiss',
  validate(validateNotificationIdParam),
  notificationController.dismissNotification
);

router.get('/notifications/preferences', notificationController.getPreferences);
router.patch(
  '/notifications/preferences',
  validate(validateNotificationPreferencesPatch),
  notificationController.patchPreferences
);

router.post(
  '/notifications/device-token',
  validate(validateDeviceTokenRegister),
  notificationController.registerDeviceToken
);
router.delete(
  '/notifications/device-token',
  validate(validateDeviceTokenDelete),
  notificationController.removeDeviceToken
);

router.post(
  '/notifications/test-push',
  requireRoles(...NOTIFICATION_BROADCAST_ROLE_CODES),
  validate(validateTestPushSend),
  notificationController.sendTestPush
);
router.post(
  '/notifications/broadcast-image',
  requireRoles(...NOTIFICATION_BROADCAST_ROLE_CODES),
  broadcastImageUpload.single('image'),
  notificationController.uploadBroadcastImage
);
router.post(
  '/notifications/broadcast',
  requireRoles(...NOTIFICATION_BROADCAST_ROLE_CODES),
  validate(validateBroadcastSend),
  notificationController.sendBroadcast
);

module.exports = router;
