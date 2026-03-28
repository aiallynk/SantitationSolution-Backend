const { isBlank, inEnum } = require('../../utils/validators');

const validateTaskCreate = (req) => {
  const errors = [];
  if (isBlank(req.body.facilityId)) errors.push('facilityId is required');
  if (isBlank(req.body.assignedToUserId)) errors.push('assignedToUserId is required');
  if (isBlank(req.body.taskType)) errors.push('taskType is required');
  if (!isBlank(req.body.status) && !inEnum(req.body.status, ['pending', 'in_progress', 'completed', 'cancelled', 'overdue'])) {
    errors.push('status is invalid');
  }
  return errors;
};

module.exports = {
  validateTaskCreate,
};
