const { Op } = require('sequelize');

const DEFAULT_TIME_ZONE = 'Asia/Kolkata';

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

const getTimeZoneParts = (date, timeZone = DEFAULT_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') === 24 ? 0 : read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
};

const getTimeZoneDateParts = (date, timeZone = DEFAULT_TIME_ZONE) => {
  const parts = getTimeZoneParts(date, timeZone);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
  };
};

const getTimeZoneOffsetMs = (date, timeZone = DEFAULT_TIME_ZONE) => {
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
};

const zonedDateTimeToUtcDate = ({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = DEFAULT_TIME_ZONE,
}) => {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
};

const normalizeDateRange = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return DATE_RANGE_ALIASES[raw.replace(/[\s-]+/g, '_').toLowerCase()] || null;
};

const parseDate = (value, { endOfDay = false, timeZone = DEFAULT_TIME_ZONE } = {}) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())) {
    const [year, month, day] = String(value).split('-').map(Number);
    if (endOfDay) {
      const nextDayStart = zonedDateTimeToUtcDate({ year, month, day: day + 1, timeZone });
      return new Date(nextDayStart.getTime() - 1);
    }
    return zonedDateTimeToUtcDate({ year, month, day, timeZone });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const startOfToday = (now = new Date(), timeZone = DEFAULT_TIME_ZONE) => {
  const parts = getTimeZoneDateParts(now, timeZone);
  return zonedDateTimeToUtcDate({ ...parts, timeZone });
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
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;

  const from = parseDate(source.from || source.start || source.startDate || source.dateFrom, { timeZone });
  const to = parseDate(source.to || source.end || source.endDate || source.dateTo, { endOfDay: true, timeZone });
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
  const todayParts = getTimeZoneDateParts(now, timeZone);
  const start = zonedDateTimeToUtcDate({
    ...todayParts,
    day: todayParts.day - (days - 1),
    timeZone,
  });

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
  DEFAULT_TIME_ZONE,
  DATE_RANGE_DEFS,
  normalizeDateRange,
  resolveDateRange,
  applyDateRangeToWhere,
};
