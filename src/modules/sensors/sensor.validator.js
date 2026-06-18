const { isBlank, parsePositiveInteger, isUuid } = require('../../utils/validators');

const validateIngestion = (req) => {
  const errors = [];
  if (isBlank(req.body.deviceId)) errors.push('deviceId is required');
  if (req.body.timestamp && Number.isNaN(Date.parse(req.body.timestamp))) {
    errors.push('timestamp must be a valid date');
  }
  if (req.body.toiletUnitId && !isUuid(String(req.body.toiletUnitId))) {
    errors.push('toiletUnitId must be a valid id');
  }
  return errors;
};

const validateAttachSensor = (req) => {
  const errors = [];
  if (isBlank(req.body.deviceId)) errors.push('deviceId is required');
  if (isBlank(req.body.toiletUnitId)) {
    errors.push('toiletUnitId is required');
  } else if (!isUuid(String(req.body.toiletUnitId))) {
    errors.push('toiletUnitId must be a valid id');
  }
  return errors;
};

// Register a discovered BLE device without attaching it to a toilet yet.
// toiletUnitId is intentionally NOT required here (that is commissioning).
const validateRegisterSensor = (req) => {
  const errors = [];
  if (isBlank(req.body.deviceId)) errors.push('deviceId is required');
  if (req.body.tenantId && !isUuid(String(req.body.tenantId))) {
    errors.push('tenantId must be a valid id');
  }
  if (
    req.body.batteryLevel !== undefined &&
    req.body.batteryLevel !== null &&
    Number.isNaN(Number(req.body.batteryLevel))
  ) {
    errors.push('batteryLevel must be a number');
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
  validateAttachSensor,
  validateRegisterSensor,
  validateSensorListQuery,
};
