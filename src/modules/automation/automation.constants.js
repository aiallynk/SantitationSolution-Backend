const { runtimeConfig } = require('../../config/runtime');

const ACTIVE_TASK_STATUSES = Object.freeze([
  'unassigned',
  'assigned',
  'accepted',
  'pending',
  'in_progress',
  'overdue',
]);

const TERMINAL_TASK_STATUSES = Object.freeze(['completed', 'cancelled']);

const SYSTEM_ASSIGNMENT_SOURCE = 'automation';
const CRITICAL_COMPLAINT_TASK_TYPE = 'critical_complaint';

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeToken = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

const getCriticalComplaintValueSet = () =>
  new Set(
    (runtimeConfig.automation.criticalComplaintValues || [])
      .flatMap((value) => {
        const raw = String(value || '').trim();
        const normalized = normalizeToken(raw);
        return [raw.toLowerCase(), normalized].filter(Boolean);
      })
  );

const isValidLatitude = (value) => {
  const parsed = toNumberOrNull(value);
  return parsed !== null && parsed >= -90 && parsed <= 90;
};

const isValidLongitude = (value) => {
  const parsed = toNumberOrNull(value);
  return parsed !== null && parsed >= -180 && parsed <= 180;
};

const haversineDistanceKm = (left, right) => {
  const lat1 = toNumberOrNull(left?.latitude ?? left?.lat);
  const lon1 = toNumberOrNull(left?.longitude ?? left?.lng ?? left?.lon);
  const lat2 = toNumberOrNull(right?.latitude ?? right?.lat);
  const lon2 = toNumberOrNull(right?.longitude ?? right?.lng ?? right?.lon);
  if ([lat1, lon1, lat2, lon2].some((value) => value === null)) return null;

  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const addMinutes = (date, minutes) => new Date(date.getTime() + Number(minutes || 0) * 60000);

module.exports = {
  ACTIVE_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  SYSTEM_ASSIGNMENT_SOURCE,
  CRITICAL_COMPLAINT_TASK_TYPE,
  addMinutes,
  getCriticalComplaintValueSet,
  haversineDistanceKm,
  isValidLatitude,
  isValidLongitude,
  normalizeToken,
  toNumberOrNull,
};
