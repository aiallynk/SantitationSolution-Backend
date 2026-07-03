const AppError = require('../../core/errors/AppError');
const {
  getDefaultTimezone,
  getTimeZoneParts,
  isValidIanaTimezone,
  zonedDateTimeToUtcDate,
} = require('../../utils/timezone');

const normalizeRunTime = (value) => {
  const raw = String(value || '02:00:00').trim();
  const match = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) {
    throw new AppError('runTime must be HH:mm or HH:mm:ss', 400, {
      code: 'INVALID_BACKUP_RUN_TIME',
    });
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] || 0);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new AppError('runTime must contain a valid 24-hour time', 400, {
      code: 'INVALID_BACKUP_RUN_TIME',
    });
  }
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
};

const normalizeScheduleTimezone = (value, { fallback = getDefaultTimezone(), strict = false } = {}) => {
  const timezone = String(value || '').trim();
  if (isValidIanaTimezone(timezone)) return timezone;
  if (strict && timezone) {
    throw new AppError('timezone must be a valid IANA timezone', 400, {
      code: 'INVALID_BACKUP_TIMEZONE',
    });
  }
  return isValidIanaTimezone(fallback) ? String(fallback).trim() : getDefaultTimezone();
};

const normalizeTimeFormat = (value, fallback = '24') => {
  const normalized = String(value || fallback).trim();
  if (normalized === '12' || normalized === '24') return normalized;
  throw new AppError('timeFormat must be 12 or 24', 400, {
    code: 'INVALID_BACKUP_TIME_FORMAT',
  });
};

const addCalendarDays = ({ year, month, day }, amount) => {
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
};

const dailyRunForLocalDate = ({ dateParts, runTime, timezone }) => {
  const [hour, minute, second] = normalizeRunTime(runTime).split(':').map(Number);
  return zonedDateTimeToUtcDate({
    ...dateParts,
    hour,
    minute,
    second,
    timeZone: timezone,
  });
};

const nextDailyRun = (
  runTime = '02:00:00',
  timezone = getDefaultTimezone(),
  from = new Date(),
) => {
  const normalizedRunTime = normalizeRunTime(runTime);
  const normalizedTimezone = normalizeScheduleTimezone(timezone, { strict: true });
  const now = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (Number.isNaN(now.getTime())) {
    throw new AppError('Unable to calculate backup schedule from an invalid date', 400, {
      code: 'INVALID_BACKUP_SCHEDULE_DATE',
    });
  }

  const localToday = getTimeZoneParts(now, normalizedTimezone);
  const toCandidate = (dateParts) => dailyRunForLocalDate({
    dateParts,
    runTime: normalizedRunTime,
    timezone: normalizedTimezone,
  });

  let candidate = toCandidate(localToday);
  if (candidate.getTime() <= now.getTime()) {
    candidate = toCandidate(addCalendarDays(localToday, 1));
  }
  return candidate;
};

const previousDailyRun = (
  runTime = '02:00:00',
  timezone = getDefaultTimezone(),
  from = new Date(),
) => {
  const normalizedRunTime = normalizeRunTime(runTime);
  const normalizedTimezone = normalizeScheduleTimezone(timezone, { strict: true });
  const now = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (Number.isNaN(now.getTime())) {
    throw new AppError('Unable to calculate backup schedule from an invalid date', 400, {
      code: 'INVALID_BACKUP_SCHEDULE_DATE',
    });
  }
  const localToday = getTimeZoneParts(now, normalizedTimezone);
  const todayCandidate = dailyRunForLocalDate({
    dateParts: localToday,
    runTime: normalizedRunTime,
    timezone: normalizedTimezone,
  });
  if (todayCandidate.getTime() <= now.getTime()) return todayCandidate;
  return dailyRunForLocalDate({
    dateParts: addCalendarDays(localToday, -1),
    runTime: normalizedRunTime,
    timezone: normalizedTimezone,
  });
};

module.exports = {
  nextDailyRun,
  previousDailyRun,
  normalizeRunTime,
  normalizeScheduleTimezone,
  normalizeTimeFormat,
};
