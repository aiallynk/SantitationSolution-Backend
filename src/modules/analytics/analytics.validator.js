const { parsePositiveInteger } = require('../../utils/validators');

const validateTrendsQuery = (req) => {
  const errors = [];
  const { days } = req.query;

  const parsedDays = parsePositiveInteger(days, 7);

  if (Number.isNaN(parsedDays)) {
    errors.push('days must be a positive integer');
  } else if (parsedDays > 90) {
    errors.push('days cannot be greater than 90');
  }

  return errors;
};

const validateAlertIdParam = (req) => {
  const errors = [];
  const id = parsePositiveInteger(req.params.id);

  if (Number.isNaN(id)) {
    errors.push('id must be a positive integer');
  }

  return errors;
};

module.exports = {
  validateTrendsQuery,
  validateAlertIdParam,
};
