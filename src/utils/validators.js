const isBlank = (value) =>
  value === undefined || value === null || String(value).trim() === '';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuid = (value) => {
  if (isBlank(value)) {
    return false;
  }
  return UUID_PATTERN.test(String(value).trim());
};

const sanitizeText = (value, maxLength = 200) => {
  if (isBlank(value)) {
    return '';
  }
  return String(value)
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[<>]/g, '')
    .slice(0, maxLength);
};

const parsePositiveInteger = (value, fallback = 1) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return NaN;
  }
  return parsed;
};

const parseOptionalNumber = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

const inEnum = (value, allowedValues) => {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  return allowedValues.includes(String(value));
};

const normalizePagination = (query, defaults = { page: 1, limit: 20, maxLimit: 100 }) => {
  const pageRaw = parsePositiveInteger(query.page, defaults.page);
  const limitRaw = parsePositiveInteger(query.limit, defaults.limit);

  const page = Number.isNaN(pageRaw) ? defaults.page : pageRaw;
  const requestedLimit = Number.isNaN(limitRaw) ? defaults.limit : limitRaw;
  const limit = Math.min(requestedLimit, defaults.maxLimit);

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
};

module.exports = {
  isBlank,
  isUuid,
  sanitizeText,
  parsePositiveInteger,
  parseOptionalNumber,
  inEnum,
  normalizePagination,
};
