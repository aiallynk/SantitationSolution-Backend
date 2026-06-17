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

const validateDispatchToiletCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.facilityId)) errors.push('facilityId is required');
  if (isBlank(req.body.assignedToUserId)) errors.push('assignedToUserId is required');
  if (isBlank(req.body.toiletCode)) errors.push('toiletCode is required');
  if (req.body.toiletBlockId !== undefined && isBlank(req.body.toiletBlockId)) {
    errors.push('toiletBlockId cannot be blank when provided');
  }
  if (req.body.unitType !== undefined && isBlank(req.body.unitType)) {
    errors.push('unitType cannot be blank when provided');
  }
  if (req.body.taskType !== undefined && isBlank(req.body.taskType)) {
    errors.push('taskType cannot be blank when provided');
  }
  if (
    req.body.slaMinutes !== undefined &&
    req.body.slaMinutes !== null &&
    String(req.body.slaMinutes).trim() !== '' &&
    Number.isNaN(Number(req.body.slaMinutes))
  ) {
    errors.push('slaMinutes must be a valid number when provided');
  }
  if (req.body.scheduledAt != null && Number.isNaN(Date.parse(String(req.body.scheduledAt)))) {
    errors.push('scheduledAt must be an ISO datetime when provided');
  }
  if (req.body.latitude !== undefined && Number.isNaN(Number(req.body.latitude))) {
    errors.push('latitude must be a valid number');
  }
  if (req.body.longitude !== undefined && Number.isNaN(Number(req.body.longitude))) {
    errors.push('longitude must be a valid number');
  }
  return errors;
};

module.exports = {
  validateTaskCreate,
  validateTaskReassign,
  validateDispatchToiletCreate,
};
