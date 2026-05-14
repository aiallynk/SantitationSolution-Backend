const { isBlank, inEnum } = require('../../utils/validators');

const validateTaskCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.facilityId)) errors.push('facilityId is required');
  if (isBlank(req.body.assignedToUserId)) errors.push('assignedToUserId is required');
  if (isBlank(req.body.taskType)) errors.push('taskType is required');
  if (
    !isBlank(req.body.status) &&
    !inEnum(req.body.status, [
      'unassigned',
      'assigned',
      'accepted',
      'pending',
      'in_progress',
      'completed',
      'cancelled',
      'overdue',
    ])
  ) {
    errors.push('status is invalid');
  }
  return errors;
};

const validateTaskReassign = (req) => {
  const errors = [];
  if (req.body.assignedToUserId != null && typeof req.body.assignedToUserId !== 'string') {
    errors.push('assignedToUserId must be a string when provided');
  }
  if (req.body.reason != null && typeof req.body.reason !== 'string') {
    errors.push('reason must be a string when provided');
  }
  return errors;
};

module.exports = {
  validateTaskCreate,
  validateTaskReassign,
};
