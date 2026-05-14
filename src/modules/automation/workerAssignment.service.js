const { Op, fn, col } = require('sequelize');
const { runtimeConfig } = require('../../config/runtime');
const {
  Facility,
  Geography,
  InspectionTask,
  PlatformUser,
  Role,
  ToiletUnit,
  UserRole,
  WorkerAssignment,
  WorkerHeartbeat,
} = require('../../models');
const { ROLE_CODES } = require('../../core/rbac/personaFamilies');
const {
  ACTIVE_TASK_STATUSES,
  haversineDistanceKm,
  isValidLatitude,
  isValidLongitude,
  toNumberOrNull,
} = require('./automation.constants');

const uniqueIds = (values = []) =>
  [
    ...new Set(
      values
        .map((value) => (value === null || value === undefined ? '' : String(value).trim()))
        .filter(Boolean)
    ),
  ];

const isWorkerMarkedOffline = (worker) => {
  const metadata = worker?.metadata || {};
  const statusTokens = [
    metadata.availabilityStatus,
    metadata.workerStatus,
    metadata.networkStatus,
    metadata.presence,
  ].map((value) => String(value || '').trim().toLowerCase());
  return Boolean(metadata.isOffline || statusTokens.includes('offline'));
};

const getRoleUserIds = async ({ tenantId, roleCode, candidateUserIds = [] }) => {
  const role = await Role.findOne({
    where: { code: roleCode },
    attributes: ['id'],
    raw: true,
  });
  if (!role?.id) return [];

  const where = {
    role_id: role.id,
    tenant_id: tenantId,
  };
  if (candidateUserIds.length > 0) {
    where.user_id = { [Op.in]: candidateUserIds };
  }

  const rows = await UserRole.findAll({
    where,
    attributes: ['user_id'],
    raw: true,
  });
  return uniqueIds(rows.map((row) => row.user_id));
};

const resolveLocationScope = ({ facility = null, toilet = null }) => {
  const facilityId = facility?.id || toilet?.facility_id || null;
  const geographyIds = uniqueIds([
    facility?.geography_id,
    facility?.zone_geography_id,
    facility?.ward_geography_id,
  ]);
  return {
    facilityId,
    toiletUnitId: toilet?.id || null,
    geographyIds,
  };
};

const getCandidateWorkerIds = async ({ tenantId, facility = null, toilet = null }) => {
  const scope = resolveLocationScope({ facility, toilet });
  const assignmentOr = [];
  if (scope.toiletUnitId) assignmentOr.push({ toilet_unit_id: scope.toiletUnitId });
  if (scope.facilityId) assignmentOr.push({ facility_id: scope.facilityId });
  if (scope.geographyIds.length > 0) {
    assignmentOr.push({ geography_id: { [Op.in]: scope.geographyIds } });
  }

  let assignmentUserIds = [];
  if (assignmentOr.length > 0) {
    const assignments = await WorkerAssignment.findAll({
      where: {
        tenant_id: tenantId,
        status: 'active',
        assignment_role: { [Op.in]: ['worker', ROLE_CODES.FIELD_WORKER] },
        [Op.or]: assignmentOr,
      },
      attributes: ['user_id'],
      raw: true,
    });
    assignmentUserIds = uniqueIds(assignments.map((assignment) => assignment.user_id));
  }

  const scopedRoleUserIds = await getRoleUserIds({
    tenantId,
    roleCode: ROLE_CODES.FIELD_WORKER,
    candidateUserIds: assignmentUserIds,
  });
  if (scopedRoleUserIds.length > 0) {
    return scopedRoleUserIds;
  }

  return getRoleUserIds({ tenantId, roleCode: ROLE_CODES.FIELD_WORKER });
};

const getLatestHeartbeatsByWorkerId = async ({ tenantId, workerIds }) => {
  if (workerIds.length === 0) return new Map();

  const rows = await WorkerHeartbeat.findAll({
    where: {
      tenant_id: tenantId,
      worker_id: { [Op.in]: workerIds },
    },
    order: [
      ['worker_id', 'ASC'],
      ['captured_at', 'DESC'],
      ['created_at', 'DESC'],
    ],
  });

  const latest = new Map();
  for (const row of rows) {
    const key = String(row.worker_id);
    if (!latest.has(key)) {
      latest.set(key, row);
    }
  }
  return latest;
};

const getActiveTaskCounts = async ({ tenantId, workerIds }) => {
  if (workerIds.length === 0) return new Map();

  const rows = await InspectionTask.findAll({
    where: {
      tenant_id: tenantId,
      assigned_to_user_id: { [Op.in]: workerIds },
      status: { [Op.in]: ACTIVE_TASK_STATUSES },
    },
    attributes: ['assigned_to_user_id', [fn('COUNT', col('id')), 'task_count']],
    group: ['assigned_to_user_id'],
    raw: true,
  });
  return new Map(
    rows.map((row) => [String(row.assigned_to_user_id), Number(row.task_count || 0)])
  );
};

const getFreshnessMinutes = (capturedAt) => {
  const ts = new Date(capturedAt).getTime();
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.round((Date.now() - ts) / 60000));
};

const buildHeartbeatSnapshot = (heartbeat) => ({
  heartbeatId: heartbeat.id,
  latitude: toNumberOrNull(heartbeat.latitude),
  longitude: toNumberOrNull(heartbeat.longitude),
  accuracy: toNumberOrNull(heartbeat.accuracy),
  capturedAt: heartbeat.captured_at,
  mobileBatteryPercentage: toNumberOrNull(heartbeat.mobile_battery_percentage),
  isCharging: heartbeat.is_charging,
  source: heartbeat.source,
});

const findNearestEligibleWorker = async ({ tenantId, facility, toilet, location }) => {
  const lat = toNumberOrNull(location?.latitude);
  const lng = toNumberOrNull(location?.longitude);
  if (!isValidLatitude(lat) || !isValidLongitude(lng)) {
    return {
      selected: null,
      candidates: [],
      reason: 'Complaint/toilet location is missing or invalid',
    };
  }

  const candidateWorkerIds = await getCandidateWorkerIds({ tenantId, facility, toilet });
  if (candidateWorkerIds.length === 0) {
    return { selected: null, candidates: [], reason: 'No active worker role candidates found' };
  }

  const [workers, latestHeartbeats, activeTaskCounts] = await Promise.all([
    PlatformUser.findAll({
      where: {
        id: { [Op.in]: candidateWorkerIds },
        tenant_id: tenantId,
        status: 'active',
      },
      attributes: ['id', 'tenant_id', 'full_name', 'email', 'employee_code', 'metadata', 'status'],
    }),
    getLatestHeartbeatsByWorkerId({ tenantId, workerIds: candidateWorkerIds }),
    getActiveTaskCounts({ tenantId, workerIds: candidateWorkerIds }),
  ]);

  const freshnessLimit = Number(runtimeConfig.automation.workerLocationFreshnessMinutes || 30);
  const maxActiveTasks = Number(runtimeConfig.automation.maxActiveTasksPerWorker || 3);
  const lowBatteryThreshold = Number(runtimeConfig.automation.lowMobileBatteryThreshold || 20);
  const radiusKm = Number(runtimeConfig.automation.assignmentRadiusKm || 0);

  const candidates = workers
    .map((worker) => {
      const heartbeat = latestHeartbeats.get(String(worker.id));
      const activeTaskCount = activeTaskCounts.get(String(worker.id)) || 0;
      if (!heartbeat) {
        return {
          worker,
          eligible: false,
          reason: 'No worker heartbeat is available',
          activeTaskCount,
        };
      }

      const freshnessMinutes = getFreshnessMinutes(heartbeat.captured_at);
      const heartbeatLat = toNumberOrNull(heartbeat.latitude);
      const heartbeatLng = toNumberOrNull(heartbeat.longitude);
      const distanceKm = haversineDistanceKm(
        { latitude: lat, longitude: lng },
        { latitude: heartbeatLat, longitude: heartbeatLng }
      );
      const battery = toNumberOrNull(heartbeat.mobile_battery_percentage);
      const offline = isWorkerMarkedOffline(worker);
      const reasons = [];
      if (offline) reasons.push('Worker is marked offline');
      if (freshnessMinutes > freshnessLimit) reasons.push('Worker location is stale');
      if (distanceKm === null) reasons.push('Worker location is invalid');
      if (activeTaskCount >= maxActiveTasks) reasons.push('Worker is at max active task load');
      if (radiusKm > 0 && distanceKm !== null && distanceKm > radiusKm) {
        reasons.push('Worker is outside assignment radius');
      }

      return {
        worker,
        heartbeat,
        heartbeatSnapshot: buildHeartbeatSnapshot(heartbeat),
        eligible: reasons.length === 0,
        reason: reasons.join('; ') || null,
        distanceKm,
        activeTaskCount,
        freshnessMinutes,
        battery,
        lowBattery: battery !== null && battery < lowBatteryThreshold && heartbeat.is_charging !== true,
      };
    })
    .filter(Boolean);

  const eligible = candidates.filter((candidate) => candidate.eligible);
  if (eligible.length === 0) {
    return {
      selected: null,
      candidates,
      reason: candidates.map((candidate) => candidate.reason).filter(Boolean)[0] || 'No eligible worker found',
    };
  }

  const preferred = eligible.filter((candidate) => !candidate.lowBattery);
  const sortable = preferred.length > 0 ? preferred : eligible;
  sortable.sort((left, right) => {
    const distanceDiff = Number(left.distanceKm ?? Number.MAX_SAFE_INTEGER) - Number(right.distanceKm ?? Number.MAX_SAFE_INTEGER);
    if (distanceDiff !== 0) return distanceDiff;
    const loadDiff = Number(left.activeTaskCount || 0) - Number(right.activeTaskCount || 0);
    if (loadDiff !== 0) return loadDiff;
    const freshnessDiff = Number(left.freshnessMinutes || 0) - Number(right.freshnessMinutes || 0);
    if (freshnessDiff !== 0) return freshnessDiff;
    return Number(right.battery ?? 101) - Number(left.battery ?? 101);
  });

  const selected = sortable[0];
  return {
    selected,
    candidates,
    reason: selected.lowBattery
      ? 'Only low-battery workers were available'
      : 'Nearest eligible worker selected',
  };
};

const resolveSupervisorIds = async ({ tenantId, facility = null, toilet = null, workerId = null }) => {
  const scope = resolveLocationScope({ facility, toilet });
  const supervisorIds = new Set();
  if (facility?.supervisor_user_id) {
    supervisorIds.add(String(facility.supervisor_user_id));
  }

  const assignmentOr = [];
  if (workerId) assignmentOr.push({ user_id: workerId });
  if (scope.toiletUnitId) assignmentOr.push({ toilet_unit_id: scope.toiletUnitId });
  if (scope.facilityId) assignmentOr.push({ facility_id: scope.facilityId });
  if (scope.geographyIds.length > 0) {
    assignmentOr.push({ geography_id: { [Op.in]: scope.geographyIds } });
  }

  if (assignmentOr.length > 0) {
    const rows = await WorkerAssignment.findAll({
      where: {
        tenant_id: tenantId,
        status: 'active',
        [Op.or]: assignmentOr,
      },
      attributes: ['supervisor_user_id'],
      raw: true,
    });
    rows.forEach((row) => {
      if (row.supervisor_user_id) supervisorIds.add(String(row.supervisor_user_id));
    });
  }

  if (supervisorIds.size > 0) return [...supervisorIds];

  return getRoleUserIds({ tenantId, roleCode: ROLE_CODES.SUPERVISOR });
};

const loadToiletWithFacility = async (toiletUnitId) => {
  if (!toiletUnitId) return null;
  return ToiletUnit.findByPk(toiletUnitId, {
    include: [
      {
        model: Facility,
        attributes: [
          'id',
          'tenant_id',
          'geography_id',
          'zone_geography_id',
          'ward_geography_id',
          'supervisor_user_id',
          'name',
          'code',
          'address_line',
          'latitude',
          'longitude',
        ],
        required: false,
        include: [{ model: Geography, attributes: ['id', 'name', 'code', 'level'], required: false }],
      },
    ],
  });
};

module.exports = {
  findNearestEligibleWorker,
  getActiveTaskCounts,
  getLatestHeartbeatsByWorkerId,
  loadToiletWithFacility,
  resolveSupervisorIds,
};
