const express = require('express');
const { protect } = require('../../core/middleware/auth');
const { registerClient } = require('../../core/live/sseBroker');

const router = express.Router();

router.get('/live/stream', protect, (req, res) => {
  registerClient(req, res, {
    tenantId: req.user.tenantId,
    roleCode: req.user.roleCodes?.[0] || null,
  });
});

module.exports = router;
