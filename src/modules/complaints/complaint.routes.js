const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const complaintController = require('./complaint.controller');
const AppError = require('../../core/errors/AppError');
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
  validateComplaintAssign,
  validateComplaintDispatch,
} = require('./complaint.validator');
const { RouteKeys, ScopeTypes, SurfaceTypes } = require('../../core/rbac/accessMatrix');

const router = express.Router();

const publicTempDir = path.join(process.cwd(), 'uploads', 'temp', 'public-feedback');
if (!fs.existsSync(publicTempDir)) {
  fs.mkdirSync(publicTempDir, { recursive: true });
}

const publicStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, publicTempDir),
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname || '');
    cb(
      null,
      `public-feedback-${Date.now()}-${Math.round(Math.random() * 1e9)}${extension}`
    );
  },
});

const publicUpload = multer({
  storage: publicStorage,
  limits: {
    fileSize: Number(process.env.MEDIA_MAX_FILE_SIZE || 8 * 1024 * 1024),
  },
  fileFilter: (req, file, cb) => {
    const mimetype = String(file.mimetype || '').toLowerCase();
    const originalName = String(file.originalname || '');
    const extension = path.extname(originalName).toLowerCase();
    const allowedExtensions = new Set([
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.gif',
      '.bmp',
      '.heic',
      '.heif',
    ]);
    const isImageMime = mimetype.startsWith('image/');
    const canTrustExtension =
      (mimetype === '' || mimetype === 'application/octet-stream') &&
      allowedExtensions.has(extension);

    if (!isImageMime && !canTrustExtension) {
      return cb(
        new AppError('Only image uploads are supported', 400, {
          code: 'INVALID_MEDIA_TYPE',
          details: {
            mimetype: mimetype || null,
            originalName,
            extension: extension || null,
          },
        })
      );
    }
    return cb(null, true);
  },
});

router.get(
  '/public-feedback/toilets/:toiletId',
  complaintController.getPublicFeedbackForm
);
router.post(
  '/public-feedback/toilets/:toiletId/report',
  publicUpload.single('photo'),
  complaintController.postPublicFeedback
);

router.use(protect);
router.use(
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
