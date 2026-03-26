const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

const sanitizeText = (value, maxLength = 120) => {
  if (value === undefined || value === null) {
    return '';
  }

  const normalized = String(value)
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[<>]/g, '');

  return normalized.slice(0, maxLength);
};

const parseOptionalNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

const parsePositiveInteger = (value, fallback = 1) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return NaN;
  }

  return parsed;
};

const inEnum = (value, allowedValues) => {
  if (value === undefined || value === null || value === '') {
    return true;
  }

  return allowedValues.includes(String(value));
};

module.exports = {
  isBlank,
  sanitizeText,
  parseOptionalNumber,
  parsePositiveInteger,
  inEnum,
};
