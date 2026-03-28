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

module.exports = {
  getMyNotifications,
};
