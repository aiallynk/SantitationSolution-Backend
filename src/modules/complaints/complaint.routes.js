const express = require('express');
const complaintController = require('./complaint.controller');
const {
  protect,
  requirePermissions,
  requireAction,
  requireRouteKey,
  requireScope,
  requireSurface,
} = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateComplaintListQuery,
  validateComplaintCreate,
  validateComplaintUpdate,
  validateComplaintAssign,
  validateComplaintDispatch,
} = require('./complaint.validator');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');
const { createImageDiskUpload } = require('../media/uploadPolicy');

const router = express.Router();

const publicUpload = createImageDiskUpload({
  filenamePrefix: 'public-feedback',
  tempSubdir: 'public-feedback',
});

router.get(
  '/public-feedback/assets/rating-stars.js',
  complaintController.getPublicFeedbackStarsScript
);
router.get(
  '/public-feedback/toilets/:toiletId',
  complaintController.getPublicFeedbackForm
);
router.post(
  '/public-feedback/toilets/:toiletId/report',
  publicUpload.single('photo'),
  complaintController.postPublicFeedback
);

router.use('/complaints', protect);
router.use(
  '/complaints',
  requireSurface(
    SurfaceTypes.OPS_WEB,
    SurfaceTypes.OPS_WEB_AND_MOBILE,
    SurfaceTypes.MOBILE_ONLY,
  ),
  requireRouteKey(RouteKeys.OPS_COMPLAINTS),
  requireScope({ scopeTypes: [ScopeTypes.NONE, ScopeTypes.GEOGRAPHY, ScopeTypes.FACILITY] }),
);

router.get(
  '/complaints',
  requirePermissions('dashboard.read'),
  validate(validateComplaintListQuery),
  complaintController.getComplaints
);
router.get(
  '/complaints/:id',
  requirePermissions('dashboard.read'),
  complaintController.getComplaintById
);
router.post(
  '/complaints',
  requirePermissions('inspection.create'),
  requireAction('task.execute'),
  validate(validateComplaintCreate),
  complaintController.postComplaint
);
router.patch(
  '/complaints/:id',
  requirePermissions('task.manage'),
  requireAction('task.manage'),
  validate(validateComplaintUpdate),
  complaintController.patchComplaint
);
router.patch(
  '/complaints/:id/assign',
  requirePermissions('task.manage'),
  requireAction('task.assign'),
  validate(validateComplaintAssign),
  complaintController.patchComplaintAssign
);
router.patch(
  '/complaints/:id/resolve',
  requirePermissions('task.manage'),
  requireAction('task.verify'),
  complaintController.patchComplaintResolve
);
router.post(
  '/complaints/:id/dispatch',
  requirePermissions('task.manage'),
  requireAction('task.assign'),
  validate(validateComplaintDispatch),
  complaintController.postComplaintDispatch
);

module.exports = router;
