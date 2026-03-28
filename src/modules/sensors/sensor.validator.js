const { isBlank, parsePositiveInteger } = require('../../utils/validators');

const validateIngestion = (req) => {
  const errors = [];
  if (isBlank(req.body.deviceId)) errors.push('deviceId is required');
  if (req.body.timestamp && Number.isNaN(Date.parse(req.body.timestamp))) {
    errors.push('timestamp must be a valid date');
  }
  return errors;
};

const validateSensorListQuery = (req) => {
  const errors = [];
  if (Number.isNaN(parsePositiveInteger(req.query.page, 1))) errors.push('page must be a positive integer');
  if (Number.isNaN(parsePositiveInteger(req.query.limit, 20))) errors.push('limit must be a positive integer');
  return errors;
};

module.exports = {
  validateIngestion,
  validateSensorListQuery,
};
