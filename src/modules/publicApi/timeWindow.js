const { normalizeTimezone, toTimezoneDateKey, getTimezoneOffsetMinutes } = require('../../utils/timezone');

const DEFAULT_API_TIMEZONE = 'Asia/Kolkata';

const zonedDateTimeToUtcDate = ({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = DEFAULT_API_TIMEZONE,
}) => {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const offset = getTimezoneOffsetMinutes(utcGuess, timeZone) || 0;
  return new Date(utcGuess.getTime() - offset * 60_000);
};

const getZonedParts = (date = new Date(), timeZone = DEFAULT_API_TIMEZONE) => {
  const resolved = normalizeTimezone(timeZone, DEFAULT_API_TIMEZONE);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolved,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    timeZone: resolved,
  };
};

const getDayWindow = (date = new Date(), timeZone = DEFAULT_API_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  const start = zonedDateTimeToUtcDate(parts);
  const end = zonedDateTimeToUtcDate({
    ...parts,
    day: parts.day + 1,
  });
  return { start, end, dateKey: toTimezoneDateKey(date, parts.timeZone) };
};

const getMonthWindow = (date = new Date(), timeZone = DEFAULT_API_TIMEZONE) => {
  const parts = getZonedParts(date, timeZone);
  const start = zonedDateTimeToUtcDate({
    ...parts,
    day: 1,
  });
  const end = zonedDateTimeToUtcDate({
    ...parts,
    month: parts.month + 1,
    day: 1,
  });
  return { start, end };
};

module.exports = {
  DEFAULT_API_TIMEZONE,
  getDayWindow,
  getMonthWindow,
};
