const express = require('express');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const auditController = require('./audit.controller');

const router = express.Router();

router.use(protect);

router.get('/audit-logs', requirePermissions('audit.read'), auditController.getAuditLogs);

module.exports = router;
