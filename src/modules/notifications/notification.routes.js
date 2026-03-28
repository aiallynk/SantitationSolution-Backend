const express = require('express');
const notificationController = require('./notification.controller');
const { protect } = require('../../core/middleware/auth');

const router = express.Router();

router.use(protect);
router.get('/notifications/my', notificationController.getMyNotifications);

module.exports = router;
