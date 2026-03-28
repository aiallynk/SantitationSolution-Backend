const express = require('express');
const complaintController = require('./complaint.controller');
const { protect, requirePermissions } = require('../../core/middleware/auth');
const { validate } = require('../../core/middleware/validate');
const {
  validateComplaintListQuery,
  validateComplaintCreate,
  validateComplaintAssign,
} = require('./complaint.validator');

const router = express.Router();

router.use(protect);

router.get(
  '/complaints',
  requirePermissions('dashboard.read'),
  validate(validateComplaintListQuery),
  complaintController.getComplaints
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

module.exports = router;
