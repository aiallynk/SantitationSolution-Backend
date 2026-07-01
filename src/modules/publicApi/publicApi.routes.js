const express = require('express');
const publicApiController = require('./publicApi.controller');
const { authenticatePublicApiKey } = require('./publicApiAuth.middleware');
const { publicUsageLogger } = require('./apiUsage.service');

const router = express.Router();

router.use(publicUsageLogger);

router.get(
  '/toilets/nearby',
  authenticatePublicApiKey,
  publicApiController.getNearbyToilets
);

module.exports = router;
