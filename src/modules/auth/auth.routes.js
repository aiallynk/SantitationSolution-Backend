const express = require('express');
const authController = require('./auth.controller');
const { validate } = require('../../core/middleware/validate');
const { validateLoginRequest } = require('./auth.validator');
const { protect } = require('../../core/middleware/auth');

const router = express.Router();

router.post('/login', validate(validateLoginRequest), authController.login);
router.get('/me', protect, authController.getMe);

module.exports = router;
