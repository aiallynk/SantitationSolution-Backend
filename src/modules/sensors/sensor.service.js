const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  SensorDevice,
  SensorReading,
  Alert,
  Facility,
} = require('../../models');
const { normalizePagination } = require('../../utils/validators');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { createAuditLog } = require('../audit/audit.service');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');

const THRESHOLDS = {
  odor_ppm: Number(process.env.ALERT_ODOR_PPM_THRESHOLD || 70),
  ammonia_ppm: Number(process.env.ALERT_AMMONIA_PPM_THRESHOLD || 35),
  h2s_ppm: Number(process.env.ALERT_H2S_PPM_THRESHOLD || 10),
  methane_ppm: Number(process.env.ALERT_METHANE_PPM_THRESHOLD || 90),
};

const parseNumeric = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const scopedWhere = (req, where = {}, domainType = 'sensor') =>
  applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), domainType, {
    tenantKey: 'tenant_id',
    facilityKey: 'facility_id',
  });

const mapReading = (row) => ({
  id: row.id,
  deviceId: row.device_id,
  timestamp: row.timestamp,
  odorPpm: row.odor_ppm,
  ammoniaPpm: row.ammonia_ppm,
  h2sPpm: row.h2s_ppm,
  methanePpm: row.methane_ppm,
  humidity: row.humidity,
  temperature: row.temperature,
  occupancyCount: row.occupancy_count,
  footfallCount: row.footfall_count,
  tankFillLevel: row.tank_fill_level,
  batteryLevel: row.battery_level,
  signalStrength: row.signal_strength,
  rawPayload: row.raw_payload,
});

const shouldAlert = (reading) => {
  if (reading.odor_ppm != null && Number(reading.odor_ppm) > THRESHOLDS.odor_ppm) return true;
  if (reading.ammonia_ppm != null && Number(reading.ammonia_ppm) > THRESHOLDS.ammonia_ppm) return true;
  if (reading.h2s_ppm != null && Number(reading.h2s_ppm) > THRESHOLDS.h2s_ppm) return true;
  if (reading.methane_ppm != null && Number(reading.methane_ppm) > THRESHOLDS.methane_ppm) return true;
  return false;
};

const createSensorAlertIfNeeded = async (device, reading) => {
  if (!shouldAlert(reading)) {
    return null;
  }

  const open = await Alert.findOne({
    where: {
      source_type: 'sensor',
      source_id: device.id,
      status: {
        [Op.in]: ['open', 'acknowledged'],
      },
    },
  });
  if (open) return open;

  const alert = await Alert.create({
    tenant_id: device.tenant_id,
    alert_type: 'sensor_threshold_breach',
    severity: 'high',
    source_type: 'sensor',
    source_id: device.id,
    facility_id: device.facility_id,
    message: `Sensor ${device.device_id} exceeded threshold values`,
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

const ingestSensorReading = async (req) => {
  const device = await SensorDevice.findOne({
    where: {
      [Op.or]: [{ id: req.body.deviceId }, { device_id: req.body.deviceId }],
    },
  });
  if (!device) {
    throw new AppError('Sensor device not found', 404, { code: 'SENSOR_NOT_FOUND' });
  }
  if (!req.user.isSuperAdmin && device.tenant_id !== req.user.tenantId) {
    throw new AppError('Sensor device out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, device.facility_id || null)) {
    throw new AppError('Sensor device out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }

  const timestamp = req.body.timestamp ? new Date(req.body.timestamp) : new Date();
  const reading = await SensorReading.create({
    device_id: device.id,
    timestamp,
    odor_ppm: parseNumeric(req.body.odorPpm),
    ammonia_ppm: parseNumeric(req.body.ammoniaPpm),
    h2s_ppm: parseNumeric(req.body.h2sPpm),
    methane_ppm: parseNumeric(req.body.methanePpm),
    humidity: parseNumeric(req.body.humidity),
    temperature: parseNumeric(req.body.temperature),
    occupancy_count: parseNumeric(req.body.occupancyCount),
    footfall_count: parseNumeric(req.body.footfallCount),
    tank_fill_level: parseNumeric(req.body.tankFillLevel),
    battery_level: parseNumeric(req.body.batteryLevel),
    signal_strength: parseNumeric(req.body.signalStrength),
    raw_payload: req.body.rawPayload || req.body,
  });

  await device.update({ last_seen_at: timestamp, updated_at: new Date() });
  await createSensorAlertIfNeeded(device, reading);

  eventBus.emit(EVENTS.SENSOR_READING, {
    tenantId: device.tenant_id,
    facilityId: device.facility_id,
    deviceId: device.id,
    reading: mapReading(reading),
  });

  await createAuditLog({
    req,
    tenantId: device.tenant_id,
    action: 'sensor.ingest',
    entityType: 'sensor_device',
    entityId: device.id,
  });

  return {
    deviceId: device.id,
    reading: mapReading(reading),
  };
};

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

  const { rows, count } = await SensorDevice.findAndCountAll({
    where,
    order: [['last_seen_at', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      facilityId: row.facility_id,
      toiletBlockId: row.toilet_block_id,
      toiletUnitId: row.toilet_unit_id,
      deviceId: row.device_id,
      serialNo: row.serial_no,
      deviceType: row.device_type,
      status: row.status,
      firmwareVersion: row.firmware_version,
      lastSeenAt: row.last_seen_at,
    })),
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
  if (!isFacilityInScope(req, device.facility_id || null)) {
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
  const odorAvg =
    latestReadings.length === 0
      ? 0
      : latestReadings.reduce((sum, row) => sum + Number(row.odorPpm || 0), 0) /
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
      averageOdorPpm: Number(odorAvg.toFixed(2)),
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

module.exports = {
  ingestSensorReading,
  listSensors,
  listSensorReadings,
  getFacilityLiveMetrics,
  getLiveAlerts,
};
