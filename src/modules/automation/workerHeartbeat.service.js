const AppError = require('../../core/errors/AppError');
const { eventBus, EVENTS } = require('../../core/live/eventBus');
const { logger } = require('../../core/logging/logger');
const { PlatformUser, WorkerHeartbeat } = require('../../models');
const { sanitizeText } = require('../../utils/validators');
const {
  isValidLatitude,
  isValidLongitude,
  toNumberOrNull,
} = require('./automation.constants');

const clampBattery = (value) => {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return null;
  if (parsed < 0 || parsed > 100) {
    throw new AppError('batteryPercentage must be between 0 and 100', 400, {
      code: 'INVALID_BATTERY_PERCENTAGE',
    });
  }
  return parsed;
};

const optionalNumber = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseCapturedAt = (value) => {
  if (!value) return new Date();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const resolveBatteryInput = (body = {}) =>
  clampBattery(
    body.mobileBatteryPercentage ??
      body.mobile_battery_percentage ??
      body.batteryPercentage ??
      body.battery_percentage
  );

const createWorkerHeartbeat = async (req) => {
  const latitude = toNumberOrNull(req.body?.latitude);
  const longitude = toNumberOrNull(req.body?.longitude);
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) {
    throw new AppError('Valid latitude and longitude are required', 400, {
      code: 'INVALID_LOCATION',
    });
  }

  const tenantId = req.user?.tenantId || req.user?.activeTenantId || null;
  if (!tenantId) {
    throw new AppError('Tenant context is required', 403, {
      code: 'TENANT_CONTEXT_REQUIRED',
    });
  }

  const workerId = req.user.id;
  const capturedAt = parseCapturedAt(req.body?.capturedAt ?? req.body?.captured_at);
  const mobileBatteryPercentage = resolveBatteryInput(req.body);
  const now = new Date();
  const metadata = {
    permissionStatus: sanitizeText(req.body?.permissionStatus || req.body?.permission_status, 40) || null,
    networkStatus: sanitizeText(req.body?.networkStatus || req.body?.network_status, 40) || null,
    appState: sanitizeText(req.body?.appState || req.body?.app_state, 40) || null,
  };

  const heartbeat = await WorkerHeartbeat.create({
    tenant_id: tenantId,
    worker_id: workerId,
    latitude,
    longitude,
    accuracy: optionalNumber(req.body?.accuracy),
    speed: optionalNumber(req.body?.speed),
    heading: optionalNumber(req.body?.heading),
    mobile_battery_percentage: mobileBatteryPercentage,
    is_charging:
      req.body?.isCharging === undefined && req.body?.is_charging === undefined
        ? null
        : Boolean(req.body?.isCharging ?? req.body?.is_charging),
    source: sanitizeText(req.body?.source || 'mobile_app', 40) || 'mobile_app',
    captured_at: capturedAt,
    metadata,
    created_at: now,
    updated_at: now,
  });

  try {
    const user = await PlatformUser.findByPk(workerId, {
      attributes: ['id', 'metadata'],
    });
    if (user) {
      await user.update({
        metadata: {
          ...(user.metadata || {}),
          phoneBatteryPct: mobileBatteryPercentage,
          mobileBatteryPct: mobileBatteryPercentage,
          batteryUpdatedAt: now.toISOString(),
          isCharging: heartbeat.is_charging,
          gpsPermissionStatus: metadata.permissionStatus,
          networkStatus: metadata.networkStatus,
          latestLocation: {
            latitude,
            longitude,
            accuracy: heartbeat.accuracy,
            capturedAt: capturedAt.toISOString(),
            source: heartbeat.source,
          },
        },
        updated_at: now,
      });
    }
  } catch (error) {
    logger.warn('Worker metadata heartbeat mirror failed', {
      workerId,
      error: error.message,
    });
  }

  eventBus.emit(EVENTS.WORKER_HEARTBEAT, {
    tenantId,
    workerId,
    latitude,
    longitude,
    capturedAt: capturedAt.toISOString(),
    mobileBatteryPercentage,
  });

  return {
    id: heartbeat.id,
    workerId,
    latitude,
    longitude,
    accuracy: heartbeat.accuracy,
    mobileBatteryPercentage,
    isCharging: heartbeat.is_charging,
    capturedAt: heartbeat.captured_at,
  };
};

module.exports = {
  createWorkerHeartbeat,
};
