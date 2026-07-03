const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Kolkata';
const SYSTEM_FALLBACK_TIMEZONE = 'Asia/Kolkata';

const TIMEZONE_OPTIONS = Object.freeze([
  { value: 'Asia/Kolkata', label: 'Asia/Kolkata - India' },
  { value: 'Asia/Manila', label: 'Asia/Manila - Philippines' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney - Australia Eastern' },
  { value: 'Australia/Perth', label: 'Australia/Perth - Australia Western' },
  { value: 'Europe/London', label: 'Europe/London - United Kingdom' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin - Central Europe' },
  { value: 'Europe/Paris', label: 'Europe/Paris - France' },
  { value: 'UTC', label: 'UTC - Coordinated Universal Time' },
]);

const isValidIanaTimezone = (value) => {
  const timezone = String(value || '').trim();
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
};

const normalizeTimezone = (value, fallback = getDefaultTimezone()) => {
  const timezone = String(value || '').trim();
  if (isValidIanaTimezone(timezone)) return timezone;
  return isValidIanaTimezone(fallback) ? fallback : SYSTEM_FALLBACK_TIMEZONE;
};

function getDefaultTimezone() {
  return normalizeTimezone(DEFAULT_TIMEZONE, SYSTEM_FALLBACK_TIMEZONE);
}

const toUtcDate = (input, sourceTimezone = getDefaultTimezone()) => {
  if (!input) return null;
  if (input instanceof Date) {
    return Number.isNaN(input.getTime()) ? null : new Date(input.getTime());
  }
  const raw = String(input).trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    return parsed;
  }
  if (!Number.isNaN(parsed.getTime()) && !/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/i.test(raw)) {
    return parsed;
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/
  );
  if (!match) return Number.isNaN(parsed.getTime()) ? null : parsed;
  const [, yy, mo, dd, hh = '0', mi = '0', ss = '0', ms = '0'] = match;
  return zonedDateTimeToUtcDate({
    year: Number(yy),
    month: Number(mo),
    day: Number(dd),
    hour: Number(hh),
    minute: Number(mi),
    second: Number(ss),
    millisecond: Number(String(ms).padEnd(3, '0')),
    timeZone: sourceTimezone,
  });
};

const getTimeZoneParts = (date, timeZone = getDefaultTimezone()) => {
  const resolved = normalizeTimezone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolved,
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

const getTimezoneOffsetMinutes = (utcDate, timeZone = getDefaultTimezone()) => {
  const date = utcDate instanceof Date ? utcDate : new Date(utcDate);
  if (Number.isNaN(date.getTime())) return null;
  const parts = getTimeZoneParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
};

const zonedDateTimeToUtcDate = ({
  year,
  month,
  day,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = getDefaultTimezone(),
}) => {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  const initialOffset = getTimezoneOffsetMinutes(utcGuess, timeZone) || 0;
  let resolved = new Date(utcGuess.getTime() - initialOffset * 60000);
  const resolvedOffset = getTimezoneOffsetMinutes(resolved, timeZone);
  if (resolvedOffset !== null && resolvedOffset !== initialOffset) {
    resolved = new Date(utcGuess.getTime() - resolvedOffset * 60000);
  }
  return resolved;
};

const formatInTimezone = (
  utcDate,
  timeZone = getDefaultTimezone(),
  { includeSeconds = false, includeTimeZone = true, fallback = null } = {}
) => {
  if (!utcDate) return fallback;
  const date = utcDate instanceof Date ? utcDate : new Date(utcDate);
  if (Number.isNaN(date.getTime())) return fallback;
  const resolved = normalizeTimezone(timeZone);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: resolved,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' } : {}),
    ...(includeTimeZone ? { timeZoneName: 'short' } : {}),
    hour12: true,
  }).format(date);
};

const toTimezoneDateKey = (utcDate, timeZone = getDefaultTimezone()) => {
  const date = utcDate instanceof Date ? utcDate : new Date(utcDate);
  if (Number.isNaN(date.getTime())) return null;
  const resolved = normalizeTimezone(timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolved,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : null;
};

const timezoneFromMetadata = (row) => {
  const metadata = row?.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return row?.timezone || metadata.timezone || metadata.timeZone || null;
};

const resolveTenantTimezone = async (tenantId) => {
  if (!tenantId) return getDefaultTimezone();
  const { Tenant } = require('../models');
  const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'timezone', 'metadata'] });
  return normalizeTimezone(timezoneFromMetadata(tenant));
};

const resolveToiletTimezone = async (toiletId) => {
  if (!toiletId) return null;
  const { ToiletUnit, Facility, Tenant } = require('../models');
  const unit = await ToiletUnit.findByPk(toiletId, {
    attributes: ['id', 'facility_id', 'timezone'],
    include: [
      {
        model: Facility,
        attributes: ['id', 'tenant_id', 'timezone', 'metadata'],
        include: [{ model: Tenant, attributes: ['id', 'timezone', 'metadata'], required: false }],
      },
    ],
  });
  if (!unit) return null;
  const toiletTimezone = normalizeOptionalTimezone(unit.timezone);
  if (toiletTimezone) return { timezone: toiletTimezone, source: 'toilet' };
  const facilityTimezone = normalizeOptionalTimezone(timezoneFromMetadata(unit.Facility));
  if (facilityTimezone) return { timezone: facilityTimezone, source: 'facility' };
  const tenantTimezone = normalizeOptionalTimezone(timezoneFromMetadata(unit.Facility?.Tenant));
  if (tenantTimezone) return { timezone: tenantTimezone, source: 'tenant' };
  return { timezone: getDefaultTimezone(), source: 'deployment_default' };
};

const normalizeOptionalTimezone = (value) => (isValidIanaTimezone(value) ? String(value).trim() : null);

const resolveDisplayTimezone = async ({ tenantId = null, facilityId = null, toiletId = null, user = null, explicitTimezone = null } = {}) => {
  const userTimezone = normalizeOptionalTimezone(user?.timezone || user?.metadata?.preferences?.timezone);
  const explicit = normalizeOptionalTimezone(explicitTimezone);
  if (explicit) return { timezone: explicit, source: 'admin_explicit' };
  if (userTimezone) return { timezone: userTimezone, source: 'user_preference' };
  if (toiletId) {
    const resolved = await resolveToiletTimezone(toiletId);
    if (resolved) return resolved;
  }
  const { Facility, Tenant } = require('../models');
  if (facilityId) {
    const facility = await Facility.findByPk(facilityId, {
      attributes: ['id', 'tenant_id', 'timezone', 'metadata'],
      include: [{ model: Tenant, attributes: ['id', 'timezone', 'metadata'], required: false }],
    });
    const facilityTimezone = normalizeOptionalTimezone(timezoneFromMetadata(facility));
    if (facilityTimezone) return { timezone: facilityTimezone, source: 'facility' };
    const tenantTimezone = normalizeOptionalTimezone(timezoneFromMetadata(facility?.Tenant));
    if (tenantTimezone) return { timezone: tenantTimezone, source: 'tenant' };
  }
  if (tenantId) return { timezone: await resolveTenantTimezone(tenantId), source: 'tenant' };
  return { timezone: getDefaultTimezone(), source: 'deployment_default' };
};

const buildTimestampMetadata = (utcValue, { captureTimezone = null, displayTimezone = null } = {}) => {
  const utcDate = toUtcDate(utcValue);
  const capture = normalizeTimezone(captureTimezone || displayTimezone);
  const display = normalizeTimezone(displayTimezone || capture);
  return {
    utc: utcDate ? utcDate.toISOString() : null,
    captureTimezone: capture,
    displayTimezone: display,
    captureOffsetMinutes: utcDate ? getTimezoneOffsetMinutes(utcDate, capture) : null,
    label: utcDate ? formatInTimezone(utcDate, display) : null,
  };
};

const resolveCaptureTimestamp = (payload = {}, fallbackTimezone = getDefaultTimezone()) => {
  const captureTimezone = normalizeTimezone(
    payload.captureTimezone ||
      payload.capture_timezone ||
      payload.deviceTimezone ||
      payload.device_timezone ||
      fallbackTimezone
  );
  const explicitUtc = payload.capturedAtUtc || payload.captured_at_utc || payload.recordedAtUtc || payload.recorded_at_utc;
  const localValue = payload.capturedAtLocal || payload.captured_at_local || payload.recordedAtLocal || payload.recorded_at_local;
  const legacyValue = payload.capturedAt || payload.captured_at || payload.timestamp || null;
  let utcDate = explicitUtc ? toUtcDate(explicitUtc) : null;
  let source = explicitUtc ? 'client_captured_at_utc' : null;
  if (!utcDate && localValue) {
    utcDate = toUtcDate(localValue, captureTimezone);
    source = 'client_local_with_timezone';
  }
  if (!utcDate && legacyValue) {
    utcDate = toUtcDate(legacyValue, captureTimezone);
    source = 'legacy_captured_at';
  }
  if (!utcDate) {
    utcDate = new Date();
    source = 'server_received_at';
  }
  const suppliedOffset = Number(payload.captureOffsetMinutes ?? payload.capture_offset_minutes ?? payload.sourceOffsetMinutes);
  return {
    capturedAtUtc: utcDate,
    captureTimezone,
    captureOffsetMinutes: Number.isFinite(suppliedOffset)
      ? suppliedOffset
      : getTimezoneOffsetMinutes(utcDate, captureTimezone),
    captureTimeSource: source,
  };
};

module.exports = {
  DEFAULT_TIMEZONE,
  SYSTEM_FALLBACK_TIMEZONE,
  TIMEZONE_OPTIONS,
  getDefaultTimezone,
  isValidIanaTimezone,
  normalizeTimezone,
  toUtcDate,
  getTimeZoneParts,
  zonedDateTimeToUtcDate,
  formatInTimezone,
  getTimezoneOffsetMinutes,
  toTimezoneDateKey,
  resolveTenantTimezone,
  resolveToiletTimezone,
  resolveDisplayTimezone,
  buildTimestampMetadata,
  resolveCaptureTimestamp,
};
