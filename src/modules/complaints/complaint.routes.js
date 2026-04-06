const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const complaintController = require('./complaint.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateComplaintListQuery,
  validateComplaintCreate,
  validateComplaintAssign,
  validateComplaintDispatch,
} = require('./complaint.validator');

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
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are supported'));
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
  validate(validateComplaintCreate),
  complaintController.postComplaint
);
router.patch(
  '/complaints/:id/assign',
  requirePermissions('task.manage'),
  validate(validateComplaintAssign),
  complaintController.patchComplaintAssign
);
router.patch(
  '/complaints/:id/resolve',
  requirePermissions('task.manage'),
  complaintController.patchComplaintResolve
);
router.post(
  '/complaints/:id/dispatch',
  requirePermissions('task.manage'),
  validate(validateComplaintDispatch),
  complaintController.postComplaintDispatch
);

module.exports = router;

