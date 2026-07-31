const { Op, fn, col } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  SensorDevice,
  SensorReading,
  Alert,
  Facility,
  ToiletUnit,
  Inspection,
  InspectionMedia,
} = require('../../models');
const { normalizePagination, sanitizeText, isUuid } = require('../../utils/validators');
const { resolveDateRange, applyDateRangeToWhere } = require('../../utils/dateRange');
const { getDefaultTimezone, resolveCaptureTimestamp, toTimezoneDateKey } = require('../../utils/timezone');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { createAuditLog } = require('../audit/audit.service');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
  hasFieldInspectionRole,
} = require('../../core/rbac/scopeWhere');
const { runtimeConfig } = require('../../config/runtime');
const { parseSensorPayload } = require('./sensorPayload.parser');
const { toSensorMetrics } = require('./sensorMetrics');
const {
  isUtcMidnight,
  resolveInspectionTime,
} = require('./syntheticSensorBackfill.generator');
const {
  getSensorThresholds,
  evaluateSensorMetrics,
  evaluateOfflineStatus,
  STATUS,
} = require('./sensorThreshold.service');

const DEFAULT_BLE_DEVICE_TYPE = 'sanitation_wand';

const ANALYTICS_METRICS = Object.freeze({
  temperature: { key: 'temperature', label: 'Temperature', unit: 'C', precision: 1 },
  humidity: { key: 'humidity', label: 'Humidity', unit: '%', precision: 1 },
  ppm: { key: 'ppm', label: 'Gas Concentration (PPM)', unit: 'ppm', precision: 1 },
  battery: { key: 'battery', label: 'Battery', unit: '%', precision: 0 },
  rssi: { key: 'rssi', label: 'Signal', unit: 'dBm', precision: 0 },
});

const STATUS_RANK = Object.freeze({
  normal: 0,
  stale: 1,
  warning: 2,
  critical: 3,
});

const normalizeMetricKey = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return ANALYTICS_METRICS[key] ? key : 'humidity';
};

const normalizeGranularity = (value) => {
  const key = String(value || '').trim().toLowerCase();
  if (['hour', 'hourly'].includes(key)) return 'hourly';
  if (['week', 'weekly'].includes(key)) return 'weekly';
  return 'daily';
};

const statusLower = (value) => String(value || STATUS.NORMAL).toLowerCase();

const worseStatus = (...values) =>
  values
    .map((value) => statusLower(value))
    .filter(Boolean)
    .sort((left, right) => (STATUS_RANK[right] || 0) - (STATUS_RANK[left] || 0))[0] || 'normal';

const SENSOR_ALERT_TYPE_SET = new Set([
  'SENSOR_OFFLINE',
  'HIGH_TEMPERATURE',
  'LOW_TEMPERATURE',
  'HIGH_HUMIDITY',
  'LOW_HUMIDITY',
  'AIR_QUALITY_ALERT',
  'MQ_ALERT',
  'LOW_BATTERY',
]);

const ALERT_SEVERITY_BY_LEVEL = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'critical',
});

const parseNumeric = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toIso = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toIstDateKey = (value) => toTimezoneDateKey(value, getDefaultTimezone());

const filterRowsWithVisibleToilets = async (rows = []) => {
  const toiletIds = uniqueIds(rows.map((row) => row.toilet_unit_id || row.toiletUnitId));
  if (toiletIds.length === 0) return rows;
  const deletedRows = await ToiletUnit.findAll({
    where: {
      id: { [Op.in]: toiletIds },
      deleted_at: { [Op.not]: null },
    },
    attributes: ['id'],
    raw: true,
  });
  const deletedIds = new Set(deletedRows.map((row) => String(row.id)));
  if (deletedIds.size === 0) return rows;
  return rows.filter((row) => {
    const toiletId = row.toilet_unit_id || row.toiletUnitId || null;
    return !toiletId || !deletedIds.has(String(toiletId));
  });
};

const asDateOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const pickInspectionMediaCapturedAt = (mediaRows = []) => {
  const candidates = mediaRows
    .map((row) => asDateOrNull(row.capturedAt || row.captured_at))
    .filter(Boolean)
    .sort((left, right) => left.getTime() - right.getTime());
  return candidates.find((date) => !isUtcMidnight(date)) || candidates[0] || null;
};

const resolveInspectionSensorDisplayTime = ({ inspection, mediaRows = [] }) => {
  const snapshot = inspection?.sensor_snapshot || inspection?.sensorSnapshot || {};
  const readingTime = asDateOrNull(snapshot.readingTime || snapshot.timestamp || snapshot.linkedAt);
  if (readingTime && !isUtcMidnight(readingTime)) return readingTime.toISOString();
  return resolveInspectionTime({
    capturedAt: inspection?.captured_at || inspection?.capturedAt,
    submittedAt: inspection?.submitted_at || inspection?.submittedAt,
    mediaCapturedAt: pickInspectionMediaCapturedAt(mediaRows),
  }).toISOString();
};

const parseCsvIds = (value) => {
  if (!value) return [];
  const source = Array.isArray(value) ? value : String(value).split(',');
  return uniqueIds(source).filter((id) => isUuid(id));
};

const scopedWhere = (req, where = {}, domainType = 'sensor') =>
  applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), domainType, {
    tenantKey: 'tenant_id',
    facilityKey: 'facility_id',
  });

const mapReading = (row) => ({
  id: row.id,
  deviceId: row.device_id,
  clientReadingId: row.client_reading_id || null,
  timestamp: row.timestamp,
  ppm: row.ppm,
  humidity: row.humidity,
  temperature: row.temperature,
  occupancyCount: row.occupancy_count,
  footfallCount: row.footfall_count,
  tankFillLevel: row.tank_fill_level,
  batteryLevel: row.battery_level,
  signalStrength: row.signal_strength,
  rawPayload: row.raw_payload,
});

const getMetricConfig = (metricKey) => ANALYTICS_METRICS[normalizeMetricKey(metricKey)];

const metricValue = (metrics, metricKey) => {
  const key = normalizeMetricKey(metricKey);
  const value = metrics?.[key];
  return Number.isFinite(Number(value)) ? Number(value) : null;
};

const roundMetric = (value, metricKey) => {
  if (!Number.isFinite(Number(value))) return null;
  const precision = getMetricConfig(metricKey).precision;
  return Number(Number(value).toFixed(precision));
};

const evaluateReading = (reading, device = null, now = new Date()) => {
  const metrics = toSensorMetrics(reading);
  const threshold = evaluateSensorMetrics(metrics);
  const lastSeen = device?.last_seen_at || device?.lastSeenAt || reading?.timestamp || metrics.readingTime || null;
  const offline = evaluateOfflineStatus(lastSeen, now);
  const status = worseStatus(threshold.overallStatus, offline.status === STATUS.NORMAL ? 'normal' : 'stale');
  return {
    metrics,
    threshold,
    offline,
    status,
  };
};

const bucketStart = (dateValue, granularity) => {
  const date = dateValue instanceof Date ? new Date(dateValue) : new Date(dateValue);
  if (Number.isNaN(date.getTime())) return null;
  if (granularity === 'hourly') {
    date.setMinutes(0, 0, 0);
    return date.toISOString();
  }
  if (granularity === 'weekly') {
    const day = date.getUTCDay();
    const diff = day === 0 ? 6 : day - 1;
    date.setUTCDate(date.getUTCDate() - diff);
  }
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
};

const aggregateTimeSeries = ({ readings, devicesById, metricKey, granularity }) => {
  const buckets = new Map();
  for (const reading of readings) {
    const key = bucketStart(reading.timestamp, granularity);
    if (!key) continue;
    const device = devicesById.get(String(reading.device_id || reading.deviceId || '')) || null;
    const evaluation = evaluateReading(reading, device);
    const value = metricValue(evaluation.metrics, metricKey);
    if (value === null) continue;
    const bucket = buckets.get(key) || {
      timestamp: key,
      min: value,
      max: value,
      sum: 0,
      count: 0,
      breachCount: 0,
      warningCount: 0,
      criticalCount: 0,
    };
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);
    bucket.sum += value;
    bucket.count += 1;
    const metricStatus = statusLower(evaluation.threshold.metrics?.[normalizeMetricKey(metricKey)]?.status);
    if (metricStatus === 'warning' || metricStatus === 'critical') bucket.breachCount += 1;
    if (metricStatus === 'warning') bucket.warningCount += 1;
    if (metricStatus === 'critical') bucket.criticalCount += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
    .map((point) => ({
      timestamp: point.timestamp,
      min: roundMetric(point.min, metricKey),
      max: roundMetric(point.max, metricKey),
      avg: roundMetric(point.sum / Math.max(point.count, 1), metricKey),
      count: point.count,
      breachCount: point.breachCount,
      warningCount: point.warningCount,
      criticalCount: point.criticalCount,
    }));
};

const buildBreachSeries = ({ readings, devicesById, granularity = 'daily' }) => {
  const buckets = new Map();
  for (const reading of readings) {
    const key = bucketStart(reading.timestamp, granularity);
    if (!key) continue;
    const device = devicesById.get(String(reading.device_id || reading.deviceId || '')) || null;
    const evaluation = evaluateReading(reading, device);
    const status = statusLower(evaluation.threshold.overallStatus);
    const bucket = buckets.get(key) || { timestamp: key, warning: 0, critical: 0 };
    if (status === 'warning') bucket.warning += 1;
    if (status === 'critical') bucket.critical += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
};

const getMetricThresholdSummary = (metricKey) => {
  const thresholds = getSensorThresholds();
  const key = normalizeMetricKey(metricKey);
  if (key === 'temperature') {
    return {
      warningMin: thresholds.temperature.lowWarningC,
      warningMax: thresholds.temperature.highWarningC,
      criticalMin: thresholds.temperature.lowCriticalC,
      criticalMax: thresholds.temperature.highCriticalC,
    };
  }
  if (key === 'humidity') {
    return {
      warningMin: thresholds.humidity.lowWarningPct,
      warningMax: thresholds.humidity.highWarningPct,
      criticalMin: thresholds.humidity.lowCriticalPct,
      criticalMax: thresholds.humidity.highCriticalPct,
    };
  }
  if (key === 'ppm') return { warningMax: thresholds.ppm.warning, criticalMax: thresholds.ppm.critical };
  if (key === 'battery') return { warningMin: thresholds.battery.lowWarningPct, criticalMin: thresholds.battery.lowCriticalPct };
  return {};
};

const mapMetricCard = ({ metricKey, latestReading, previousReading, device }) => {
  const config = getMetricConfig(metricKey);
  if (!latestReading) {
    return {
      key: config.key,
      label: config.label,
      unit: config.unit,
      value: null,
      status: 'stale',
      lastUpdatedAt: null,
      trend: null,
      threshold: getMetricThresholdSummary(metricKey),
    };
  }
  const latestEval = evaluateReading(latestReading, device);
  const previousEval = previousReading ? evaluateReading(previousReading, device) : null;
  const value = metricValue(latestEval.metrics, metricKey);
  const previousValue = previousEval ? metricValue(previousEval.metrics, metricKey) : null;
  const metricStatus = statusLower(latestEval.threshold.metrics?.[normalizeMetricKey(metricKey)]?.status);
  return {
    key: config.key,
    label: config.label,
    unit: config.unit,
    value: roundMetric(value, metricKey),
    status: value === null ? 'stale' : worseStatus(metricStatus, latestEval.status === 'stale' ? 'stale' : 'normal'),
    lastUpdatedAt: latestReading.timestamp || null,
    trend:
      value === null || previousValue === null
        ? null
        : Number((Number(value) - Number(previousValue)).toFixed(config.precision)),
    threshold: getMetricThresholdSummary(metricKey),
  };
};

const buildDeviceLabelMaps = async (devices) => {
  const facilityIds = uniqueIds(devices.map((row) => row.facility_id));
  const toiletIds = uniqueIds(devices.map((row) => row.toilet_unit_id));
  const [facilities, toilets] = await Promise.all([
    facilityIds.length
      ? Facility.findAll({ where: { id: { [Op.in]: facilityIds } }, attributes: ['id', 'code', 'name'], raw: true })
      : [],
    toiletIds.length
      ? ToiletUnit.findAll({ where: { id: { [Op.in]: toiletIds } }, attributes: ['id', 'code', 'location_label'], raw: true })
      : [],
  ]);
  return {
    facilitiesById: new Map(facilities.map((row) => [String(row.id), row])),
    toiletsById: new Map(toilets.map((row) => [String(row.id), row])),
  };
};

const mapOperationalDeviceStatus = ({ device, latestReading, previousReading, facilitiesById, toiletsById }) => {
  const evaluation = latestReading ? evaluateReading(latestReading, device) : evaluateReading({ timestamp: device.last_seen_at }, device);
  const facility = facilitiesById.get(String(device.facility_id || '')) || null;
  const toilet = toiletsById.get(String(device.toilet_unit_id || '')) || null;
  return {
    deviceId: device.id,
    externalDeviceId: device.device_id,
    tenantId: device.tenant_id,
    facilityId: device.facility_id,
    facilityName: facility?.name || null,
    facilityCode: facility?.code || null,
    toiletUnitId: device.toilet_unit_id,
    toiletCode: toilet?.code || null,
    toiletName: toilet?.location_label || toilet?.code || null,
    status: latestReading ? evaluation.status : 'stale',
    lastCapturedAt: latestReading?.timestamp || null,
    lastSeenAt: device.last_seen_at || null,
    staleMinutes: evaluation.offline.minutes,
    metrics: Object.keys(ANALYTICS_METRICS).map((metricKey) =>
      mapMetricCard({ metricKey, latestReading, previousReading, device })
    ),
  };
};

const mapDevice = (device) => ({
  id: device.id,
  tenantId: device.tenant_id,
  facilityId: device.facility_id,
  toiletBlockId: device.toilet_block_id,
  toiletUnitId: device.toilet_unit_id,
  deviceId: device.device_id,
  serialNo: device.serial_no,
  deviceType: device.device_type,
  status: device.status,
  firmwareVersion: device.firmware_version,
  lastSeenAt: device.last_seen_at,
  metadata: device.metadata || null,
});

const mapSeverity = (severity) => ALERT_SEVERITY_BY_LEVEL[String(severity || '').toLowerCase()] || 'medium';

const upsertSensorAlert = async ({
  device,
  alertType,
  severity,
  message,
}) => {
  const active = await Alert.findOne({
    where: {
      source_type: 'sensor',
      source_id: device.id,
      alert_type: alertType,
      status: { [Op.in]: ['open', 'acknowledged'] },
    },
    order: [['created_at', 'DESC']],
  });
  if (active) {
    // refresh severity/message without creating duplicates
    await active.update({
      severity: mapSeverity(severity),
      message: message || active.message,
      updated_at: new Date(),
    });
    return active;
  }

  const alert = await Alert.create({
    tenant_id: device.tenant_id,
    alert_type: alertType,
    severity: mapSeverity(severity),
    source_type: 'sensor',
    source_id: device.id,
    facility_id: device.facility_id,
    message,
    status: 'open',
    created_at: new Date(),
    updated_at: new Date(),
  });

  eventBus.emit(EVENTS.ALERT_CREATED, {
    id: alert.id,
    tenantId: alert.tenant_id,
    facilityId: alert.facility_id,
    message: alert.message,
    severity: alert.severity,
  });
  return alert;
};

const resolveSensorAlertType = async ({ deviceId, alertType }) => {
  const active = await Alert.findOne({
    where: {
      source_type: 'sensor',
      source_id: deviceId,
      alert_type: alertType,
      status: { [Op.in]: ['open', 'acknowledged'] },
    },
    order: [['created_at', 'DESC']],
  });
  if (!active) return null;
  await active.update({
    status: 'resolved',
    resolved_at: new Date(),
    updated_at: new Date(),
  });
  eventBus.emit(EVENTS.ALERT_UPDATED, {
    id: active.id,
    tenantId: active.tenant_id,
    facilityId: active.facility_id,
    severity: active.severity,
    status: active.status,
  });
  return active;
};

const emitThresholdAlerts = async ({ device, metrics }) => {
  const evaluation = evaluateSensorMetrics(metrics);
  const activeAlertTypes = new Set(evaluation.alerts.map((item) => item.type));

  for (const candidate of evaluation.alerts) {
    const metricLabel = candidate.metric === 'ppm' ? 'PPM' : candidate.metric;
    await upsertSensorAlert({
      device,
      alertType: candidate.type,
      severity: candidate.severity,
      message: `Sensor ${device.device_id} ${metricLabel} ${candidate.direction === 'low' ? 'below' : 'above'} threshold (${candidate.value} vs ${candidate.threshold})`,
    });
  }

  // Auto-resolve stale alerts for metrics that returned to NORMAL.
  const existingActive = await Alert.findAll({
    where: {
      source_type: 'sensor',
      source_id: device.id,
      status: { [Op.in]: ['open', 'acknowledged'] },
      alert_type: { [Op.in]: [...SENSOR_ALERT_TYPE_SET] },
    },
  });
  for (const alert of existingActive) {
    if (alert.alert_type === 'SENSOR_OFFLINE') continue;
    if (!activeAlertTypes.has(alert.alert_type)) {
      await resolveSensorAlertType({ deviceId: device.id, alertType: alert.alert_type });
    }
  }

  return evaluation;
};

const resolveOfflineAlertOnReading = async (device) => {
  await resolveSensorAlertType({ deviceId: device.id, alertType: 'SENSOR_OFFLINE' });
};

const assertDeviceInScope = (req, device, { ingestion = false } = {}) => {
  if (!req.user.isSuperAdmin && device.tenant_id !== req.user.tenantId) {
    throw new AppError('Sensor device out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!device.facility_id) {
    return;
  }
  if (isFacilityInScope(req, device.facility_id)) {
    return;
  }
  // Mobile field workers ingest BLE readings tenant-wide (same policy as QR inspections).
  if (ingestion && hasFieldInspectionRole(req)) {
    return;
  }
  throw new AppError('Sensor device out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
};

const uniqueIds = (values = []) =>
  [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];

const pickLatestIso = (...values) => {
  let latest = null;
  let latestMs = -1;
  for (const value of values) {
    if (!value) continue;
    const date = value instanceof Date ? value : new Date(value);
    const ms = date.getTime();
    if (Number.isNaN(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = date.toISOString();
    }
  }
  return latest;
};

const batchLatestReadingsByDeviceId = async (deviceIds = []) => {
  const ids = uniqueIds(deviceIds);
  if (ids.length === 0) return new Map();
  const rows = await SensorReading.findAll({
    where: { device_id: { [Op.in]: ids } },
    order: [['timestamp', 'DESC']],
    limit: Math.max(100, ids.length * 8),
  });
  const latestByDeviceId = new Map();
  for (const row of rows) {
    const key = String(row.device_id || '');
    if (!key || latestByDeviceId.has(key)) continue;
    latestByDeviceId.set(key, row);
  }
  return latestByDeviceId;
};

const batchReadingCountsByDeviceId = async (deviceIds = []) => {
  const ids = uniqueIds(deviceIds);
  if (ids.length === 0) return new Map();
  const rows = await SensorReading.findAll({
    where: { device_id: { [Op.in]: ids } },
    attributes: ['device_id', [fn('COUNT', col('id')), 'reading_count']],
    group: ['device_id'],
    raw: true,
  });
  return new Map(
    rows.map((row) => [String(row.device_id || ''), Number(row.reading_count || 0)])
  );
};

const mapDeviceListItem = (device, ctx = {}) => {
  const base = mapDevice(device);
  const latestReading = ctx.latestReading || null;
  const metadata =
    device.metadata && typeof device.metadata === 'object' && !Array.isArray(device.metadata)
      ? device.metadata
      : {};
  const metrics = latestReading
    ? toSensorMetrics(latestReading)
    : toSensorMetrics({
        lastSeenAt: base.lastSeenAt,
        batteryLevel: metadata.lastBattery,
        signalStrength: metadata.rssi,
      });
  const effectiveLastSeen = pickLatestIso(base.lastSeenAt, latestReading?.timestamp);
  const offline = evaluateOfflineStatus(effectiveLastSeen, ctx.now || new Date());
  const isOnline = offline.status === STATUS.NORMAL;

  return {
    ...base,
    facilityCode: ctx.facility?.code || null,
    facilityName: ctx.facility?.name || null,
    toiletUnitCode: ctx.toilet?.code || null,
    readingCount: ctx.readingCount ?? 0,
    latestReading,
    metrics,
    connectivityStatus: offline.status,
    connectivityMinutes: offline.minutes,
    isOnline,
    latestTemperature: metrics.temperature,
    latestHumidity: metrics.humidity,
    signalStrength: metrics.rssi,
    batteryLevel: metrics.battery,
    lastSeenAt: effectiveLastSeen || base.lastSeenAt,
  };
};

// Resolve a toilet unit + its parent facility and validate tenant/facility scope for the caller.
const resolveToiletInScope = async (req, toiletUnitId) => {
  if (!toiletUnitId || !isUuid(String(toiletUnitId))) {
    throw new AppError('A valid toiletUnitId is required', 400, { code: 'TOILET_ID_INVALID' });
  }
  const toilet = await ToiletUnit.findByPk(toiletUnitId);
  if (!toilet) {
    throw new AppError('Toilet unit not found', 404, { code: 'TOILET_NOT_FOUND' });
  }
  if (toilet.deleted_at) {
    throw new AppError('This toilet is no longer available.', 410, { code: 'TOILET_DELETED' });
  }
  const facility = await Facility.findByPk(toilet.facility_id);
  if (!facility) {
    throw new AppError('Toilet facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    throw new AppError('Toilet out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Toilet out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  return { toilet, facility };
};

const resolveTenantId = (req, facility) => {
  if (req.user.isSuperAdmin) {
    return facility.tenant_id;
  }
  return req.user.tenantId;
};

/* -------------------------------------------------------------------------- */
/* Phase 3 — Ingestion (idempotent, version-tolerant, generic-field aware)     */
/* -------------------------------------------------------------------------- */

const ingestSensorReading = async (req) => {
  const device = await SensorDevice.findOne({
    where: {
      [Op.or]: [
        ...(isUuid(String(req.body.deviceId || '')) ? [{ id: req.body.deviceId }] : []),
        { device_id: req.body.deviceId },
      ],
    },
  });
  if (!device) {
    throw new AppError('Sensor device not found', 404, { code: 'SENSOR_NOT_FOUND' });
  }
  assertDeviceInScope(req, device, { ingestion: true });

  // If the client claims a toilet, the backend mapping must already confirm it.
  const claimedToiletUnitId = req.body.toiletUnitId || null;
  if (claimedToiletUnitId && String(device.toilet_unit_id || '') !== String(claimedToiletUnitId)) {
    throw new AppError('Sensor is not attached to the provided toilet', 409, {
      code: 'SENSOR_TOILET_MISMATCH',
    });
  }

  const clientReadingId = sanitizeText(req.body.clientReadingId, 120) || null;

  // Idempotency: a device may never persist the same client_reading_id twice.
  if (clientReadingId) {
    const existing = await SensorReading.findOne({
      where: { device_id: device.id, client_reading_id: clientReadingId },
    });
    if (existing) {
      return { deviceId: device.id, reading: mapReading(existing), duplicate: true };
    }
  }

  // Server-side parse — never trust the mobile to have parsed correctly.
  const rawPayloadInput =
    req.body.rawPayload !== undefined ? req.body.rawPayload : req.body.payload;
  const parsed = rawPayloadInput != null && rawPayloadInput !== ''
    ? parseSensorPayload(rawPayloadInput)
    : null;

  const temperature = parseNumeric(req.body.temperature) ?? parsed?.parsed?.temperature ?? null;
  const humidity = parseNumeric(req.body.humidity) ?? parsed?.parsed?.humidity ?? null;
  const ppm = parseNumeric(req.body.ppm) ?? parsed?.parsed?.ppm ?? null;
  const signalStrength = parseNumeric(req.body.rssi) ?? parseNumeric(req.body.signalStrength);

  const captured = resolveCaptureTimestamp(
    {
      ...req.body,
      capturedAt: req.body.timestamp,
      capturedAtUtc: req.body.recordedAtUtc || req.body.recorded_at_utc || req.body.timestampUtc,
      capturedAtLocal: req.body.recordedAtLocal || req.body.recorded_at_local,
      captureTimezone: req.body.sourceTimezone || req.body.source_timezone || req.body.captureTimezone,
      captureOffsetMinutes: req.body.sourceOffsetMinutes || req.body.source_offset_minutes,
    },
    getDefaultTimezone()
  );
  const timestamp = captured.capturedAtUtc;

  // Preserve legacy raw_payload behaviour for non-BLE callers; structure BLE payloads.
  const rawPayload = parsed
    ? {
        source: req.body.source || 'ble',
        receivedAt: new Date().toISOString(),
        raw: parsed.raw,
        version: parsed.version,
        fieldCount: parsed.fieldCount,
        fields: parsed.fields,
        parsed: parsed.parsed,
        metrics_v1: toSensorMetrics({
          ...parsed.parsed,
          readingTime: timestamp,
          batteryLevel: parseNumeric(req.body.batteryLevel),
          signalStrength,
          raw: parsed.raw,
        }),
        clientReadingId,
      }
    : req.body.rawPayload || req.body;

  let reading;
  try {
    reading = await SensorReading.create({
      device_id: device.id,
      client_reading_id: clientReadingId,
      timestamp,
      recorded_at_utc: timestamp,
      source_timezone: captured.captureTimezone,
      source_offset_minutes: captured.captureOffsetMinutes,
      ppm,
      humidity,
      temperature,
      occupancy_count: parseNumeric(req.body.occupancyCount),
      footfall_count: parseNumeric(req.body.footfallCount),
      tank_fill_level: parseNumeric(req.body.tankFillLevel),
      battery_level: parseNumeric(req.body.batteryLevel),
      signal_strength: signalStrength,
      raw_payload: rawPayload,
    });
  } catch (error) {
    // Concurrency-safe idempotency: a parallel request won the (device_id, client_reading_id)
    // unique index. Return the already-persisted row instead of surfacing a 500.
    if (clientReadingId && error?.name === 'SequelizeUniqueConstraintError') {
      const existing = await SensorReading.findOne({
        where: { device_id: device.id, client_reading_id: clientReadingId },
      });
      if (existing) {
        return { deviceId: device.id, reading: mapReading(existing), duplicate: true };
      }
    }
    throw error;
  }

  await device.update({ last_seen_at: timestamp, updated_at: new Date() });
  const metrics = toSensorMetrics({
    ...mapReading(reading),
    timestamp,
  });
  await emitThresholdAlerts({ device, metrics });
  await resolveOfflineAlertOnReading(device);

  eventBus.emit(EVENTS.SENSOR_READING, {
    tenantId: device.tenant_id,
    facilityId: device.facility_id,
    toiletUnitId: device.toilet_unit_id,
    deviceId: device.id,
    reading: mapReading(reading),
  });

  await createAuditLog({
    req,
    tenantId: device.tenant_id,
    action: 'sensor.ingest',
    entityType: 'sensor_device',
    entityId: device.id,
    details: { clientReadingId, version: parsed?.version || null },
  });

  return {
    deviceId: device.id,
    reading: mapReading(reading),
    duplicate: false,
  };
};

const checkSensorOfflineAlerts = async (req) => {
  let where = scopedWhere(req, {}, 'sensor');
  where = { ...where, status: { [Op.ne]: 'inactive' } };

  const devices = await SensorDevice.findAll({
    where,
    attributes: ['id', 'tenant_id', 'facility_id', 'device_id', 'last_seen_at'],
    order: [['last_seen_at', 'ASC']],
  });

  let opened = 0;
  let resolved = 0;
  for (const device of devices) {
    const offline = evaluateOfflineStatus(device.last_seen_at, new Date());
    if (offline.status === STATUS.NORMAL) {
      const previous = await resolveSensorAlertType({ deviceId: device.id, alertType: 'SENSOR_OFFLINE' });
      if (previous) resolved += 1;
      continue;
    }
    const severity = offline.status === STATUS.CRITICAL ? 'critical' : 'medium';
    const alert = await upsertSensorAlert({
      device,
      alertType: 'SENSOR_OFFLINE',
      severity,
      message: `Sensor ${device.device_id} offline for ${offline.minutes} minutes`,
    });
    if (alert) opened += 1;
  }

  return { checked: devices.length, opened, resolved };
};

/* -------------------------------------------------------------------------- */
/* Phase 2 — Commissioning (attach / replace / detach)                         */
/* -------------------------------------------------------------------------- */

const findDeviceByIdentifier = async (identifier) => {
  if (!identifier) return null;
  return SensorDevice.findOne({
    where: {
      [Op.or]: [
        ...(isUuid(String(identifier)) ? [{ id: identifier }] : []),
        { device_id: identifier },
      ],
    },
  });
};

// Core attach routine shared by attach + replace.
const attachSensorToToilet = async (req, { replace = false } = {}) => {
  const deviceIdentifier = sanitizeText(req.body.deviceId, 140);
  if (!deviceIdentifier) {
    throw new AppError('deviceId is required', 400, { code: 'DEVICE_ID_REQUIRED' });
  }

  const { toilet, facility } = await resolveToiletInScope(req, req.body.toiletUnitId);
  const tenantId = resolveTenantId(req, facility);

  const existingDevice = await findDeviceByIdentifier(deviceIdentifier);

  // A known device must belong to the caller's tenant.
  if (existingDevice && !req.user.isSuperAdmin && existingDevice.tenant_id !== req.user.tenantId) {
    throw new AppError('Sensor device belongs to another tenant', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  // Idempotent: device already actively attached to this exact toilet.
  if (
    existingDevice &&
    existingDevice.status === 'active' &&
    String(existingDevice.toilet_unit_id || '') === String(toilet.id)
  ) {
    return { device: mapDevice(existingDevice), created: false, alreadyAttached: true };
  }

  // Guard: device already actively attached to a different toilet.
  if (
    existingDevice &&
    existingDevice.status === 'active' &&
    existingDevice.toilet_unit_id &&
    String(existingDevice.toilet_unit_id) !== String(toilet.id) &&
    !replace
  ) {
    throw new AppError('Sensor is already attached to another toilet', 409, {
      code: 'SENSOR_ALREADY_ATTACHED',
    });
  }

  // Guard: this toilet already has a different active sensor.
  const otherActiveOnToilet = await SensorDevice.findOne({
    where: {
      toilet_unit_id: toilet.id,
      status: 'active',
      ...(existingDevice ? { id: { [Op.ne]: existingDevice.id } } : {}),
    },
  });
  if (otherActiveOnToilet) {
    if (!replace) {
      throw new AppError('Toilet already has an active sensor; replace it instead', 409, {
        code: 'TOILET_ALREADY_HAS_SENSOR',
      });
    }
    await otherActiveOnToilet.update({
      status: 'inactive',
      toilet_unit_id: null,
      toilet_block_id: null,
      updated_at: new Date(),
    });
    await createAuditLog({
      req,
      tenantId,
      action: 'sensor.detach',
      entityType: 'sensor_device',
      entityId: otherActiveOnToilet.id,
      details: { reason: 'replaced', toiletUnitId: toilet.id },
    });
  }

  const attributes = {
    tenant_id: tenantId,
    facility_id: facility.id,
    toilet_block_id: toilet.toilet_block_id || null,
    toilet_unit_id: toilet.id,
    serial_no: sanitizeText(req.body.serialNo, 140) || existingDevice?.serial_no || null,
    device_type: sanitizeText(req.body.deviceType, 60) || existingDevice?.device_type || DEFAULT_BLE_DEVICE_TYPE,
    firmware_version:
      sanitizeText(req.body.firmwareVersion, 80) || existingDevice?.firmware_version || null,
    status: 'active',
    updated_at: new Date(),
  };

  let device;
  let created = false;
  if (existingDevice) {
    device = await existingDevice.update(attributes);
  } else {
    device = await SensorDevice.create({
      device_id: deviceIdentifier,
      ...attributes,
    });
    created = true;
  }

  await createAuditLog({
    req,
    tenantId,
    action: 'sensor.attach',
    entityType: 'sensor_device',
    entityId: device.id,
    details: { toiletUnitId: toilet.id, facilityId: facility.id, replace, created },
  });

  eventBus.emit(EVENTS.FACILITY_METRICS_UPDATED, {
    tenantId,
    facilityId: facility.id,
    toiletUnitId: toilet.id,
    deviceId: device.id,
  });

  return { device: mapDevice(device), created, alreadyAttached: false };
};

const attachSensor = (req) => attachSensorToToilet(req, { replace: false });

const replaceSensor = (req) => attachSensorToToilet(req, { replace: true });

/* -------------------------------------------------------------------------- */
/* Registration — record a discovered BLE device WITHOUT a toilet mapping.     */
/* Lets the mobile app register a sensor the moment it connects (before any    */
/* commissioning) so it appears in Ops and can ingest readings. Idempotent     */
/* upsert by device_id; never downgrades an actively-attached device.          */
/* -------------------------------------------------------------------------- */

const registerSensor = async (req) => {
  const deviceIdentifier = sanitizeText(req.body.deviceId, 140);
  if (!deviceIdentifier) {
    throw new AppError('deviceId is required', 400, { code: 'DEVICE_ID_REQUIRED' });
  }

  // Tenant resolution: non-super-admins always register into their own tenant.
  let tenantId = req.user.tenantId;
  if (req.user.isSuperAdmin) {
    tenantId = sanitizeText(req.body.tenantId, 80) || null;
    if (!tenantId) {
      throw new AppError('tenantId is required for super admin registration', 400, {
        code: 'TENANT_ID_REQUIRED',
      });
    }
  }
  if (!tenantId) {
    throw new AppError('Unable to resolve tenant for sensor registration', 400, {
      code: 'TENANT_ID_REQUIRED',
    });
  }

  const batteryLevel = parseNumeric(req.body.batteryLevel);
  const now = new Date();

  // Build/merge metadata — preserve forensic discovery context (advertised name,
  // RSSI, BLE service/characteristic UUIDs, last battery, who saw it).
  const incomingMeta = req.body.metadata && typeof req.body.metadata === 'object'
    ? req.body.metadata
    : {};
  const registrationMeta = {
    source: incomingMeta.source || 'mobile_ble',
    advertisedName: sanitizeText(req.body.deviceName || incomingMeta.advertisedName, 140) || null,
    serviceUuid: sanitizeText(req.body.serviceUuid || incomingMeta.serviceUuid, 80) || null,
    characteristicUuid:
      sanitizeText(req.body.characteristicUuid || incomingMeta.characteristicUuid, 80) || null,
    lastSeenByUserId: req.user.id || incomingMeta.lastSeenByUserId || null,
    rssi: parseNumeric(req.body.rssi) ?? parseNumeric(incomingMeta.rssi),
    lastBattery: batteryLevel,
    registeredAt: now.toISOString(),
  };

  const existingDevice = await findDeviceByIdentifier(deviceIdentifier);

  if (existingDevice) {
    if (!req.user.isSuperAdmin && existingDevice.tenant_id !== req.user.tenantId) {
      throw new AppError('Sensor device belongs to another tenant', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    // Never disturb an actively-commissioned device — only refresh discovery info.
    const mergedMeta = {
      ...(existingDevice.metadata && typeof existingDevice.metadata === 'object'
        ? existingDevice.metadata
        : {}),
      ...registrationMeta,
    };
    await existingDevice.update({
      last_seen_at: now,
      firmware_version:
        sanitizeText(req.body.firmwareVersion, 80) || existingDevice.firmware_version || null,
      serial_no: existingDevice.serial_no || sanitizeText(req.body.serialNo, 140) || null,
      metadata: mergedMeta,
      updated_at: now,
    });

    await createAuditLog({
      req,
      tenantId: existingDevice.tenant_id,
      action: 'sensor.register',
      entityType: 'sensor_device',
      entityId: existingDevice.id,
      details: { deviceId: deviceIdentifier, created: false },
    });

    return { device: mapDevice(existingDevice), created: false };
  }

  const device = await SensorDevice.create({
    tenant_id: tenantId,
    facility_id: null,
    toilet_block_id: null,
    toilet_unit_id: null,
    device_id: deviceIdentifier,
    serial_no: sanitizeText(req.body.serialNo, 140) || null,
    device_type: sanitizeText(req.body.deviceType, 60) || DEFAULT_BLE_DEVICE_TYPE,
    // Unattached until commissioned to a toilet; ingestion does not require 'active'.
    status: 'inactive',
    firmware_version: sanitizeText(req.body.firmwareVersion, 80) || null,
    last_seen_at: now,
    metadata: registrationMeta,
  });

  await createAuditLog({
    req,
    tenantId,
    action: 'sensor.register',
    entityType: 'sensor_device',
    entityId: device.id,
    details: { deviceId: deviceIdentifier, created: true },
  });

  return { device: mapDevice(device), created: true };
};

const detachSensor = async (req) => {
  const device = await findDeviceByIdentifier(req.params.id);
  if (!device) {
    throw new AppError('Sensor device not found', 404, { code: 'SENSOR_NOT_FOUND' });
  }
  assertDeviceInScope(req, device);

  await device.update({
    status: 'inactive',
    toilet_unit_id: null,
    toilet_block_id: null,
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    tenantId: device.tenant_id,
    action: 'sensor.detach',
    entityType: 'sensor_device',
    entityId: device.id,
    details: { reason: 'manual_detach' },
  });

  return { device: mapDevice(device), detached: true };
};

/* -------------------------------------------------------------------------- */
/* Phase 6 — Per-toilet reading APIs                                           */
/* -------------------------------------------------------------------------- */

// Resolve devices attached to a toilet (scoped). Returns { toilet, devices, deviceIds }.
const resolveToiletDevices = async (req, { activeOnly = false } = {}) => {
  const { toilet } = await resolveToiletInScope(req, req.params.toiletUnitId);
  const devices = await SensorDevice.findAll({
    where: {
      toilet_unit_id: toilet.id,
      ...(activeOnly ? { status: 'active' } : {}),
    },
    order: [['last_seen_at', 'DESC']],
  });
  return { toilet, devices, deviceIds: devices.map((d) => d.id) };
};

const getToiletLatestReading = async (req) => {
  const { toilet, devices, deviceIds } = await resolveToiletDevices(req);
  if (deviceIds.length === 0) {
    return { toiletUnitId: toilet.id, devices: [], latestReading: null };
  }
  const latest = await SensorReading.findOne({
    where: { device_id: { [Op.in]: deviceIds } },
    order: [['timestamp', 'DESC']],
  });
  return {
    toiletUnitId: toilet.id,
    devices: devices.map(mapDevice),
    latestReading: latest ? mapReading(latest) : null,
  };
};

const getToiletReadingHistory = async (req) => {
  const { toilet, deviceIds } = await resolveToiletDevices(req);
  const { page, limit, offset } = normalizePagination(req.query);
  const range = resolveDateRange(req.query, { maxDays: 90 });

  if (deviceIds.length === 0) {
    return {
      items: [],
      meta: { page, limit, total: 0, totalPages: 1, range: range.range, toiletUnitId: toilet.id },
    };
  }

  let where = { device_id: { [Op.in]: deviceIds } };
  where = applyDateRangeToWhere(where, 'timestamp', range);

  const { rows, count } = await SensorReading.findAndCountAll({
    where,
    order: [['timestamp', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map(mapReading),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
      range: range.range,
      toiletUnitId: toilet.id,
    },
  };
};

const getToiletReadingSummary = async (req) => {
  const { toilet, devices, deviceIds } = await resolveToiletDevices(req);
  const range = resolveDateRange(req.query, { maxDays: 90, defaultRange: 'last7' });

  const base = {
    toiletUnitId: toilet.id,
    range: range.range,
    deviceCount: devices.length,
    activeDeviceCount: devices.filter((d) => d.status === 'active').length,
    lastSeenAt: devices.reduce((latest, d) => {
      if (!d.last_seen_at) return latest;
      if (!latest || new Date(d.last_seen_at) > new Date(latest)) return d.last_seen_at;
      return latest;
    }, null),
  };

  if (deviceIds.length === 0) {
    return { ...base, readingCount: 0, temperature: null, humidity: null, firstReadingAt: null, lastReadingAt: null };
  }

  let where = { device_id: { [Op.in]: deviceIds } };
  where = applyDateRangeToWhere(where, 'timestamp', range);

  // Single aggregate query — no N+1, no full table scan (uses (device_id,timestamp) index).
  const [agg] = await SensorReading.findAll({
    where,
    attributes: [
      [fn('COUNT', col('id')), 'reading_count'],
      [fn('AVG', col('temperature')), 'avg_temperature'],
      [fn('MIN', col('temperature')), 'min_temperature'],
      [fn('MAX', col('temperature')), 'max_temperature'],
      [fn('AVG', col('humidity')), 'avg_humidity'],
      [fn('MIN', col('humidity')), 'min_humidity'],
      [fn('MAX', col('humidity')), 'max_humidity'],
      [fn('MIN', col('timestamp')), 'first_reading_at'],
      [fn('MAX', col('timestamp')), 'last_reading_at'],
    ],
    raw: true,
  });

  const round = (value) => (value == null ? null : Number(Number(value).toFixed(2)));

  return {
    ...base,
    readingCount: Number(agg?.reading_count || 0),
    temperature: {
      avg: round(agg?.avg_temperature),
      min: round(agg?.min_temperature),
      max: round(agg?.max_temperature),
    },
    humidity: {
      avg: round(agg?.avg_humidity),
      min: round(agg?.min_humidity),
      max: round(agg?.max_humidity),
    },
    firstReadingAt: agg?.first_reading_at || null,
    lastReadingAt: agg?.last_reading_at || null,
  };
};

/* -------------------------------------------------------------------------- */
/* Existing list / metrics / alerts (unchanged behaviour)                      */
/* -------------------------------------------------------------------------- */

const listSensors = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  let where = scopedWhere(req, {}, 'sensor');
  if (req.query.status) {
    where.status = req.query.status;
  }
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }
  if (req.query.toiletUnitId) {
    where.toilet_unit_id = req.query.toiletUnitId;
  }

  const { rows, count } = await SensorDevice.findAndCountAll({
    where,
    order: [['last_seen_at', 'DESC NULLS LAST']],
    limit,
    offset,
  });

  const deviceIds = rows.map((row) => row.id);
  const now = new Date();
  const [latestByDeviceId, readingCountByDeviceId] = await Promise.all([
    batchLatestReadingsByDeviceId(deviceIds),
    batchReadingCountsByDeviceId(deviceIds),
  ]);

  const facilityIds = uniqueIds(rows.map((row) => row.facility_id));
  const toiletUnitIds = uniqueIds(rows.map((row) => row.toilet_unit_id));
  const [facilities, toilets] = await Promise.all([
    facilityIds.length
      ? Facility.findAll({
          where: { id: { [Op.in]: facilityIds } },
          attributes: ['id', 'code', 'name'],
        })
      : [],
    toiletUnitIds.length
      ? ToiletUnit.findAll({
          where: { id: { [Op.in]: toiletUnitIds } },
          attributes: ['id', 'code', 'facility_id'],
        })
      : [],
  ]);
  const facilityById = new Map(facilities.map((row) => [String(row.id), row]));
  const toiletById = new Map(toilets.map((row) => [String(row.id), row]));

  return {
    items: rows.map((device) => {
      const deviceKey = String(device.id);
      const latestRow = latestByDeviceId.get(deviceKey) || null;
      return mapDeviceListItem(device, {
        now,
        facility: facilityById.get(String(device.facility_id || '')) || null,
        toilet: toiletById.get(String(device.toilet_unit_id || '')) || null,
        latestReading: latestRow ? mapReading(latestRow) : null,
        readingCount: readingCountByDeviceId.get(deviceKey) || 0,
      });
    }),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const listSensorReadings = async (req) => {
  const device = await SensorDevice.findByPk(req.params.id);
  if (!device) {
    throw new AppError('Sensor device not found', 404, { code: 'SENSOR_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && device.tenant_id !== req.user.tenantId) {
    throw new AppError('Sensor out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (device.facility_id && !isFacilityInScope(req, device.facility_id)) {
    throw new AppError('Sensor out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  const { page, limit, offset } = normalizePagination(req.query);
  const { rows, count } = await SensorReading.findAndCountAll({
    where: { device_id: device.id },
    order: [['timestamp', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map(mapReading),
    meta: { page, limit, total: count, totalPages: Math.max(1, Math.ceil(count / limit)) },
  };
};

const getFacilityLiveMetrics = async (req) => {
  const facility = await Facility.findByPk(req.params.id);
  if (!facility) {
    throw new AppError('Facility not found', 404, { code: 'FACILITY_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, facility.id)) {
    throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const devices = await SensorDevice.findAll({
    where: { facility_id: facility.id },
    order: [['device_id', 'ASC']],
  });

  const readings = await Promise.all(
    devices.map((device) =>
      SensorReading.findOne({
        where: { device_id: device.id },
        order: [['timestamp', 'DESC']],
      })
    )
  );

  const latestReadings = readings.filter(Boolean).map(mapReading);
  const ppmAvg =
    latestReadings.length === 0
      ? 0
      : latestReadings.reduce((sum, row) => sum + Number(row.ppm || 0), 0) /
        latestReadings.length;

  return {
    facilityId: facility.id,
    facilityName: facility.name,
    sensors: devices.map((device) => ({
      id: device.id,
      deviceId: device.device_id,
      type: device.device_type,
      status: device.status,
      lastSeenAt: device.last_seen_at,
    })),
    latestReadings,
    summary: {
      averagePpm: Number(ppmAvg.toFixed(2)),
      activeSensors: devices.filter((device) => device.status === 'active').length,
      totalSensors: devices.length,
    },
  };
};

const getLiveAlerts = async (req) => {
  let where = scopedWhere(
    req,
    {
    status: {
      [Op.in]: ['open', 'acknowledged'],
    },
    },
    'alert',
  );
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }

  const alerts = await Alert.findAll({
    where,
    order: [['created_at', 'DESC']],
    limit: Number(req.query.limit || 100),
  });

  return alerts.map((alert) => ({
    id: alert.id,
    tenantId: alert.tenant_id,
    alertType: alert.alert_type,
    severity: alert.severity,
    sourceType: alert.source_type,
    sourceId: alert.source_id,
    facilityId: alert.facility_id,
    message: alert.message,
    status: alert.status,
    createdAt: alert.created_at,
    acknowledgedAt: alert.acknowledged_at,
  }));
};

const resolveAnalyticsDevices = async (req, { activeOnly = false } = {}) => {
  let where = scopedWhere(req, {}, 'sensor');
  if (activeOnly) where.status = 'active';
  if (req.query.status) where.status = req.query.status;
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      throw new AppError('Facility out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
    }
    where.facility_id = req.query.facilityId;
  }
  if (req.query.toiletUnitId || req.query.toiletId) {
    where.toilet_unit_id = req.query.toiletUnitId || req.query.toiletId;
  }
  const toiletUnitIds = parseCsvIds(req.query.toiletUnitIds || req.query.toiletIds);
  if (toiletUnitIds.length > 0) {
    where.toilet_unit_id = { [Op.in]: toiletUnitIds };
  }
  const devices = await SensorDevice.findAll({
    where,
    order: [['last_seen_at', 'DESC NULLS LAST']],
    limit: Math.min(Number(req.query.deviceLimit || 1000), 5000),
  });
  const attachedToiletIds = uniqueIds(devices.map((device) => device.toilet_unit_id));
  if (attachedToiletIds.length === 0) return devices;
  const visibleToilets = await ToiletUnit.findAll({
    where: {
      id: { [Op.in]: attachedToiletIds },
      deleted_at: { [Op.is]: null },
    },
    attributes: ['id'],
    raw: true,
  });
  const visibleToiletIds = new Set(visibleToilets.map((row) => String(row.id)));
  return devices.filter((device) => !device.toilet_unit_id || visibleToiletIds.has(String(device.toilet_unit_id)));
};

const loadReadingsForDevices = async ({ deviceIds, range, limit = 10000 }) => {
  if (deviceIds.length === 0) return [];
  let where = { device_id: { [Op.in]: deviceIds } };
  where = applyDateRangeToWhere(where, 'timestamp', range);
  return SensorReading.findAll({
    where,
    order: [['timestamp', 'ASC']],
    limit: Math.min(Number(limit || 10000), 20000),
    raw: true,
  });
};

const buildComparisonRows = ({ devices, latestByDeviceId, readings, metricKey, facilitiesById, toiletsById }) => {
  const grouped = new Map();
  for (const device of devices) {
    grouped.set(String(device.id), {
      device,
      values: [],
      breachCount: 0,
      latestCapturedAt: latestByDeviceId.get(String(device.id))?.timestamp || null,
    });
  }
  for (const reading of readings) {
    const key = String(reading.device_id || '');
    const group = grouped.get(key);
    if (!group) continue;
    const evaluation = evaluateReading(reading, group.device);
    const value = metricValue(evaluation.metrics, metricKey);
    if (value !== null) group.values.push(value);
    const metricStatus = statusLower(evaluation.threshold.metrics?.[normalizeMetricKey(metricKey)]?.status);
    if (metricStatus === 'warning' || metricStatus === 'critical') group.breachCount += 1;
  }

  return [...grouped.values()]
    .map((group) => {
      const facility = facilitiesById.get(String(group.device.facility_id || '')) || null;
      const toilet = toiletsById.get(String(group.device.toilet_unit_id || '')) || null;
      const latest = latestByDeviceId.get(String(group.device.id)) || null;
      const latestEval = latest ? evaluateReading(latest, group.device) : null;
      const avg =
        group.values.length > 0
          ? group.values.reduce((sum, value) => sum + value, 0) / group.values.length
          : null;
      const max = group.values.length > 0 ? Math.max(...group.values) : null;
      return {
        deviceId: group.device.id,
        toiletId: group.device.toilet_unit_id,
        toiletName: toilet?.location_label || toilet?.code || group.device.device_id,
        toiletCode: toilet?.code || null,
        facilityId: group.device.facility_id,
        facilityName: facility?.name || null,
        avgValue: roundMetric(avg, metricKey),
        maxValue: roundMetric(max, metricKey),
        breachCount: group.breachCount,
        lastCapturedAt: group.latestCapturedAt,
        status: latestEval ? latestEval.status : 'stale',
      };
    })
    .sort((left, right) => right.breachCount - left.breachCount || Number(right.maxValue || 0) - Number(left.maxValue || 0));
};

const getSensorAnalyticsOverview = async (req) => {
  const metricKey = normalizeMetricKey(req.query.metric);
  const granularity = normalizeGranularity(req.query.granularity || 'hourly');
  const range = resolveDateRange(req.query, { maxDays: 90, defaultRange: req.query.range || 'last7' });
  const devices = await resolveAnalyticsDevices(req);
  const deviceIds = devices.map((device) => device.id);
  const [latestByDeviceId, readings, labels] = await Promise.all([
    batchLatestReadingsByDeviceId(deviceIds),
    loadReadingsForDevices({ deviceIds, range, limit: req.query.limit || 12000 }),
    buildDeviceLabelMaps(devices),
  ]);
  const previousByDeviceId = new Map();
  for (const reading of readings.slice().reverse()) {
    const key = String(reading.device_id || '');
    if (!latestByDeviceId.has(key)) continue;
    const latest = latestByDeviceId.get(key);
    if (String(latest.id) === String(reading.id)) continue;
    if (!previousByDeviceId.has(key)) previousByDeviceId.set(key, reading);
  }

  const devicesById = new Map(devices.map((device) => [String(device.id), device]));
  const latestStatuses = devices.map((device) =>
    mapOperationalDeviceStatus({
      device,
      latestReading: latestByDeviceId.get(String(device.id)) || null,
      previousReading: previousByDeviceId.get(String(device.id)) || null,
      facilitiesById: labels.facilitiesById,
      toiletsById: labels.toiletsById,
    })
  );
  const statusCounts = latestStatuses.reduce(
    (acc, row) => {
      acc[row.status] = Number(acc[row.status] || 0) + 1;
      return acc;
    },
    { normal: 0, warning: 0, critical: 0, stale: 0 }
  );
  const comparison = buildComparisonRows({
    devices,
    latestByDeviceId,
    readings,
    metricKey,
    facilitiesById: labels.facilitiesById,
    toiletsById: labels.toiletsById,
  });

  return {
    metric: getMetricConfig(metricKey),
    range: range.range,
    dateRange: { start: toIso(range.start), end: toIso(range.end), label: range.label },
    summary: {
      monitoredToilets: uniqueIds(devices.map((device) => device.toilet_unit_id)).length,
      activeSensors: devices.filter((device) => device.status === 'active').length,
      totalSensors: devices.length,
      normalCount: statusCounts.normal || 0,
      warningCount: statusCounts.warning || 0,
      criticalCount: statusCounts.critical || 0,
      staleCount: statusCounts.stale || 0,
      readingCount: readings.length,
    },
    latest: latestStatuses,
    topAttention: latestStatuses
      .filter((row) => ['critical', 'warning', 'stale'].includes(row.status))
      .sort((left, right) => (STATUS_RANK[right.status] || 0) - (STATUS_RANK[left.status] || 0))
      .slice(0, 5),
    timeSeries: aggregateTimeSeries({ readings, devicesById, metricKey, granularity }),
    breachSeries: buildBreachSeries({ readings, devicesById, granularity: 'daily' }),
    comparison: comparison.slice(0, 20),
    health: {
      activeSensors: devices.filter((device) => device.status === 'active').length,
      staleSensors: statusCounts.stale || 0,
      lowBatterySensors: latestStatuses.filter((row) =>
        row.metrics.some((metric) => metric.key === 'battery' && metric.status !== 'normal' && metric.value !== null)
      ).length,
      lastSyncAt: latestStatuses
        .map((row) => row.lastCapturedAt || row.lastSeenAt)
        .filter(Boolean)
        .sort()
        .pop() || null,
      signalIssues: latestStatuses.filter((row) =>
        row.metrics.some((metric) => metric.key === 'rssi' && metric.value !== null && Number(metric.value) < -85)
      ).length,
    },
  };
};

const getSensorTimeSeries = async (req) => {
  const metricKey = normalizeMetricKey(req.query.metric);
  const granularity = normalizeGranularity(req.query.granularity);
  const range = resolveDateRange(req.query, { maxDays: 180, defaultRange: req.query.range || 'last7' });
  const devices = await resolveAnalyticsDevices(req);
  const deviceIds = devices.map((device) => device.id);
  const readings = await loadReadingsForDevices({ deviceIds, range, limit: req.query.limit || 20000 });
  const devicesById = new Map(devices.map((device) => [String(device.id), device]));
  return {
    metric: getMetricConfig(metricKey),
    threshold: getMetricThresholdSummary(metricKey),
    granularity,
    range: { start: toIso(range.start), end: toIso(range.end), label: range.label },
    points: aggregateTimeSeries({ readings, devicesById, metricKey, granularity }),
  };
};

const getSensorComparison = async (req) => {
  const metricKey = normalizeMetricKey(req.query.metric);
  const range = resolveDateRange(req.query, { maxDays: 180, defaultRange: req.query.range || 'last7' });
  const devices = await resolveAnalyticsDevices(req);
  const deviceIds = devices.map((device) => device.id);
  const [latestByDeviceId, readings, labels] = await Promise.all([
    batchLatestReadingsByDeviceId(deviceIds),
    loadReadingsForDevices({ deviceIds, range, limit: req.query.limit || 20000 }),
    buildDeviceLabelMaps(devices),
  ]);
  return {
    metric: getMetricConfig(metricKey),
    range: { start: toIso(range.start), end: toIso(range.end), label: range.label },
    items: buildComparisonRows({
      devices,
      latestByDeviceId,
      readings,
      metricKey,
      facilitiesById: labels.facilitiesById,
      toiletsById: labels.toiletsById,
    }),
  };
};

const getImageLinkedSensorEvidence = async (req) => {
  const range = resolveDateRange(req.query, { maxDays: 180, defaultRange: req.query.range || 'last7' });
  let where = scopedWhere(req, { sensor_snapshot: { [Op.ne]: null } }, 'sensor');
  where = applyDateRangeToWhere(where, 'captured_at', range);
  if (req.query.toiletUnitId || req.query.toiletId) {
    const toiletUnitId = req.query.toiletUnitId || req.query.toiletId;
    await resolveToiletInScope(req, toiletUnitId);
    where.toilet_unit_id = toiletUnitId;
  }
  let inspections = await Inspection.findAll({
    where,
    attributes: ['id', 'tenant_id', 'facility_id', 'toilet_unit_id', 'captured_at', 'submitted_at', 'sensor_snapshot'],
    order: [['captured_at', 'DESC']],
    limit: Math.min(Number(req.query.limit || 25), 100),
    raw: true,
  });
  inspections = await filterRowsWithVisibleToilets(inspections);
  const inspectionIds = inspections.map((row) => row.id);
  const images = inspectionIds.length
    ? await InspectionMedia.findAll({
        where: { inspection_id: { [Op.in]: inspectionIds } },
        attributes: ['id', 'inspection_id', 'capture_stage', 'file_url', 'thumbnail_url', 'captured_at', 'overall_score', 'severity'],
        order: [['captured_at', 'DESC NULLS LAST']],
        raw: true,
      })
    : [];
  const imagesByInspection = new Map();
  for (const image of images) {
    const list = imagesByInspection.get(String(image.inspection_id)) || [];
    list.push({
      id: image.id,
      imageUrl: image.file_url,
      thumbnailUrl: image.thumbnail_url || image.file_url,
      captureStage: image.capture_stage,
      capturedAt: image.captured_at,
      score: image.overall_score == null ? null : Number(image.overall_score),
      severity: image.severity || null,
    });
    imagesByInspection.set(String(image.inspection_id), list);
  }

  return {
    range: { start: toIso(range.start), end: toIso(range.end), label: range.label },
    items: inspections.map((inspection) => {
      const snapshot = inspection.sensor_snapshot || {};
      const mediaRows = imagesByInspection.get(String(inspection.id)) || [];
      const metrics = toSensorMetrics(snapshot);
      const threshold = evaluateSensorMetrics(metrics);
      return {
        inspectionId: inspection.id,
        tenantId: inspection.tenant_id,
        facilityId: inspection.facility_id,
        toiletUnitId: inspection.toilet_unit_id,
        capturedAt: resolveInspectionSensorDisplayTime({ inspection, mediaRows }),
        status: statusLower(threshold.overallStatus),
        // Read-only provenance so the UI can mark synthetic historical backfill
        // rows distinctly from live BLE telemetry. Sourced from inspections.sensor_snapshot;
        // never from sensor_readings/sensor_devices.
        isSynthetic: snapshot.isSynthetic === true,
        isBackfilled: snapshot.isBackfilled === true,
        sensorDataSource: snapshot.sensorDataSource || null,
        backfillBatchId: snapshot.backfillBatchId || null,
        metrics: Object.keys(ANALYTICS_METRICS)
          .map((metricKey) => {
            const value = metricValue(metrics, metricKey);
            if (value === null) return null;
            return {
              key: metricKey,
              label: ANALYTICS_METRICS[metricKey].label,
              unit: ANALYTICS_METRICS[metricKey].unit,
              value: roundMetric(value, metricKey),
              status: statusLower(threshold.metrics?.[metricKey]?.status),
            };
          })
          .filter(Boolean),
        images: mediaRows,
      };
    }),
  };
};

const buildRecommendations = ({ latestStatuses, breachSeries }) => {
  const recommendations = [];
  const stale = latestStatuses.filter((row) => row.status === 'stale');
  const critical = latestStatuses.filter((row) => row.status === 'critical');
  const warning = latestStatuses.filter((row) => row.status === 'warning');
  const recentCriticalBreaches = breachSeries.reduce((sum, row) => sum + Number(row.critical || 0), 0);

  if (critical.length > 0 || recentCriticalBreaches >= 3) {
    recommendations.push({
      severity: 'critical',
      message: 'Critical sensor readings are recurring. Prioritize cleaning and review linked inspection evidence.',
    });
  }
  if (warning.length > 0 && critical.length === 0) {
    recommendations.push({
      severity: 'warning',
      message: 'Some readings are outside configured thresholds. Check ventilation and cleaning schedule for this toilet.',
    });
  }
  if (stale.length > 0) {
    recommendations.push({
      severity: 'warning',
      message: 'Sensor readings are stale. Check device connectivity before relying on current readings.',
    });
  }
  if (recommendations.length === 0 && latestStatuses.length > 0) {
    recommendations.push({
      severity: 'normal',
      message: 'Sensor readings are within configured thresholds for the selected period.',
    });
  }
  return recommendations;
};

const getToiletSensorAnalysis = async (req) => {
  const metricKey = normalizeMetricKey(req.query.metric);
  const granularity = normalizeGranularity(req.query.granularity || 'hourly');
  const range = resolveDateRange(req.query, { maxDays: 180, defaultRange: req.query.range || 'last7' });
  const { toilet, devices } = await resolveToiletDevices(req);
  const deviceIds = devices.map((device) => device.id);
  const [latestByDeviceId, readings, labels] = await Promise.all([
    batchLatestReadingsByDeviceId(deviceIds),
    loadReadingsForDevices({ deviceIds, range, limit: req.query.limit || 10000 }),
    buildDeviceLabelMaps(devices),
  ]);
  const devicesById = new Map(devices.map((device) => [String(device.id), device]));
  const latestStatuses = devices.map((device) =>
    mapOperationalDeviceStatus({
      device,
      latestReading: latestByDeviceId.get(String(device.id)) || null,
      previousReading: null,
      facilitiesById: labels.facilitiesById,
      toiletsById: labels.toiletsById,
    })
  );
  const timeSeries = aggregateTimeSeries({ readings, devicesById, metricKey, granularity });
  const breachSeries = buildBreachSeries({ readings, devicesById, granularity: 'daily' });
  const evidence = await getImageLinkedSensorEvidence({
    ...req,
    query: { ...req.query, toiletUnitId: toilet.id, limit: req.query.evidenceLimit || 12 },
  });
  return {
    toiletUnitId: toilet.id,
    metric: getMetricConfig(metricKey),
    range: { start: toIso(range.start), end: toIso(range.end), label: range.label },
    summary: {
      deviceCount: devices.length,
      activeDeviceCount: devices.filter((device) => device.status === 'active').length,
      readingCount: readings.length,
      status: latestStatuses.reduce((current, row) => worseStatus(current, row.status), 'normal'),
      breachCount: breachSeries.reduce((sum, row) => sum + Number(row.warning || 0) + Number(row.critical || 0), 0),
    },
    latest: latestStatuses,
    timeSeries,
    breachSeries,
    evidence: evidence.items || [],
    recommendations: buildRecommendations({ latestStatuses, breachSeries }),
  };
};

// Metrics that can be charted from an inspection sensor_snapshot. All values
// are read-only and derived from inspections.sensor_snapshot — never from
// sensor_readings/sensor_devices.
const SNAPSHOT_METRICS = Object.freeze({
  temperature: ANALYTICS_METRICS.temperature,
  humidity: ANALYTICS_METRICS.humidity,
  ppm: ANALYTICS_METRICS.ppm,
});

const normalizeSnapshotMetricKey = (value) => {
  const key = String(value || '').trim().toLowerCase();
  return SNAPSHOT_METRICS[key] ? key : 'temperature';
};

/*
 * Read-only dashboard trend series sourced ONLY from inspections.sensor_snapshot.
 * This is intentionally SEPARATE from live sensor_readings analytics: it never
 * reads/writes sensor_readings or sensor_devices, and must not feed live
 * online/offline counts, device last-seen, device health, or alerts. Backfilled
 * synthetic rows are surfaced with explicit provenance so the UI can mark them.
 */
const getInspectionSnapshotTrends = async (req) => {
  const metricKey = normalizeSnapshotMetricKey(req.query.metric);
  const metricConfig = SNAPSHOT_METRICS[metricKey];
  const range = resolveDateRange(req.query, { maxDays: 366, defaultRange: req.query.range || 'last90' });

  let where = scopedWhere(req, { sensor_snapshot: { [Op.ne]: null } }, 'sensor');
  where = applyDateRangeToWhere(where, 'captured_at', range);
  if (req.query.toiletUnitId || req.query.toiletId) {
    const toiletUnitId = req.query.toiletUnitId || req.query.toiletId;
    await resolveToiletInScope(req, toiletUnitId);
    where.toilet_unit_id = toiletUnitId;
  }
  if (req.query.facilityId && isUuid(req.query.facilityId)) {
    where.facility_id = req.query.facilityId;
  }

  // Internal provenance filter for maintenance calls.
  const sourceFilter = String(req.query.snapshotSource || 'all').trim().toLowerCase();

  // Cap the scan, then aggregate into one point PER DAY so the chart payload and
  // render stay light (≈ number of days, not number of inspections). The badge
  // counts come from the aggregated totals, so they stay accurate.
  const limit = Math.min(Number(req.query.limit || 2000), 5000);
  let inspections = await Inspection.findAll({
    where,
    attributes: ['id', 'toilet_unit_id', 'captured_at', 'submitted_at', 'sensor_snapshot'],
    order: [['captured_at', 'ASC']],
    limit,
    raw: true,
  });
  inspections = await filterRowsWithVisibleToilets(inspections);
  const inspectionIds = inspections.map((inspection) => inspection.id).filter(Boolean);
  const mediaRows = inspectionIds.length
    ? await InspectionMedia.findAll({
        where: { inspection_id: { [Op.in]: inspectionIds } },
        attributes: ['inspection_id', 'captured_at'],
        order: [['captured_at', 'ASC NULLS LAST']],
        raw: true,
      })
    : [];
  const mediaByInspection = new Map();
  for (const row of mediaRows) {
    const key = String(row.inspection_id);
    const list = mediaByInspection.get(key) || [];
    list.push(row);
    mediaByInspection.set(key, list);
  }

  const buckets = new Map(); // dayKey -> { sum, count, min, max, synthetic, displayTimestamp }
  let totalCount = 0;
  let syntheticTotal = 0;
  for (const inspection of inspections) {
    const snapshot = inspection.sensor_snapshot || {};
    const isSynthetic = snapshot.isSynthetic === true || snapshot.isBackfilled === true;
    if (sourceFilter === 'synthetic' && !isSynthetic) continue;
    if (sourceFilter === 'real' && isSynthetic) continue;

    const metrics = toSensorMetrics(snapshot);
    const rawValue = metrics[metricKey];
    if (rawValue === null || rawValue === undefined || !Number.isFinite(Number(rawValue))) continue;

    const value = Number(rawValue);
    const day = toIstDateKey(inspection.captured_at);
    if (!day) continue;
    const displayTimestamp = resolveInspectionSensorDisplayTime({
      inspection,
      mediaRows: mediaByInspection.get(String(inspection.id)) || [],
    });
    let bucket = buckets.get(day);
    if (!bucket) {
      bucket = { sum: 0, count: 0, min: value, max: value, synthetic: 0, displayTimestamp };
      buckets.set(day, bucket);
    }
    if (!bucket.displayTimestamp || isUtcMidnight(asDateOrNull(bucket.displayTimestamp))) {
      bucket.displayTimestamp = displayTimestamp;
    }
    bucket.sum += value;
    bucket.count += 1;
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);
    if (isSynthetic) bucket.synthetic += 1;
    totalCount += 1;
    if (isSynthetic) syntheticTotal += 1;
  }

  const round = (n) => Number(Number(n).toFixed(metricConfig.precision));
  const points = [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, bucket]) => ({
      timestamp: bucket.displayTimestamp || `${day}T00:00:00.000Z`,
      bucketTimestamp: `${day}T00:00:00.000Z`,
      displayTimestamp: bucket.displayTimestamp || null,
      day,
      avg: round(bucket.sum / bucket.count),
      min: round(bucket.min),
      max: round(bucket.max),
      count: bucket.count,
      syntheticCount: bucket.synthetic,
      isSynthetic: bucket.synthetic > 0,
    }));

  return {
    metric: metricConfig,
    granularity: 'daily',
    range: { start: toIso(range.start), end: toIso(range.end), label: range.label },
    count: totalCount,
    syntheticCount: syntheticTotal,
    realCount: totalCount - syntheticTotal,
    availableMetrics: Object.values(SNAPSHOT_METRICS).map((m) => ({ key: m.key, label: m.label, unit: m.unit })),
    points,
  };
};

module.exports = {
  ingestSensorReading,
  registerSensor,
  attachSensor,
  replaceSensor,
  detachSensor,
  getToiletLatestReading,
  getToiletReadingHistory,
  getToiletReadingSummary,
  listSensors,
  listSensorReadings,
  getFacilityLiveMetrics,
  getLiveAlerts,
  getSensorAnalyticsOverview,
  getSensorTimeSeries,
  getSensorComparison,
  getImageLinkedSensorEvidence,
  getInspectionSnapshotTrends,
  getToiletSensorAnalysis,
  checkSensorOfflineAlerts,
};
