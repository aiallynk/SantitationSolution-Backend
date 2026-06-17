const { Op, fn, col } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  SensorDevice,
  SensorReading,
  Alert,
  Facility,
  ToiletUnit,
} = require('../../models');
const { normalizePagination, sanitizeText, isUuid } = require('../../utils/validators');
const { resolveDateRange, applyDateRangeToWhere } = require('../../utils/dateRange');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { createAuditLog } = require('../audit/audit.service');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');
const { runtimeConfig } = require('../../config/runtime');
const { parseSensorPayload } = require('./sensorPayload.parser');

const DEFAULT_BLE_DEVICE_TYPE = 'sanitation_wand';

const THRESHOLDS = {
  odor_ppm: runtimeConfig.alerts.odorPpmThreshold,
  ammonia_ppm: runtimeConfig.alerts.ammoniaPpmThreshold,
  h2s_ppm: runtimeConfig.alerts.h2sPpmThreshold,
  methane_ppm: runtimeConfig.alerts.methanePpmThreshold,
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
  clientReadingId: row.client_reading_id || null,
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

const assertDeviceInScope = (req, device) => {
  if (!req.user.isSuperAdmin && device.tenant_id !== req.user.tenantId) {
    throw new AppError('Sensor device out of tenant scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
  if (!isFacilityInScope(req, device.facility_id || null)) {
    throw new AppError('Sensor device out of scope', 403, { code: 'SCOPE_FORBIDDEN' });
  }
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
  assertDeviceInScope(req, device);

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
  const signalStrength = parseNumeric(req.body.rssi) ?? parseNumeric(req.body.signalStrength);

  const timestamp = req.body.timestamp ? new Date(req.body.timestamp) : new Date();

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
        clientReadingId,
      }
    : req.body.rawPayload || req.body;

  let reading;
  try {
    reading = await SensorReading.create({
      device_id: device.id,
      client_reading_id: clientReadingId,
      timestamp,
      odor_ppm: parseNumeric(req.body.odorPpm),
      ammonia_ppm: parseNumeric(req.body.ammoniaPpm),
      h2s_ppm: parseNumeric(req.body.h2sPpm),
      methane_ppm: parseNumeric(req.body.methanePpm),
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
  await createSensorAlertIfNeeded(device, reading);

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
    order: [['last_seen_at', 'DESC']],
    limit,
    offset,
  });

  return {
    items: rows.map(mapDevice),
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
};
