const express = require('express');
const appUpdateController = require('./appUpdate.controller');

const router = express.Router();

router.get('/app/update', appUpdateController.getAppUpdateMetadata);
router.get('/app/apk/:version', appUpdateController.downloadApkByVersion);

module.exports = router;
