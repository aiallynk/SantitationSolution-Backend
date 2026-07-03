const express = require('express');
const inspectionController = require('./inspection.controller');
const { validate } = require('../../core/middleware/validate');
const {
  validateCreateInspection,
  validateInspectionListQuery,
  validateCreateMediaUploadSession,
  validateConfirmMediaUpload,
  validateRetryMediaUpload,
  validateInspectionImageUploadSession,
  validateInspectionImageConfirmUpload,
  validateSubmitInspection,
  validateInspectionSensorReading,
  validateReviewInspection,
} = require('./inspection.validator');
const {
  protect,
  requirePermissions,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { withIdempotency } = require('../../core/idempotency/idempotency.middleware');
const { ingestionRateLimit } = require('../../core/security/rateLimit');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');
const { createInspectionAttachmentDiskUpload } = require('../media/uploadPolicy');
const { runtimeConfig } = require('../../config/runtime');

const router = express.Router();
const INSPECTION_ROUTE_PREFIXES = ['/inspections', '/toilets', '/inspection-images'];

const upload = createInspectionAttachmentDiskUpload({
  filenamePrefix: 'inspection-attachment',
});

router.use(INSPECTION_ROUTE_PREFIXES, protect);
router.use(
  INSPECTION_ROUTE_PREFIXES,
  requireSurface(
    SurfaceTypes.OPS_WEB,
    SurfaceTypes.OPS_WEB_AND_MOBILE,
    SurfaceTypes.MOBILE_ONLY,
  ),
  requireRouteKey(
    RouteKeys.OPS_INSPECTIONS,
    RouteKeys.OPS_AUDITOR_AUDITS,
    RouteKeys.OPS_AUDITOR_EVIDENCE,
  ),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
);

router.post('/inspections', requirePermissions('inspection.create'), validate(validateCreateInspection), inspectionController.postInspection);
router.post(
  '/inspections/start',
  requirePermissions('inspection.create'),
  validate(validateCreateInspection),
  inspectionController.postInspectionStart
);
router.get('/inspections', requirePermissions('inspection.review'), validate(validateInspectionListQuery), inspectionController.getAllInspections);
router.get('/inspections/my', requirePermissions('inspection.create'), validate(validateInspectionListQuery), inspectionController.getMyInspections);
router.get('/toilets/:toiletId/inspections', requirePermissions('dashboard.read'), inspectionController.getToiletInspections);
router.get('/toilets/:id/details', requirePermissions('dashboard.read'), inspectionController.getToiletDetails);
router.get('/toilets/:id/latest-inspection', requirePermissions('dashboard.read'), inspectionController.getToiletLatestInspection);
router.get('/toilets/:id/score-trends', requirePermissions('dashboard.read'), inspectionController.getToiletScoreTrends);
router.get('/toilets/:id/inspection-history', requirePermissions('dashboard.read'), inspectionController.getToiletInspectionHistory);
router.get('/inspections/:id/images', requirePermissions('inspection.create'), inspectionController.getInspectionImages);
router.get('/inspections/:id/image-jobs', requirePermissions('inspection.create'), inspectionController.getInspectionImageJobs);
router.get('/inspections/:id/comparison', requirePermissions('dashboard.read'), inspectionController.getInspectionComparison);
router.get('/inspections/:id/trend', requirePermissions('dashboard.read'), inspectionController.getInspectionTrend);
router.get('/inspection-images/:imageId', requirePermissions('inspection.create'), inspectionController.getInspectionImageById);
router.post('/inspection-images/:imageId/trigger-ai', requirePermissions('inspection.create'), inspectionController.postInspectionImageTriggerAi);
router.post(
  '/inspection-images/upload-session',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.image.upload_session.create', {
    ttlMs: runtimeConfig.media.s3PresignedPutTtlSec * 1000,
  }),
  validate(validateInspectionImageUploadSession),
  inspectionController.postInspectionImageUploadSession
);
router.post(
  '/inspection-images/confirm-upload',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.image.confirm_upload', {
    ttlMs: 30 * 60 * 1000,
  }),
  validate(validateInspectionImageConfirmUpload),
  inspectionController.postInspectionImageConfirmUpload
);
router.get('/inspections/:id', requirePermissions('dashboard.read'), inspectionController.getInspectionById);
// Optional, additive: link a BLE sensor snapshot to an inspection. Never part of the
// submit lifecycle — failure here must never block QR -> Before -> After -> Submit.
router.post(
  '/inspections/:id/sensor-reading',
  requirePermissions('inspection.create'),
  withIdempotency('inspection.sensor_link', { ttlMs: 24 * 60 * 60 * 1000 }),
  validate(validateInspectionSensorReading),
  inspectionController.postInspectionSensorReading
);
router.post(
  '/inspections/:id/media/sessions',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.media.session.create', {
    ttlMs: runtimeConfig.media.s3PresignedPutTtlSec * 1000,
  }),
  validate(validateCreateMediaUploadSession),
  inspectionController.postInspectionMediaUploadSessions
);
router.post(
  '/inspections/:id/media/:mediaId/confirm',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.media.confirm', {
    ttlMs: 30 * 60 * 1000,
  }),
  validate(validateConfirmMediaUpload),
  inspectionController.postInspectionMediaConfirm
);
router.post(
  '/inspections/:id/media/:mediaId/retry',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  withIdempotency('inspection.media.retry', {
    ttlMs: 15 * 60 * 1000,
  }),
  validate(validateRetryMediaUpload),
  inspectionController.postInspectionMediaRetry
);
router.post(
  '/inspections/:id/media',
  requirePermissions('inspection.create'),
  ingestionRateLimit,
  upload.single('file'),
  inspectionController.postInspectionMedia
);
router.post(
  '/inspections/:id/submit',
  requirePermissions('inspection.create'),
  withIdempotency('inspection.submit', {
    ttlMs: 24 * 60 * 60 * 1000,
  }),
  validate(validateSubmitInspection),
  inspectionController.postSubmitInspection
);
router.patch(
  '/inspections/:id/review',
  requirePermissions('inspection.review'),
  validate(validateReviewInspection),
  inspectionController.patchReviewInspection
);

module.exports = router;
