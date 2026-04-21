const AppError = require('../../core/errors/AppError');
const { sendSuccess } = require('../../core/http/response');
const notificationService = require('./notification.service');

const getMyNotifications = async (req, res, next) => {
  try {
    const result = await notificationService.getMyNotifications(req);
    return sendSuccess(res, {
      message: 'Notifications fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const listNotifications = async (req, res, next) => {
  try {
    const result = await notificationService.getNotificationList(req);
    return sendSuccess(res, {
      message: 'Notifications fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getUnreadCount = async (req, res, next) => {
  try {
    const result = await notificationService.getUnreadCount(req);
    return sendSuccess(res, {
      message: 'Unread count fetched successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const markRead = async (req, res, next) => {
  try {
    const result = await notificationService.markNotificationRead(req);
    if (!result) {
      throw new AppError('Notification not found', 404, {
        code: 'NOTIFICATION_NOT_FOUND',
      });
    }
    return sendSuccess(res, {
      message: 'Notification marked as read',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const markAllRead = async (req, res, next) => {
  try {
    const result = await notificationService.markAllNotificationsRead(req);
    return sendSuccess(res, {
      message: 'Notifications marked as read',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const dismissNotification = async (req, res, next) => {
  try {
    const result = await notificationService.dismissNotification(req);
    if (!result) {
      throw new AppError('Notification not found', 404, {
        code: 'NOTIFICATION_NOT_FOUND',
      });
    }
    return sendSuccess(res, {
      message: 'Notification dismissed successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const getPreferences = async (req, res, next) => {
  try {
    const result = await notificationService.getNotificationPreferences(req);
    return sendSuccess(res, {
      message: 'Notification preferences fetched successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const patchPreferences = async (req, res, next) => {
  try {
    const result = await notificationService.patchNotificationPreferences(req);
    return sendSuccess(res, {
      message: 'Notification preferences updated successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const registerDeviceToken = async (req, res, next) => {
  try {
    const result = await notificationService.registerDeviceToken(req);
    return sendSuccess(res, {
      message: 'Notification device token registered successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const removeDeviceToken = async (req, res, next) => {
  try {
    const result = await notificationService.removeDeviceToken(req);
    return sendSuccess(res, {
      message: 'Notification device token removed successfully',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const sendTestPush = async (req, res, next) => {
  try {
    const result = await notificationService.sendTestPush(req);
    return sendSuccess(res, {
      message: 'Test push notification processed',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const sendBroadcast = async (req, res, next) => {
  try {
    const result = await notificationService.sendBroadcast(req);
    return sendSuccess(res, {
      message: 'Notification broadcast processed',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

const uploadBroadcastImage = async (req, res, next) => {
  try {
    const result = await notificationService.uploadBroadcastImage(req);
    return sendSuccess(res, {
      message: 'Notification broadcast image uploaded',
      data: result,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getMyNotifications,
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  dismissNotification,
  getPreferences,
  patchPreferences,
  registerDeviceToken,
  removeDeviceToken,
  sendTestPush,
  sendBroadcast,
  uploadBroadcastImage,
};
