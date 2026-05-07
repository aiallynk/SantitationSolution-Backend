const { Op } = require('sequelize');

const DATE_RANGE_DEFS = {
  today: { days: 1, label: 'Today' },
  last7: { days: 7, label: 'Last 7 days' },
  last30: { days: 30, label: 'Last 30 days' },
};

const DATE_RANGE_ALIASES = {
  '1': 'today',
  '1d': 'today',
  day: 'today',
  daily: 'today',
  today: 'today',
  '7': 'last7',
  '7d': 'last7',
  week: 'last7',
  weekly: 'last7',
  last7: 'last7',
  last_7: 'last7',
  last_7_days: 'last7',
  last7days: 'last7',
  '30': 'last30',
  '30d': 'last30',
  month: 'last30',
  monthly: 'last30',
  last30: 'last30',
  last_30: 'last30',
  last_30_days: 'last30',
  last30days: 'last30',
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const normalizeDateRange = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return DATE_RANGE_ALIASES[raw.replace(/[\s-]+/g, '_').toLowerCase()] || null;
};

const parseDate = (value, { endOfDay = false } = {}) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) {
    parsed.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  return parsed;
};

const startOfToday = (now = new Date()) => {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
};

const calculateDays = (start, end, fallback) => {
  if (!start || !end) return fallback;
  const diffMs = end.getTime() - start.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return fallback;
  return Math.max(1, Math.ceil(diffMs / 86_400_000));
};

const resolveDateRange = (query = {}, options = {}) => {
  const source = query || {};
  const maxDays = Number.isFinite(Number(options.maxDays)) ? Number(options.maxDays) : 90;
  const defaultRange = normalizeDateRange(options.defaultRange);
  const now = options.now instanceof Date ? options.now : new Date();

  const from = parseDate(source.from || source.start || source.startDate || source.dateFrom);
  const to = parseDate(source.to || source.end || source.endDate || source.dateTo, { endOfDay: true });
  if (from || to) {
    const start = from || null;
    const end = to || now;
    return {
      provided: true,
      range: 'custom',
      label: 'Custom range',
      days: calculateDays(start, end, 1),
      start,
      end,
    };
  }

  const requestedRange = normalizeDateRange(source.dateRange || source.range || source.timeRange);
  const rawDays = Number(source.days || source.activityDays);
  const hasDays = Number.isFinite(rawDays) && rawDays > 0;
  const rangeKey = requestedRange || defaultRange;

  if (!rangeKey && !hasDays && !options.defaultDays) {
    return {
      provided: false,
      range: null,
      label: null,
      days: null,
      start: null,
      end: null,
    };
  }

  const days = clamp(
    rangeKey ? DATE_RANGE_DEFS[rangeKey].days : Number(options.defaultDays || rawDays || 1),
    1,
    maxDays,
  );
  const start = startOfToday(now);
  start.setDate(start.getDate() - (days - 1));

  return {
    provided: Boolean(requestedRange || hasDays || options.defaultRange || options.defaultDays),
    range: rangeKey || `${days}d`,
    label: rangeKey ? DATE_RANGE_DEFS[rangeKey].label : `Last ${days} days`,
    days,
    start,
    end: now,
  };
};

const applyDateRangeToWhere = (where = {}, field, range) => {
  if (!field || (!range?.start && !range?.end)) return where;
  const existing = where[field] && typeof where[field] === 'object' ? where[field] : {};
  const dateFilter = { ...existing };
  if (range.start) dateFilter[Op.gte] = range.start;
  if (range.end) dateFilter[Op.lte] = range.end;
  return {
    ...where,
    [field]: dateFilter,
  };
};

module.exports = {
  DATE_RANGE_DEFS,
  normalizeDateRange,
  resolveDateRange,
  applyDateRangeToWhere,
};
