const express = require('express');
const workerImportController = require('./workerImport.controller');
const { protect, requirePermissions, requireAction, requireRouteKey, requireScope, requireSurface } = require('../../core/middleware/auth');
const { ManagementLevels, RouteKeys, SurfaceTypes } = require('../../core/rbac/accessMatrix');
const { createCsvDiskUpload } = require('../media/uploadPolicy');
const { uploadRateLimit } = require('../../core/security/rateLimit');

const router = express.Router();
const upload = createCsvDiskUpload({
  filenamePrefix: 'worker-import',
  tempSubdir: 'worker-imports',
  maxFileSize: 2 * 1024 * 1024,
});

router.use('/workers/import', protect);
router.use(
  '/workers/import',
  requireSurface(SurfaceTypes.OPS_WEB, SurfaceTypes.OPS_WEB_AND_MOBILE, SurfaceTypes.PLATFORM_WEB),
  requireRouteKey(RouteKeys.OPS_USERS, RouteKeys.SA_GLOBAL_USERS),
  requireScope({
    managementLevels: [ManagementLevels.PLATFORM, ManagementLevels.TENANT, ManagementLevels.GEOGRAPHY],
  }),
);

router.get(
  '/workers/import/template',
  requirePermissions('worker.bulk_import.template'),
  workerImportController.downloadTemplate,
);
router.post(
  '/workers/import/validate',
  requirePermissions('worker.bulk_import.validate'),
  requireAction('user.manage'),
  uploadRateLimit,
  upload.single('file'),
  workerImportController.validateImportFile,
);
router.post(
  '/workers/import/:importJobId/confirm',
  requirePermissions('worker.bulk_import.confirm'),
  requireAction('user.manage'),
  uploadRateLimit,
  workerImportController.confirmImport,
);
router.get(
  '/workers/import/history',
  requirePermissions('worker.bulk_import.history'),
  workerImportController.getHistory,
);
router.get(
  '/workers/import/:importJobId',
  requirePermissions('worker.bulk_import.history'),
  workerImportController.getJobById,
);
router.get(
  '/workers/import/:importJobId/results',
  requirePermissions('worker.bulk_import.history'),
  workerImportController.downloadResults,
);

module.exports = router;
