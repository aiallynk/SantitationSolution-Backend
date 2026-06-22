const { Op } = require('sequelize');
const {
  AiAnalysisResult,
  Alert,
  Complaint,
  Facility,
  Geography,
  Inspection,
  InspectionMedia,
  InspectionTask,
  NotificationDeviceToken,
  PlatformUser,
  Role,
  SensorDevice,
  SensorReading,
  TaskAssignmentLog,
  ToiletUnit,
  UserRole,
  WorkerAssignment,
  WorkerHeartbeat,
} = require('../../models');
const AppError = require('../../core/errors/AppError');
const { runtimeConfig } = require('../../config/runtime');
const { normalizePagination } = require('../../utils/validators');
const { resolveDateRange } = require('../../utils/dateRange');
const { createAuditLog } = require('../audit/audit.service');
const { resolveMediaUrl } = require('../media/mediaUrl.service');
const {
  ACTIVE_TASK_STATUSES,
  CRITICAL_COMPLAINT_TASK_TYPE,
  getCriticalComplaintValueSet,
  normalizeToken,
  toNumberOrNull,
} = require('../automation/automation.constants');

const ROLE_CODES = {
  AUDITOR: 'auditor',
  FIELD_WORKER: 'field_worker',
  SUPERVISOR: 'supervisor',
};

const LOW_BATTERY_PERCENT = 20;
const OFFLINE_THRESHOLD_MINUTES = 120;
const IDLE_THRESHOLD_MINUTES = 45;
const LATE_CHECKIN_HOUR = 10;
const ASSIGNED_LOCATION_RADIUS_METERS = 250;

const uniqueIds = (values = []) =>
  [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => (value === null || value === undefined ? '' : String(value).trim()))
        .filter(Boolean)
    ),
  ];

const hasRoleCode = (req, roleCode) =>
  (Array.isArray(req?.user?.roleCodes) ? req.user.roleCodes : [])
    .map((code) => String(code || '').trim().toLowerCase())
    .includes(String(roleCode || '').trim().toLowerCase());

const isAuditorActor = (req) =>
  hasRoleCode(req, ROLE_CODES.AUDITOR) || String(req?.user?.roleType || '').trim().toLowerCase() === ROLE_CODES.AUDITOR;

const toNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toIsoOrNull = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const toTimestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const startOfToday = () => {
  const value = new Date();
  value.setHours(0, 0, 0, 0);
  return value;
};

const endOfToday = () => {
  const value = new Date();
  value.setHours(23, 59, 59, 999);
  return value;
};

const minutesBetween = (start, end) => {
  const left = toTimestamp(start);
  const right = toTimestamp(end);
  if (left === null || right === null || right < left) return 0;
  return Math.round((right - left) / 60000);
};

const isToday = (value) => {
  const ts = toTimestamp(value);
  if (ts === null) return false;
  return ts >= startOfToday().getTime() && ts <= endOfToday().getTime();
};

const pickEarlierIso = (left, right) => {
  if (!left) return right || null;
  if (!right) return left || null;
  return toTimestamp(right) < toTimestamp(left) ? right : left;
};

const pickLaterIso = (left, right) => {
  if (!left) return right || null;
  if (!right) return left || null;
  return toTimestamp(right) > toTimestamp(left) ? right : left;
};

const readNumberFromMetadata = (metadata, keys = []) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  for (const key of keys) {
    const value = toNumber(metadata[key], null);
    if (value !== null) return value;
  }
  return null;
};

const readStringFromMetadata = (metadata, keys = []) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  for (const key of keys) {
    const value = String(metadata[key] || '').trim();
    if (value) return value;
  }
  return null;
};

const readDateFromMetadata = (metadata, keys = []) => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  for (const key of keys) {
    const iso = toIsoOrNull(metadata[key]);
    if (iso) return iso;
  }
  return null;
};

const haversineMeters = (left, right) => {
  const lat1 = toNumber(left?.lat, null);
  const lng1 = toNumber(left?.lng, null);
  const lat2 = toNumber(right?.lat, null);
  const lng2 = toNumber(right?.lng, null);
  if ([lat1, lng1, lat2, lng2].some((value) => value === null)) return null;
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const resolveDateWindow = (query = {}, { defaultDays = 1, maxDays = 90 } = {}) => {
  if (query.date) {
    const range = resolveDateRange({ from: query.date, to: query.date }, { maxDays });
    return {
      ...range,
      range: 'date',
      label: String(query.date).slice(0, 10),
      days: 1,
    };
  }
  return resolveDateRange(query, { defaultDays, maxDays });
};

const tenantWhere = (req, extra = {}, tenantKey = 'tenant_id') => {
  const requestedTenantId = req.user?.isSuperAdmin ? req.query?.tenantId : null;
  const tenantId = requestedTenantId || req.user?.tenantId || null;
  if (!tenantId) return { ...extra, [tenantKey]: '__missing_tenant__' };
  return { ...extra, [tenantKey]: tenantId };
};

const withDateField = (where, field, range) => {
  if (!range?.start && !range?.end) return where;
  return {
    ...where,
    [field]: {
      ...(range.start ? { [Op.gte]: range.start } : {}),
      ...(range.end ? { [Op.lte]: range.end } : {}),
    },
  };
};

const excludeDeletedToiletsFromWhere = (where = {}, deletedToiletIds = []) => {
  if (!deletedToiletIds.length) return where;
  const existingAnd = Array.isArray(where[Op.and]) ? where[Op.and] : [];
  return {
    ...where,
    [Op.and]: [
      ...existingAnd,
      {
        [Op.or]: [
          { toilet_unit_id: { [Op.is]: null } },
          { toilet_unit_id: { [Op.notIn]: deletedToiletIds } },
        ],
      },
    ],
  };
};

const loadDeletedToiletIdsForSupervisorScope = async (req, scope = {}) => {
  const facilityIds = uniqueIds(scope.facilityIds || []);
  const where = { deleted_at: { [Op.not]: null } };
  if (facilityIds.length > 0) where.facility_id = { [Op.in]: facilityIds };

  const rows = await ToiletUnit.findAll({
    where,
    attributes: ['id'],
    include:
      facilityIds.length > 0
        ? []
        : [
            {
              model: Facility,
              attributes: [],
              required: true,
              where: tenantWhere(req),
            },
          ],
    raw: true,
  });
  return uniqueIds(rows.map((row) => row.id));
};

const normalizePlain = (row) =>
  row && typeof row.get === 'function' ? row.get({ plain: true }) : row;

const paginateArray = (items, query, defaults = { page: 1, limit: 25, maxLimit: 100 }) => {
  const { page, limit, offset } = normalizePagination(query || {}, defaults);
  const total = items.length;
  return {
    items: items.slice(offset, offset + limit),
    meta: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  };
};

const includesFilter = (value, query) => {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return String(value || '').toLowerCase().includes(needle);
};

const getWorkerRoleIds = async () => {
  const row = await Role.findOne({
    where: { code: ROLE_CODES.FIELD_WORKER },
    attributes: ['id'],
    raw: true,
  });
  return row?.id ? [row.id] : [];
};

const resolveSupervisorScope = async (req) => {
  const tenantId = req.user?.isSuperAdmin ? req.query?.tenantId : req.user?.tenantId;
  if (!tenantId) {
    return {
      tenantId: null,
      workerIds: [],
      facilityIds: [],
      geographyIds: [],
      assignments: [],
      directFacilities: [],
    };
  }

  const userFacilityIds = uniqueIds(req.user?.scopeFacilityIds || []);
  const userGeographyIds = uniqueIds(req.user?.scopeGeographyIds || []);
  const auditorActor = isAuditorActor(req);

  const directFacilities = await Facility.findAll({
    where: tenantWhere(req, { supervisor_user_id: req.user.id }),
    attributes: ['id', 'tenant_id', 'geography_id', 'zone_geography_id', 'ward_geography_id', 'name', 'code', 'address_line', 'latitude', 'longitude'],
    raw: true,
  });

  const facilityIds = uniqueIds([
    ...userFacilityIds,
    ...directFacilities.map((facility) => facility.id),
  ]);
  const geographyIds = uniqueIds([
    ...userGeographyIds,
    ...directFacilities.flatMap((facility) => [
      facility.geography_id,
      facility.zone_geography_id,
      facility.ward_geography_id,
    ]),
  ]);

  const assignmentOr = [];
  if (!req.user?.isSuperAdmin && !auditorActor) {
    assignmentOr.push({ supervisor_user_id: req.user.id });
  }
  if (facilityIds.length > 0) {
    assignmentOr.push({ facility_id: { [Op.in]: facilityIds } });
  }
  if (geographyIds.length > 0) {
    assignmentOr.push({ geography_id: { [Op.in]: geographyIds } });
  }

  const assignmentWhere = tenantWhere(req, { status: 'active' });
  if (assignmentOr.length > 0) {
    assignmentWhere[Op.or] = assignmentOr;
  }

  const assignments = await WorkerAssignment.findAll({
    where: assignmentWhere,
    include: [
      { model: Facility, as: 'facility', attributes: ['id', 'name', 'code', 'address_line', 'latitude', 'longitude', 'geography_id', 'zone_geography_id', 'ward_geography_id'], required: false },
      { model: Geography, as: 'geography', attributes: ['id', 'name', 'code', 'level'], required: false },
      { model: ToiletUnit, as: 'toiletUnit', attributes: ['id', 'code', 'location_label', 'facility_id', 'latitude', 'longitude'], required: false },
      { model: PlatformUser, as: 'supervisor', attributes: ['id', 'full_name', 'employee_code'], required: false },
    ],
  });

  const plainAssignments = assignments.map(normalizePlain);
  const assignmentToiletFacilityIds = uniqueIds(
    plainAssignments.map((assignment) => assignment?.toiletUnit?.facility_id)
  );
  const scopedFacilityIds = uniqueIds([
    ...facilityIds,
    ...plainAssignments.map((assignment) => assignment.facility_id),
    ...plainAssignments.map((assignment) => assignment?.facility?.id),
    ...assignmentToiletFacilityIds,
  ]);

  const taskWorkerRows =
    scopedFacilityIds.length > 0
      ? await InspectionTask.findAll({
          where: tenantWhere(req, { facility_id: { [Op.in]: scopedFacilityIds } }),
          attributes: ['assigned_to_user_id'],
          raw: true,
          limit: 1000,
        })
      : [];

  const candidateWorkerIds = uniqueIds([
    ...plainAssignments.map((assignment) => assignment.user_id),
    ...taskWorkerRows.map((task) => task.assigned_to_user_id),
  ]);
  if (candidateWorkerIds.length === 0) {
    return {
      tenantId,
      workerIds: [],
      facilityIds: scopedFacilityIds,
      geographyIds,
      assignments: plainAssignments,
      directFacilities,
    };
  }

  const workerRoleIds = await getWorkerRoleIds();
  const roleRows =
    workerRoleIds.length > 0
      ? await UserRole.findAll({
          where: tenantWhere(req, {
            role_id: { [Op.in]: workerRoleIds },
            user_id: { [Op.in]: candidateWorkerIds },
          }),
          attributes: ['user_id'],
          raw: true,
        })
      : [];

  return {
    tenantId,
    workerIds: uniqueIds(roleRows.map((row) => row.user_id)),
    facilityIds: scopedFacilityIds,
    geographyIds,
    assignments: plainAssignments,
    directFacilities,
  };
};

const buildWorkerBase = (worker, assignmentRows = []) => {
  const assignments = assignmentRows.filter((assignment) => String(assignment.user_id) === String(worker.id));
  const primaryAssignment = assignments[0] || null;
  const facility = primaryAssignment?.facility || null;
  const geography = primaryAssignment?.geography || null;
  const toiletUnit = primaryAssignment?.toiletUnit || null;
  const supervisor = primaryAssignment?.supervisor || null;
  const metadata = worker.metadata || {};

  return {
    workerId: String(worker.id),
    workerName: worker.full_name || `Worker-${String(worker.id).slice(0, 6).toUpperCase()}`,
    employeeCode: worker.employee_code || null,
    role: ROLE_CODES.FIELD_WORKER,
    assignedSupervisorId: primaryAssignment?.supervisor_user_id || null,
    assignedSupervisorName: supervisor?.full_name || null,
    assignedSupervisorEmployeeCode: supervisor?.employee_code || null,
    assignmentLevel: primaryAssignment?.assignment_level || null,
    assignmentRole: primaryAssignment?.assignment_role || null,
    assignedFacilityId: facility?.id || primaryAssignment?.facility_id || toiletUnit?.facility_id || null,
    assignedFacilityName: facility?.name || toiletUnit?.location_label || null,
    assignedFacilityCode: facility?.code || null,
    assignedGeographyId: geography?.id || primaryAssignment?.geography_id || null,
    assignedGeographyName: geography?.name || null,
    assignedGeographyLevel: geography?.level || primaryAssignment?.assignment_level || null,
    assignedWard: geography?.level === 'ward' ? geography.name : null,
    assignedZone: geography?.level === 'zone' ? geography.name : null,
    shift: metadata.shift || metadata.shiftName || 'Default shift',
    phoneBatteryPct: readNumberFromMetadata(metadata, [
      'phoneBatteryPct',
      'mobileBatteryPct',
      'batteryPct',
      'deviceBatteryPct',
    ]),
    appLastLoginAt: toIsoOrNull(worker.last_login_at),
    gpsPermissionStatus: metadata.gpsPermissionStatus || metadata.locationPermissionStatus || null,
    networkStatus: metadata.networkStatus || metadata.connectivityStatus || null,
    lastSeenAt: pickLaterIso(toIsoOrNull(worker.last_login_at), toIsoOrNull(worker.updated_at)),
    tasks: [],
    inspections: [],
    cleanliness: [],
    alerts: [],
    exceptions: [],
    checkInLogs: [],
    checkOutLogs: [],
    locationTrail: [],
    facilityIds: new Set(
      uniqueIds([
        facility?.id,
        primaryAssignment?.facility_id,
        toiletUnit?.facility_id,
      ])
    ),
    latestLocation: null,
    device: {
      mobileDeviceId: null,
      appVersion: null,
      lastSyncAt: null,
      sensorIds: [],
      sensorBatteryPct: null,
      sensorLastSyncAt: null,
      sensorOnline: 0,
      sensorOffline: 0,
    },
  };
};

const setLatestLocation = (worker, point) => {
  if (!point?.at) return;
  if (!worker.latestLocation || toTimestamp(point.at) > toTimestamp(worker.latestLocation.at)) {
    worker.latestLocation = point;
  }
  worker.lastSeenAt = pickLaterIso(worker.lastSeenAt, point.at);
  worker.locationTrail.push(point);
};

const mapTaskStatus = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pending') return 'Assigned';
  if (normalized === 'in_progress') return 'In Progress';
  if (normalized === 'completed') return 'Completed';
  if (normalized === 'overdue') return 'Overdue';
  if (normalized === 'cancelled') return 'Cancelled';
  return status || 'Assigned';
};

const mapCleanlinessStatus = (inspection = {}, aiResult = null) => {
  const explicit = String(inspection.overall_status || inspection.inspection_result || '').toLowerCase();
  const score = toNumber(
    inspection.avg_after_score ?? inspection.improvement_score ?? aiResult?.cleanliness_score,
    null
  );
  if (explicit.includes('critical') || explicit.includes('poor') || explicit.includes('fail')) {
    return 'Rework required';
  }
  if (inspection.review_required) return 'Pending verification';
  if (score !== null && score < 50) return 'Rework required';
  if (score !== null && score < 70) return 'Needs attention';
  if (explicit.includes('clean') || (score !== null && score >= 70)) return 'Clean';
  if (!inspection.submitted_at && !inspection.captured_at) return 'Not inspected';
  return 'Pending verification';
};

const addException = (worker, type, severity, message, source = 'computed', extra = {}) => {
  worker.exceptions.push({
    id: `${source}:${worker.workerId}:${type}:${worker.exceptions.length + 1}`,
    source,
    type,
    severity,
    workerId: worker.workerId,
    workerName: worker.workerName,
    facilityId: worker.assignedFacilityId,
    facilityName: worker.assignedFacilityName,
    message,
    suggestedAction: extra.suggestedAction || 'Review and follow up',
    timestamp: extra.timestamp || new Date().toISOString(),
    status: extra.status || 'open',
    ...extra,
  });
};

const deriveAttendance = (worker) => {
  const checkInLogs = worker.checkInLogs
    .filter((entry) => entry?.at)
    .sort((left, right) => toTimestamp(left.at) - toTimestamp(right.at));
  const checkOutLogs = worker.checkOutLogs
    .filter((entry) => entry?.at)
    .sort((left, right) => toTimestamp(left.at) - toTimestamp(right.at));
  const checkInAt = checkInLogs[0]?.at || null;
  const checkOutAt = checkOutLogs[checkOutLogs.length - 1]?.at || null;

  let status = 'Absent';
  if (checkOutAt) status = 'Checked out';
  else if (checkInAt || worker.tasks.some((task) => task.status === 'In Progress') || worker.locationTrail.some((point) => isToday(point.at))) {
    status = 'Present';
  }

  if (checkInAt) {
    const checkInDate = new Date(checkInAt);
    if (checkInDate.getHours() >= LATE_CHECKIN_HOUR) {
      status = 'Late';
      addException(worker, 'late_check_in', 'medium', 'Worker checked in after expected shift start', 'computed', {
        timestamp: checkInAt,
        suggestedAction: 'Confirm shift start and reason for delay',
      });
    }
  }

  const now = new Date();
  if (checkInAt && !checkOutAt && now.getHours() >= 20) {
    addException(worker, 'missing_check_out', 'medium', 'No check-out activity found for today', 'computed', {
      suggestedAction: 'Ask worker to complete check-out or confirm manual exception',
    });
  }

  if (!checkInAt) {
    addException(worker, 'absent', 'high', 'No check-in activity found for selected date', 'computed', {
      suggestedAction: 'Verify attendance with worker or shift supervisor',
    });
  }

  const workingMinutes = checkInAt ? minutesBetween(checkInAt, checkOutAt || new Date()) : 0;
  return {
    status,
    checkInAt,
    checkOutAt,
    checkInLocation: checkInLogs[0]?.locationLabel || null,
    checkOutLocation: checkOutLogs[checkOutLogs.length - 1]?.locationLabel || null,
    totalWorkingMinutes: workingMinutes,
    totalWorkingHours: Number((workingMinutes / 60).toFixed(2)),
    source: checkInLogs[0]?.source || (checkInAt ? 'mobile_app' : null),
    checkInLogs,
    checkOutLogs,
  };
};

const finalizeWorker = (worker, facilityById = new Map()) => {
  const attendance = deriveAttendance(worker);
  const now = Date.now();
  const lastSeenTs = toTimestamp(worker.lastSeenAt || worker.latestLocation?.at);
  const ageMinutes = lastSeenTs === null ? null : Math.max(0, Math.round((now - lastSeenTs) / 60000));

  let liveStatus = 'Offline';
  if (attendance.status === 'Present' || attendance.status === 'Late') {
    liveStatus = ageMinutes !== null && ageMinutes <= IDLE_THRESHOLD_MINUTES ? 'On duty' : 'Idle';
  }
  if (ageMinutes !== null && ageMinutes > OFFLINE_THRESHOLD_MINUTES) {
    liveStatus = 'Offline';
    addException(worker, 'worker_offline', 'medium', 'No recent worker activity or location update', 'computed', {
      suggestedAction: 'Call worker or check mobile connectivity',
      timestamp: worker.lastSeenAt || new Date().toISOString(),
    });
  }
  if (lastSeenTs === null) {
    addException(worker, 'no_gps_update', 'medium', 'No location update is available for this worker', 'computed', {
      suggestedAction: 'Check GPS permission and mobile network',
    });
  }

  if (worker.phoneBatteryPct !== null && worker.phoneBatteryPct < LOW_BATTERY_PERCENT) {
    addException(worker, 'low_mobile_battery', 'medium', 'Worker mobile battery is below warning level', 'computed', {
      suggestedAction: 'Ask worker to charge device',
    });
  }
  if (worker.device.sensorBatteryPct !== null && worker.device.sensorBatteryPct < LOW_BATTERY_PERCENT) {
    addException(worker, 'low_sensor_battery', 'medium', 'Assigned sensor battery is below warning level', 'computed', {
      suggestedAction: 'Schedule device battery maintenance',
    });
  }

  const assignedFacility = facilityById.get(String(worker.assignedFacilityId || '')) || null;
  if (worker.latestLocation && assignedFacility?.latitude && assignedFacility?.longitude) {
    const distanceMeters = haversineMeters(
      { lat: worker.latestLocation.gpsLat, lng: worker.latestLocation.gpsLng },
      { lat: assignedFacility.latitude, lng: assignedFacility.longitude }
    );
    if (distanceMeters !== null && distanceMeters > ASSIGNED_LOCATION_RADIUS_METERS) {
      addException(worker, 'outside_assigned_area', 'high', 'Latest worker location is outside assigned facility radius', 'computed', {
        distanceMeters: Number(distanceMeters.toFixed(1)),
        suggestedAction: 'Verify worker route and assignment',
      });
    }
  }

  const totalTasks = worker.tasks.length;
  const completedTasks = worker.tasks.filter((task) => task.status === 'Completed').length;
  const inProgressTasks = worker.tasks.filter((task) => task.status === 'In Progress').length;
  const overdueTasks = worker.tasks.filter((task) => task.delayStatus === 'Overdue').length;
  if (overdueTasks > 0) {
    addException(worker, 'task_overdue', 'high', `${overdueTasks} task(s) are overdue`, 'computed', {
      suggestedAction: 'Review task progress and reassign if needed',
    });
  }

  const latestCleanliness = worker.cleanliness
    .slice()
    .sort((left, right) => (toTimestamp(right.lastInspectedAt) || 0) - (toTimestamp(left.lastInspectedAt) || 0))[0] || null;
  if (latestCleanliness && ['Rework required', 'Needs attention'].includes(latestCleanliness.cleanlinessStatus)) {
    addException(worker, 'cleanliness_quality', 'high', 'Latest cleanliness result requires attention', 'computed', {
      suggestedAction: 'Review evidence and request rework if needed',
      timestamp: latestCleanliness.lastInspectedAt || new Date().toISOString(),
    });
  }

  return {
    ...worker,
    attendance,
    liveStatus,
    lastActivityAgeMinutes: ageMinutes,
    currentTask: worker.tasks.find((task) => task.status === 'In Progress') || worker.tasks[0] || null,
    taskSummary: {
      totalTasks,
      completedTasks,
      inProgressTasks,
      pendingTasks: worker.tasks.filter((task) => task.status === 'Assigned').length,
      overdueTasks,
      completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    },
    cleanlinessSummary: {
      latestStatus: latestCleanliness?.cleanlinessStatus || 'Not inspected',
      pendingVerification: worker.cleanliness.filter((item) => item.cleanlinessStatus === 'Pending verification').length,
      reworkRequired: worker.cleanliness.filter((item) => item.cleanlinessStatus === 'Rework required').length,
      latestScore: latestCleanliness?.inspectionScore ?? latestCleanliness?.aiCleanlinessScore ?? null,
    },
    productivity: {
      tasksAssigned: totalTasks,
      tasksCompleted: completedTasks,
      attendancePercentage: attendance.status === 'Absent' ? 0 : 100,
      verificationPassRate:
        worker.cleanliness.length > 0
          ? Math.round(
              (worker.cleanliness.filter((item) => item.cleanlinessStatus === 'Clean').length /
                worker.cleanliness.length) *
                100
            )
          : null,
      repeatIssueCount: worker.exceptions.filter((item) => item.type === 'cleanliness_quality').length,
      averageCompletionMinutes:
        completedTasks > 0
          ? Math.round(
              worker.tasks
                .filter((task) => task.status === 'Completed')
                .reduce((sum, task) => sum + minutesBetween(task.startTime || task.scheduledAt, task.completionTime), 0) /
                completedTasks
            )
          : null,
    },
    exceptions: worker.exceptions.sort((left, right) => {
      const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
      return (severityRank[left.severity] ?? 4) - (severityRank[right.severity] ?? 4);
    }),
  };
};

const buildSupervisorSnapshot = async (req, { defaultDays = 1, maxDays = 30 } = {}) => {
  const range = resolveDateWindow(req.query || {}, { defaultDays, maxDays });
  const scope = await resolveSupervisorScope(req);
  if (!scope.tenantId || scope.workerIds.length === 0) {
    return {
      range,
      scope,
      workers: [],
      facilities: [],
      alerts: [],
    };
  }
  const deletedToiletIds = await loadDeletedToiletIdsForSupervisorScope(req, scope);

  const workerRows = await PlatformUser.findAll({
    where: {
      id: { [Op.in]: scope.workerIds },
      status: 'active',
    },
    attributes: ['id', 'full_name', 'employee_code', 'metadata', 'last_login_at', 'updated_at'],
    raw: true,
  });

  const workersById = new Map(
    workerRows.map((worker) => [
      String(worker.id),
      buildWorkerBase(worker, scope.assignments),
    ])
  );
  const activeWorkerIds = [...workersById.keys()];

  const facilityRows =
    scope.facilityIds.length === 0
      ? []
      : await Facility.findAll({
          where: tenantWhere(req, { id: { [Op.in]: scope.facilityIds } }),
          attributes: ['id', 'name', 'code', 'address_line', 'latitude', 'longitude', 'geography_id', 'zone_geography_id', 'ward_geography_id'],
          raw: true,
        });
  const facilityById = new Map(facilityRows.map((facility) => [String(facility.id), facility]));

  let taskWhere = withDateField(
    tenantWhere(req, { assigned_to_user_id: { [Op.in]: activeWorkerIds } }),
    'scheduled_at',
    range
  );
  if (scope.facilityIds.length > 0) {
    taskWhere.facility_id = { [Op.in]: scope.facilityIds };
  }
  taskWhere = excludeDeletedToiletsFromWhere(taskWhere, deletedToiletIds);

  const taskRows = await InspectionTask.findAll({
    where: taskWhere,
    include: [
      { model: Facility, attributes: ['id', 'name', 'code', 'address_line'], required: false },
      { model: ToiletUnit, attributes: ['id', 'code', 'location_label'], required: false },
    ],
    order: [['scheduled_at', 'DESC']],
    limit: 1000,
  });

  for (const taskModel of taskRows) {
    const task = normalizePlain(taskModel);
    const worker = workersById.get(String(task.assigned_to_user_id || ''));
    if (!worker) continue;
    const status = mapTaskStatus(task.status);
    const dueAt =
      task.sla_minutes && task.scheduled_at
        ? new Date(new Date(task.scheduled_at).getTime() + Number(task.sla_minutes) * 60000)
        : null;
    const delayStatus =
      status !== 'Completed' && dueAt && Date.now() > dueAt.getTime()
        ? 'Overdue'
        : status === 'Completed' && dueAt && task.completed_at && new Date(task.completed_at) > dueAt
          ? 'Completed late'
          : 'On track';
    const mappedTask = {
      taskId: task.id,
      workerId: worker.workerId,
      workerName: worker.workerName,
      assignedSupervisorId: worker.assignedSupervisorId,
      assignedSupervisorName: worker.assignedSupervisorName,
      facilityId: task.facility_id || null,
      facilityName: task.Facility?.name || null,
      toiletUnitId: task.toilet_unit_id || null,
      toiletUnitCode: task.ToiletUnit?.code || null,
      locationLabel: task.ToiletUnit?.location_label || task.Facility?.name || null,
      taskType: task.task_type,
      status,
      rawStatus: task.status,
      scheduledAt: toIsoOrNull(task.scheduled_at),
      startTime: toIsoOrNull(task.started_at),
      completionTime: toIsoOrNull(task.completed_at),
      slaMinutes: task.sla_minutes || null,
      dueAt: toIsoOrNull(dueAt),
      delayStatus,
      supervisorVerificationStatus: status === 'Completed' ? 'Pending verification' : 'Not ready',
      remarks: null,
    };
    worker.tasks.push(mappedTask);
    if (task.facility_id) worker.facilityIds.add(String(task.facility_id));
    if (task.started_at && isToday(task.started_at)) {
      worker.checkInLogs.push({
        at: toIsoOrNull(task.started_at),
        source: 'task_start',
        facilityId: task.facility_id || null,
        toiletUnitId: task.toilet_unit_id || null,
        locationLabel: mappedTask.locationLabel,
      });
    }
    if (task.completed_at && isToday(task.completed_at)) {
      worker.checkOutLogs.push({
        at: toIsoOrNull(task.completed_at),
        source: 'task_complete',
        facilityId: task.facility_id || null,
        toiletUnitId: task.toilet_unit_id || null,
        locationLabel: mappedTask.locationLabel,
      });
    }
    worker.lastSeenAt = pickLaterIso(worker.lastSeenAt, mappedTask.completionTime || mappedTask.startTime || mappedTask.scheduledAt);
  }

  let inspectionWhere = withDateField(
    tenantWhere(req, { inspector_user_id: { [Op.in]: activeWorkerIds } }),
    'captured_at',
    range
  );
  if (scope.facilityIds.length > 0) {
    inspectionWhere.facility_id = { [Op.in]: scope.facilityIds };
  }
  inspectionWhere = excludeDeletedToiletsFromWhere(inspectionWhere, deletedToiletIds);

  const inspectionRows = await Inspection.findAll({
    where: inspectionWhere,
    include: [
      { model: Facility, attributes: ['id', 'name', 'code', 'address_line', 'latitude', 'longitude'], required: false },
      { model: ToiletUnit, attributes: ['id', 'code', 'location_label'], required: false },
      { model: AiAnalysisResult, attributes: ['id', 'cleanliness_score', 'confidence_score', 'review_required', 'severity_label', 'issue_tags', 'processed_at'], required: false },
    ],
    order: [['captured_at', 'DESC']],
    limit: 1000,
  });

  const inspectionIds = uniqueIds(inspectionRows.map((inspection) => inspection.id));
  const mediaRows =
    inspectionIds.length > 0
      ? await InspectionMedia.findAll({
          where: {
            inspection_id: { [Op.in]: inspectionIds },
          },
          attributes: [
            'id',
            'inspection_id',
            'capture_stage',
            'file_url',
            'thumbnail_url',
            'overall_score',
            'confidence_score',
            'issue_tags',
            'review_required',
            'gps_lat',
            'gps_lng',
            'device_id',
            'captured_at',
            'ai_processed_at',
            'severity',
          ],
          raw: true,
        })
      : [];
  const mediaByInspectionId = mediaRows.reduce((acc, media) => {
    const key = String(media.inspection_id || '');
    if (!key) return acc;
    const bucket = acc.get(key) || [];
    bucket.push(media);
    acc.set(key, bucket);
    return acc;
  }, new Map());

  for (const inspectionModel of inspectionRows) {
    const inspection = normalizePlain(inspectionModel);
    const worker = workersById.get(String(inspection.inspector_user_id || ''));
    if (!worker) continue;
    const aiResult = Array.isArray(inspection.AiAnalysisResults) ? inspection.AiAnalysisResults[0] : null;
    const media = mediaByInspectionId.get(String(inspection.id)) || [];
    const beforeMedia = media.find((item) => String(item.capture_stage || '').toLowerCase().includes('before')) || null;
    const afterMedia = media.find((item) => String(item.capture_stage || '').toLowerCase().includes('after')) || null;
    const eventAt = toIsoOrNull(inspection.submitted_at || inspection.captured_at || inspection.created_at);
    const locationLabel =
      inspection.ToiletUnit?.location_label ||
      inspection.Facility?.name ||
      inspection.Facility?.address_line ||
      null;
    const locationPoint = {
      at: eventAt,
      source: 'inspection',
      inspectionId: inspection.id,
      facilityId: inspection.facility_id || null,
      facilityName: inspection.Facility?.name || null,
      toiletUnitId: inspection.toilet_unit_id || null,
      toiletUnitCode: inspection.ToiletUnit?.code || null,
      locationLabel,
      gpsLat: toNumber(inspection.latitude ?? afterMedia?.gps_lat ?? beforeMedia?.gps_lat, null),
      gpsLng: toNumber(inspection.longitude ?? afterMedia?.gps_lng ?? beforeMedia?.gps_lng, null),
      isLastKnown: true,
    };
    worker.inspections.push({
      inspectionId: inspection.id,
      taskId: inspection.task_id || null,
      workerId: worker.workerId,
      workerName: worker.workerName,
      assignedSupervisorId: worker.assignedSupervisorId,
      assignedSupervisorName: worker.assignedSupervisorName,
      facilityId: inspection.facility_id || null,
      facilityName: inspection.Facility?.name || null,
      toiletUnitId: inspection.toilet_unit_id || null,
      toiletUnitCode: inspection.ToiletUnit?.code || null,
      inspectionType: inspection.inspection_type,
      status: inspection.status || inspection.processing_status,
      capturedAt: toIsoOrNull(inspection.captured_at),
      submittedAt: toIsoOrNull(inspection.submitted_at),
      reviewRequired: Boolean(inspection.review_required || aiResult?.review_required),
      overallStatus: inspection.overall_status || null,
      inspectionResult: inspection.inspection_result || null,
      score: toNumber(inspection.avg_after_score ?? aiResult?.cleanliness_score, null),
    });
    worker.cleanliness.push({
      inspectionId: inspection.id,
      taskId: inspection.task_id || null,
      workerId: worker.workerId,
      workerName: worker.workerName,
      assignedSupervisorId: worker.assignedSupervisorId,
      assignedSupervisorName: worker.assignedSupervisorName,
      facilityId: inspection.facility_id || null,
      facilityName: inspection.Facility?.name || null,
      locationLabel,
      toiletUnitId: inspection.toilet_unit_id || null,
      toiletUnitCode: inspection.ToiletUnit?.code || null,
      latestCleanlinessStatus: inspection.overall_status || inspection.inspection_result || null,
      cleanlinessStatus: mapCleanlinessStatus(inspection, aiResult),
      beforePhotoUrl: beforeMedia?.thumbnail_url || beforeMedia?.file_url || null,
      afterPhotoUrl: afterMedia?.thumbnail_url || afterMedia?.file_url || null,
      inspectionScore: toNumber(inspection.avg_after_score ?? afterMedia?.overall_score, null),
      aiCleanlinessScore: toNumber(aiResult?.cleanliness_score, null),
      aiConfidenceScore: toNumber(aiResult?.confidence_score ?? afterMedia?.confidence_score, null),
      manualSupervisorVerificationStatus: inspection.review_required ? 'Pending review' : 'Not recorded',
      issuesFound: aiResult?.issue_tags || afterMedia?.issue_tags || inspection.remaining_issues || [],
      reworkRequired: ['Rework required', 'Needs attention'].includes(mapCleanlinessStatus(inspection, aiResult)),
      lastCleanedAt: toIsoOrNull(inspection.submitted_at),
      lastInspectedAt: eventAt,
    });
    if (inspection.facility_id) worker.facilityIds.add(String(inspection.facility_id));
    if (eventAt && isToday(eventAt)) {
      worker.checkInLogs.push({
        at: eventAt,
        source: 'inspection_capture',
        facilityId: inspection.facility_id || null,
        toiletUnitId: inspection.toilet_unit_id || null,
        locationLabel,
        gpsLat: locationPoint.gpsLat,
        gpsLng: locationPoint.gpsLng,
      });
    }
    setLatestLocation(worker, locationPoint);
  }

  const presignCache = new Map();
  const resolveEvidencePhotoUrl = async (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    try {
      const resolved = await resolveMediaUrl({ fileUrl: trimmed }, { cache: presignCache });
      return resolved && String(resolved).trim() ? String(resolved).trim() : null;
    } catch {
      return trimmed;
    }
  };
  const cleanlinessRows = [...workersById.values()].flatMap((worker) => worker.cleanliness || []);
  await Promise.all(
    cleanlinessRows.map(async (entry) => {
      entry.beforePhotoUrl = await resolveEvidencePhotoUrl(entry.beforePhotoUrl);
      entry.afterPhotoUrl = await resolveEvidencePhotoUrl(entry.afterPhotoUrl);
    }),
  );

  const facilityIdsForDevices = uniqueIds(
    [...workersById.values()].flatMap((worker) => [...worker.facilityIds.values()])
  );
  const deviceRows =
    facilityIdsForDevices.length > 0
      ? await SensorDevice.findAll({
          where: tenantWhere(req, { facility_id: { [Op.in]: facilityIdsForDevices } }),
          attributes: ['id', 'facility_id', 'device_id', 'serial_no', 'status', 'last_seen_at', 'metadata', 'firmware_version'],
          raw: true,
        })
      : [];
  const readingRows =
    deviceRows.length > 0
      ? await SensorReading.findAll({
          where: { device_id: { [Op.in]: uniqueIds(deviceRows.map((device) => device.id)) } },
          attributes: ['device_id', 'timestamp', 'battery_level', 'signal_strength'],
          order: [['timestamp', 'DESC']],
          raw: true,
          limit: Math.max(100, deviceRows.length * 5),
        })
      : [];
  const latestReadingByDeviceId = new Map();
  for (const reading of readingRows) {
    const key = String(reading.device_id || '');
    if (!key || latestReadingByDeviceId.has(key)) continue;
    latestReadingByDeviceId.set(key, reading);
  }

  const devicesByFacilityId = deviceRows.reduce((acc, device) => {
    const key = String(device.facility_id || '');
    if (!key) return acc;
    const bucket = acc.get(key) || [];
    bucket.push(device);
    acc.set(key, bucket);
    return acc;
  }, new Map());

  const tokenRows = await NotificationDeviceToken.findAll({
    where: tenantWhere(req, {
      user_id: { [Op.in]: activeWorkerIds },
      disabled_at: null,
    }),
    attributes: ['user_id', 'platform', 'device_id', 'app_version', 'metadata', 'last_active_at', 'updated_at'],
    order: [['last_active_at', 'DESC']],
    raw: true,
  });
  const latestTokenByUserId = new Map();
  for (const token of tokenRows) {
    const key = String(token.user_id || '');
    if (!key || latestTokenByUserId.has(key)) continue;
    latestTokenByUserId.set(key, token);
  }

  for (const worker of workersById.values()) {
    const token = latestTokenByUserId.get(worker.workerId) || null;
    const tokenMetadata = token?.metadata && typeof token.metadata === 'object' && !Array.isArray(token.metadata)
      ? token.metadata
      : {};
    worker.device.mobileDeviceId = token?.device_id || null;
    worker.device.appVersion = token?.app_version || null;
    worker.device.lastSyncAt = toIsoOrNull(token?.last_active_at || token?.updated_at);
    const tokenBattery = readNumberFromMetadata(tokenMetadata, [
      'phoneBatteryPct',
      'mobileBatteryPct',
      'batteryPct',
      'battery_level',
      'batteryLevel',
      'phone_battery_pct',
    ]);
    if (worker.phoneBatteryPct === null && tokenBattery !== null) worker.phoneBatteryPct = tokenBattery;
    const appCheckInAt = readDateFromMetadata(tokenMetadata, [
      'checkInAt',
      'checkedInAt',
      'lastCheckInAt',
      'appCheckInAt',
      'app_check_in_at',
    ]);
    const appCheckOutAt = readDateFromMetadata(tokenMetadata, [
      'checkOutAt',
      'checkedOutAt',
      'lastCheckOutAt',
      'appCheckOutAt',
      'app_check_out_at',
    ]);
    const appLastHeartbeatAt = toIsoOrNull(token?.last_active_at || token?.updated_at);
    if (appCheckInAt && isToday(appCheckInAt)) {
      worker.checkInLogs.push({
        at: appCheckInAt,
        source: 'app_checkin',
        facilityId: worker.assignedFacilityId || null,
        toiletUnitId: null,
        locationLabel: worker.assignedFacilityName || 'Worker app',
      });
    } else if (appLastHeartbeatAt && isToday(appLastHeartbeatAt)) {
      worker.checkInLogs.push({
        at: appLastHeartbeatAt,
        source: 'app_heartbeat',
        facilityId: worker.assignedFacilityId || null,
        toiletUnitId: null,
        locationLabel: worker.assignedFacilityName || 'Worker app',
      });
    }
    if (appCheckOutAt && isToday(appCheckOutAt)) {
      worker.checkOutLogs.push({
        at: appCheckOutAt,
        source: 'app_checkout',
        facilityId: worker.assignedFacilityId || null,
        toiletUnitId: null,
        locationLabel: worker.assignedFacilityName || 'Worker app',
      });
    }
    worker.lastSeenAt = pickLaterIso(worker.lastSeenAt, appLastHeartbeatAt);
    if (!worker.networkStatus) {
      worker.networkStatus = readStringFromMetadata(tokenMetadata, [
        'networkStatus',
        'connectivityStatus',
        'network_status',
      ]) || worker.networkStatus;
    }
    if (!worker.gpsPermissionStatus) {
      worker.gpsPermissionStatus = readStringFromMetadata(tokenMetadata, [
        'gpsPermissionStatus',
        'locationPermissionStatus',
        'gps_permission_status',
      ]) || worker.gpsPermissionStatus;
    }
    if (
      !worker.latestLocation &&
      appLastHeartbeatAt
    ) {
      const tokenLat = readNumberFromMetadata(tokenMetadata, ['gpsLat', 'latitude', 'lat']);
      const tokenLng = readNumberFromMetadata(tokenMetadata, ['gpsLng', 'longitude', 'lng', 'lon']);
      if (tokenLat !== null && tokenLng !== null) {
        setLatestLocation(worker, {
          at: appLastHeartbeatAt,
          source: 'app_heartbeat',
          inspectionId: null,
          facilityId: worker.assignedFacilityId || null,
          facilityName: worker.assignedFacilityName || null,
          toiletUnitId: null,
          toiletUnitCode: null,
          locationLabel: worker.assignedFacilityName || 'Worker app location',
          gpsLat: tokenLat,
          gpsLng: tokenLng,
          isLastKnown: true,
        });
      }
    }

    const workerDevices = [...worker.facilityIds.values()].flatMap((facilityId) => devicesByFacilityId.get(String(facilityId)) || []);
    worker.device.sensorIds = uniqueIds(workerDevices.map((device) => device.device_id || device.serial_no || device.id));
    const latestDeviceReadings = workerDevices
      .map((device) => ({
        device,
        reading: latestReadingByDeviceId.get(String(device.id)) || null,
      }))
      .filter((item) => item.device || item.reading);
    const batteryLevels = latestDeviceReadings
      .map((item) => toNumber(item.reading?.battery_level ?? item.device?.metadata?.batteryLevel, null))
      .filter((value) => value !== null);
    worker.device.sensorBatteryPct =
      batteryLevels.length > 0 ? Math.min(...batteryLevels.map((value) => Number(value))) : null;
    worker.device.sensorLastSyncAt = latestDeviceReadings.reduce(
      (latest, item) => pickLaterIso(latest, toIsoOrNull(item.reading?.timestamp || item.device?.last_seen_at)),
      null
    );
    worker.device.sensorOnline = workerDevices.filter((device) => device.status === 'active').length;
    worker.device.sensorOffline = workerDevices.length - worker.device.sensorOnline;
  }

  const alertWhere = tenantWhere(req);
  const alertOr = [];
  if (scope.facilityIds.length > 0) alertOr.push({ facility_id: { [Op.in]: scope.facilityIds } });
  alertOr.push({ assigned_to_user_id: { [Op.in]: activeWorkerIds } });
  alertWhere[Op.or] = alertOr;
  const alertRows = await Alert.findAll({
    where: withDateField(alertWhere, 'created_at', range),
    include: [{ model: Facility, attributes: ['id', 'name', 'code'], required: false }],
    order: [['created_at', 'DESC']],
    limit: 500,
  });
  const deletedInspectionIds =
    deletedToiletIds.length > 0 && alertRows.length > 0
      ? new Set(
          (
            await Inspection.findAll({
              where: {
                id: {
                  [Op.in]: uniqueIds(
                    alertRows
                      .map((alert) => normalizePlain(alert))
                      .filter((alert) => alert.source_type === 'ai_analysis')
                      .map((alert) => alert.source_id)
                  ),
                },
                toilet_unit_id: { [Op.in]: deletedToiletIds },
              },
              attributes: ['id'],
              raw: true,
            })
          ).map((row) => String(row.id))
        )
      : new Set();

  const actualAlerts = [];
  for (const alertModel of alertRows) {
    const alert = normalizePlain(alertModel);
    if (alert.source_type === 'ai_analysis' && deletedInspectionIds.has(String(alert.source_id || ''))) {
      continue;
    }
    const worker =
      workersById.get(String(alert.assigned_to_user_id || '')) ||
      [...workersById.values()].find((candidate) => candidate.facilityIds.has(String(alert.facility_id || ''))) ||
      null;
    const mappedAlert = {
      id: alert.id,
      source: 'backend_alert',
      severity: alert.severity,
      workerId: worker?.workerId || null,
      workerName: worker?.workerName || null,
      facilityId: alert.facility_id || null,
      facilityName: alert.Facility?.name || null,
      alertType: alert.alert_type,
      timestamp: toIsoOrNull(alert.created_at),
      status: alert.status,
      message: alert.message,
      suggestedAction: alert.status === 'open' ? 'Acknowledge and escalate if field action is required' : 'Monitor until resolved',
      resolutionStatus: alert.status,
    };
    actualAlerts.push(mappedAlert);
    if (worker) worker.alerts.push(mappedAlert);
  }

  const finalizedWorkers = [...workersById.values()].map((worker) => finalizeWorker(worker, facilityById));
  const computedAlerts = finalizedWorkers.flatMap((worker) => worker.exceptions);

  return {
    range,
    scope,
    workers: finalizedWorkers,
    facilities: facilityRows,
    alerts: [...actualAlerts, ...computedAlerts].sort((left, right) => {
      const severityRank = { critical: 0, high: 1, medium: 2, low: 3 };
      const severityDiff = (severityRank[left.severity] ?? 4) - (severityRank[right.severity] ?? 4);
      if (severityDiff !== 0) return severityDiff;
      return (toTimestamp(right.timestamp) || 0) - (toTimestamp(left.timestamp) || 0);
    }),
  };
};

const summarizeSnapshot = (snapshot) => {
  const workers = snapshot.workers || [];
  const alerts = snapshot.alerts || [];
  const present = workers.filter((worker) => ['Present', 'Late', 'Checked out'].includes(worker.attendance.status));
  const activeTasks = workers.reduce((sum, worker) => sum + worker.taskSummary.inProgressTasks + worker.taskSummary.pendingTasks, 0);
  const completedTasksToday = workers.reduce((sum, worker) => sum + worker.taskSummary.completedTasks, 0);
  const pendingCleanliness = workers.reduce((sum, worker) => sum + worker.cleanlinessSummary.pendingVerification, 0);

  return {
    totalAssignedWorkers: workers.length,
    presentToday: present.length,
    absentToday: workers.filter((worker) => worker.attendance.status === 'Absent').length,
    lateCheckIns: workers.filter((worker) => worker.attendance.status === 'Late').length,
    workersCurrentlyOnDuty: workers.filter((worker) => worker.liveStatus === 'On duty').length,
    workersCurrentlyOffline: workers.filter((worker) => worker.liveStatus === 'Offline').length,
    activeTasks,
    completedTasksToday,
    pendingCleanlinessVerification: pendingCleanliness,
    alertsRequiringAttention: alerts.filter((alert) => alert.status !== 'resolved').length,
    lowMobileBatteryCount: workers.filter((worker) => worker.phoneBatteryPct !== null && worker.phoneBatteryPct < LOW_BATTERY_PERCENT).length,
    lowSensorBatteryCount: workers.filter((worker) => worker.device.sensorBatteryPct !== null && worker.device.sensorBatteryPct < LOW_BATTERY_PERCENT).length,
  };
};

const getOverview = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 1, maxDays: 30 });
  const summary = summarizeSnapshot(snapshot);
  return {
    range: snapshot.range,
    scope: {
      scopeLevel: req.user?.scopeLevel || null,
      facilityCount: snapshot.scope.facilityIds.length,
      geographyCount: snapshot.scope.geographyIds.length,
    },
    summary,
    widgets: {
      workerStatusDistribution: [
        { status: 'On duty', count: snapshot.workers.filter((worker) => worker.liveStatus === 'On duty').length },
        { status: 'Idle', count: snapshot.workers.filter((worker) => worker.liveStatus === 'Idle').length },
        { status: 'Offline', count: snapshot.workers.filter((worker) => worker.liveStatus === 'Offline').length },
      ],
      taskProgressSummary: {
        assigned: snapshot.workers.reduce((sum, worker) => sum + worker.taskSummary.totalTasks, 0),
        completed: snapshot.workers.reduce((sum, worker) => sum + worker.taskSummary.completedTasks, 0),
        overdue: snapshot.workers.reduce((sum, worker) => sum + worker.taskSummary.overdueTasks, 0),
      },
      cleanlinessStatusSummary: snapshot.workers.reduce((acc, worker) => {
        const status = worker.cleanlinessSummary.latestStatus || 'Not inspected';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {}),
      recentAlerts: snapshot.alerts.slice(0, 8),
      recentlyCheckedInWorkers: snapshot.workers
        .filter((worker) => worker.attendance.checkInAt)
        .sort((left, right) => (toTimestamp(right.attendance.checkInAt) || 0) - (toTimestamp(left.attendance.checkInAt) || 0))
        .slice(0, 8),
      recentlyCheckedOutWorkers: snapshot.workers
        .filter((worker) => worker.attendance.checkOutAt)
        .sort((left, right) => (toTimestamp(right.attendance.checkOutAt) || 0) - (toTimestamp(left.attendance.checkOutAt) || 0))
        .slice(0, 8),
    },
  };
};

const getWorkers = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 7, maxDays: 30 });
  const query = String(req.query.search || req.query.query || '').trim().toLowerCase();
  const status = String(req.query.status || 'all').toLowerCase();
  const rows = snapshot.workers.filter((worker) => {
    if (query && !`${worker.workerName} ${worker.employeeCode || ''}`.toLowerCase().includes(query)) {
      return false;
    }
  if (status !== 'all' && String(worker.liveStatus || '').toLowerCase() !== status) {
      return false;
    }
    return true;
  });
  return paginateArray(rows, req.query);
};

const getWorkerDetail = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 30, maxDays: 90 });
  const worker = snapshot.workers.find((item) => String(item.workerId) === String(req.params.workerId));
  if (!worker) {
    throw new AppError('Worker not found in supervisor scope', 404, { code: 'WORKER_NOT_IN_SCOPE' });
  }
  return worker;
};

const getAttendance = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 1, maxDays: 31 });
  let rows = snapshot.workers.map((worker) => ({
    workerId: worker.workerId,
    workerName: worker.workerName,
    employeeCode: worker.employeeCode,
    assignedFacility: worker.assignedFacilityName,
    assignedGeography: worker.assignedGeographyName,
    assignedSupervisorId: worker.assignedSupervisorId,
    assignedSupervisorName: worker.assignedSupervisorName,
    shift: worker.shift,
    attendanceStatus: worker.attendance.status,
    checkInAt: worker.attendance.checkInAt,
    checkOutAt: worker.attendance.checkOutAt,
    totalWorkingMinutes: worker.attendance.totalWorkingMinutes,
    totalWorkingHours: worker.attendance.totalWorkingHours,
    lastKnownLocation: worker.latestLocation?.locationLabel || null,
    attendanceSource: worker.attendance.source || 'not_available',
    remarks: worker.exceptions.map((item) => item.message).join('; ') || null,
  }));
  if (req.query.status && String(req.query.status).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.attendanceStatus || '').toLowerCase() === String(req.query.status).toLowerCase());
  }
  if (req.query.search) {
    const query = String(req.query.search).toLowerCase();
    rows = rows.filter((row) => `${row.workerName} ${row.employeeCode || ''}`.toLowerCase().includes(query));
  }
  if (req.query.facility) {
    rows = rows.filter((row) => includesFilter(row.assignedFacility, req.query.facility));
  }
  if (req.query.geography) {
    rows = rows.filter((row) => includesFilter(row.assignedGeography, req.query.geography));
  }
  if (req.query.shift) {
    rows = rows.filter((row) => includesFilter(row.shift, req.query.shift));
  }
  return paginateArray(rows, req.query);
};

const getLiveLocations = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 7, maxDays: 30 });
  let rows = snapshot.workers.map((worker) => ({
    workerId: worker.workerId,
    workerName: worker.workerName,
    employeeCode: worker.employeeCode,
    currentStatus: worker.liveStatus,
    assignedSupervisorId: worker.assignedSupervisorId,
    assignedSupervisorName: worker.assignedSupervisorName,
    lastUpdatedAt: worker.latestLocation?.at || worker.lastSeenAt,
    gpsLat: worker.latestLocation?.gpsLat ?? null,
    gpsLng: worker.latestLocation?.gpsLng ?? null,
    assignedFacility: worker.assignedFacilityName,
    assignedGeography: worker.assignedGeographyName,
    currentTask: worker.currentTask,
    mobileBatteryPct: worker.phoneBatteryPct,
    networkStatus: worker.networkStatus || 'Not available',
    locationLabel: worker.latestLocation?.locationLabel || 'Last known location not available',
    isLastKnown: true,
    exceptions: worker.exceptions.filter((item) =>
      ['outside_assigned_area', 'no_gps_update', 'worker_offline'].includes(item.type)
    ),
  }));
  if (req.query.status && String(req.query.status).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.currentStatus || '').toLowerCase() === String(req.query.status).toLowerCase());
  }
  if (req.query.search) {
    rows = rows.filter((row) => includesFilter(`${row.workerName} ${row.employeeCode || ''}`, req.query.search));
  }
  if (req.query.facility) {
    rows = rows.filter((row) => includesFilter(row.assignedFacility, req.query.facility));
  }
  if (req.query.geography) {
    rows = rows.filter((row) => includesFilter(row.assignedGeography, req.query.geography));
  }
  return paginateArray(rows, req.query);
};

const ageMinutesFrom = (value) => {
  const timestamp = toTimestamp(value);
  if (timestamp === null) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 60000));
};

const resolveTaskDueAt = (task) => {
  if (task.due_at) return toIsoOrNull(task.due_at);
  if (!task.scheduled_at || !task.sla_minutes) return null;
  return toIsoOrNull(new Date(new Date(task.scheduled_at).getTime() + Number(task.sla_minutes) * 60000));
};

const mapTaskStatusForMap = (status) => {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'assigned') return 'Assigned';
  if (normalized === 'accepted') return 'Accepted';
  if (normalized === 'unassigned') return 'Unassigned';
  return mapTaskStatus(status);
};

const isCriticalComplaintPlain = (complaint = {}) => {
  const criticalValues = getCriticalComplaintValueSet();
  return ['priority', 'status', 'complaint_type']
    .map((key) => complaint[key])
    .some((value) => {
      const raw = String(value || '').trim().toLowerCase();
      return raw && (criticalValues.has(raw) || criticalValues.has(normalizeToken(raw)));
    });
};

const latestHeartbeatByWorker = async ({ tenantId, workerIds }) => {
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
    raw: true,
  });
  const latest = new Map();
  for (const row of rows) {
    const key = String(row.worker_id || '');
    if (key && !latest.has(key)) latest.set(key, row);
  }
  return latest;
};

const activeTaskCountByWorker = async ({ tenantId, workerIds, deletedToiletIds = [] }) => {
  if (workerIds.length === 0) return new Map();
  const rows = await InspectionTask.findAll({
    where: excludeDeletedToiletsFromWhere(
      {
        tenant_id: tenantId,
        assigned_to_user_id: { [Op.in]: workerIds },
        status: { [Op.in]: ACTIVE_TASK_STATUSES },
      },
      deletedToiletIds,
    ),
    attributes: ['assigned_to_user_id'],
    raw: true,
  });
  const counts = new Map();
  rows.forEach((row) => {
    const key = String(row.assigned_to_user_id || '');
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
};

const buildDeviceStatusMaps = async (req, { facilityIds = [], toiletUnitIds = [] }) => {
  const deviceOr = [];
  if (facilityIds.length > 0) deviceOr.push({ facility_id: { [Op.in]: facilityIds } });
  if (toiletUnitIds.length > 0) deviceOr.push({ toilet_unit_id: { [Op.in]: toiletUnitIds } });
  if (deviceOr.length === 0) {
    return { byToiletId: new Map(), byFacilityId: new Map() };
  }

  const devices = await SensorDevice.findAll({
    where: tenantWhere(req, { [Op.or]: deviceOr }),
    attributes: [
      'id',
      'facility_id',
      'toilet_unit_id',
      'device_id',
      'serial_no',
      'status',
      'last_seen_at',
      'metadata',
    ],
    raw: true,
  });
  const readingRows =
    devices.length > 0
      ? await SensorReading.findAll({
          where: { device_id: { [Op.in]: uniqueIds(devices.map((device) => device.id)) } },
          attributes: ['device_id', 'timestamp', 'battery_level', 'signal_strength'],
          order: [['timestamp', 'DESC']],
          raw: true,
          limit: Math.max(100, devices.length * 5),
        })
      : [];

  const latestReadingByDeviceId = new Map();
  for (const reading of readingRows) {
    const key = String(reading.device_id || '');
    if (key && !latestReadingByDeviceId.has(key)) latestReadingByDeviceId.set(key, reading);
  }

  const lowBatteryThreshold = Number(runtimeConfig.automation.lowMobileBatteryThreshold || LOW_BATTERY_PERCENT);
  const mapDevice = (device) => {
    const reading = latestReadingByDeviceId.get(String(device.id)) || null;
    const battery = toNumber(
      reading?.battery_level ?? device?.metadata?.batteryLevel ?? device?.metadata?.battery_percentage,
      null
    );
    const lastSeenAt = toIsoOrNull(reading?.timestamp || device.last_seen_at);
    return {
      deviceId: device.device_id || device.serial_no || device.id,
      status: device.status || 'unknown',
      batteryPercentage: battery,
      lastSeenAt,
      signalStrength: toNumber(reading?.signal_strength, null),
      isLowBattery: battery !== null && battery < lowBatteryThreshold,
      isStale: ageMinutesFrom(lastSeenAt) !== null && ageMinutesFrom(lastSeenAt) > 120,
    };
  };

  const byToiletId = new Map();
  const byFacilityId = new Map();
  for (const device of devices) {
    const status = mapDevice(device);
    const toiletKey = String(device.toilet_unit_id || '');
    const facilityKey = String(device.facility_id || '');
    if (toiletKey && !byToiletId.has(toiletKey)) byToiletId.set(toiletKey, status);
    if (facilityKey) {
      const bucket = byFacilityId.get(facilityKey) || [];
      bucket.push(status);
      byFacilityId.set(facilityKey, bucket);
    }
  }

  return { byToiletId, byFacilityId };
};

const resolveDeviceForToilet = (deviceMaps, toiletUnitId, facilityId) => {
  const toiletDevice = deviceMaps.byToiletId.get(String(toiletUnitId || ''));
  if (toiletDevice) return toiletDevice;
  const facilityDevices = deviceMaps.byFacilityId.get(String(facilityId || '')) || [];
  return facilityDevices[0] || null;
};

const summarizeSupervisorScopeForMap = (scope = {}) => ({
  tenantId: scope.tenantId || null,
  facilityIds: uniqueIds(scope.facilityIds || []),
  geographyIds: uniqueIds(scope.geographyIds || []),
  workerIds: uniqueIds(scope.workerIds || []),
  facilityCount: uniqueIds(scope.facilityIds || []).length,
  workerCount: uniqueIds(scope.workerIds || []).length,
});

const mapLocationForTask = (task = {}) => {
  const lat = toNumberOrNull(task.latitude ?? task.ToiletUnit?.latitude ?? task.Facility?.latitude);
  const lng = toNumberOrNull(task.longitude ?? task.ToiletUnit?.longitude ?? task.Facility?.longitude);
  return {
    latitude: lat,
    longitude: lng,
    label: task.ToiletUnit?.location_label || task.Facility?.name || task.Facility?.address_line || null,
  };
};

const mapLocationForComplaint = (complaint = {}) => {
  const lat = toNumberOrNull(complaint.ToiletUnit?.latitude ?? complaint.Facility?.latitude);
  const lng = toNumberOrNull(complaint.ToiletUnit?.longitude ?? complaint.Facility?.longitude);
  return {
    latitude: lat,
    longitude: lng,
    label: complaint.ToiletUnit?.location_label || complaint.Facility?.name || complaint.Facility?.address_line || null,
  };
};

const getLiveMap = async (req) => {
  const scope = await resolveSupervisorScope(req);
  const tenantId = scope.tenantId;
  const emptyPayload = {
    scope: summarizeSupervisorScopeForMap(scope),
    summary: {
      criticalComplaints: 0,
      activeTasks: 0,
      assignedTasks: 0,
      unassignedTasks: 0,
      workersOnline: 0,
      lowBatteryWorkers: 0,
      staleLocationWorkers: 0,
      slaBreachedTasks: 0,
    },
    workers: [],
    tasks: [],
    toilets: [],
    complaints: [],
    config: {
      pollingIntervalMs: runtimeConfig.automation.mapPollingIntervalMs,
      lowBatteryThreshold: runtimeConfig.automation.lowMobileBatteryThreshold,
      locationFreshnessMinutes: runtimeConfig.automation.workerLocationFreshnessMinutes,
    },
  };
  if (!tenantId) return emptyPayload;

  const scopedFacilityIds = uniqueIds(scope.facilityIds || []);
  if (scopedFacilityIds.length === 0 && !req.user?.isSuperAdmin) {
    return emptyPayload;
  }
  const deletedToiletIds = await loadDeletedToiletIdsForSupervisorScope(req, scope);

  const facilityFilter =
    scopedFacilityIds.length > 0 ? { facility_id: { [Op.in]: scopedFacilityIds } } : {};
  const taskRows = await InspectionTask.findAll({
    where: excludeDeletedToiletsFromWhere(
      tenantWhere(req, {
        ...facilityFilter,
        status: { [Op.in]: ACTIVE_TASK_STATUSES },
        [Op.or]: [
          { task_type: CRITICAL_COMPLAINT_TASK_TYPE },
          { priority: 'critical' },
        ],
      }),
      deletedToiletIds,
    ),
    include: [
      { model: Facility, attributes: ['id', 'name', 'code', 'address_line', 'latitude', 'longitude'], required: false },
      { model: ToiletUnit, attributes: ['id', 'code', 'location_label', 'latitude', 'longitude'], required: false },
      { model: Complaint, as: 'complaint', attributes: ['id', 'priority', 'status', 'complaint_type', 'description', 'source_channel', 'created_at'], required: false },
      {
        model: PlatformUser,
        as: 'assignee',
        attributes: ['id', 'full_name', 'employee_code', 'email'],
        required: false,
      },
    ],
    order: [
      ['due_at', 'ASC'],
      ['scheduled_at', 'ASC'],
    ],
    limit: 500,
  });

  const complaintWhere = tenantWhere(req, {
    ...facilityFilter,
    status: { [Op.in]: ['open', 'assigned'] },
  });
  const complaintRows = await Complaint.findAll({
    where: excludeDeletedToiletsFromWhere(complaintWhere, deletedToiletIds),
    include: [
      { model: Facility, attributes: ['id', 'name', 'code', 'address_line', 'latitude', 'longitude'], required: false },
      { model: ToiletUnit, attributes: ['id', 'code', 'location_label', 'latitude', 'longitude'], required: false },
      {
        model: PlatformUser,
        as: 'assignedTo',
        attributes: ['id', 'full_name', 'employee_code', 'email'],
        required: false,
      },
    ],
    order: [['created_at', 'DESC']],
    limit: 500,
  });

  const tasksPlain = taskRows.map(normalizePlain);
  const complaintsPlain = complaintRows.map(normalizePlain).filter(isCriticalComplaintPlain);
  const taskWorkerIds = uniqueIds(tasksPlain.map((task) => task.assigned_to_user_id));
  const activeWorkerIds = uniqueIds([...(scope.workerIds || []), ...taskWorkerIds]);
  const [workerRows, heartbeatMap, taskCountMap, assignmentRows] = await Promise.all([
    activeWorkerIds.length > 0
      ? PlatformUser.findAll({
          where: {
            id: { [Op.in]: activeWorkerIds },
            tenant_id: tenantId,
            status: 'active',
          },
          attributes: ['id', 'full_name', 'employee_code', 'email', 'metadata', 'last_login_at', 'updated_at'],
          raw: true,
        })
      : [],
    latestHeartbeatByWorker({ tenantId, workerIds: activeWorkerIds }),
    activeTaskCountByWorker({ tenantId, workerIds: activeWorkerIds, deletedToiletIds }),
    tasksPlain.length > 0
      ? TaskAssignmentLog.findAll({
          where: {
            tenant_id: tenantId,
            task_id: { [Op.in]: tasksPlain.map((task) => task.id) },
          },
          order: [
            ['task_id', 'ASC'],
            ['created_at', 'DESC'],
          ],
          raw: true,
        })
      : [],
  ]);

  const latestAssignmentByTaskId = new Map();
  for (const row of assignmentRows) {
    const key = String(row.task_id || '');
    if (key && !latestAssignmentByTaskId.has(key)) latestAssignmentByTaskId.set(key, row);
  }

  const toiletUnitIds = uniqueIds([
    ...tasksPlain.map((task) => task.toilet_unit_id),
    ...complaintsPlain.map((complaint) => complaint.toilet_unit_id),
  ]);
  const deviceMaps = await buildDeviceStatusMaps(req, {
    facilityIds: scopedFacilityIds,
    toiletUnitIds,
  });

  const lowBatteryThreshold = Number(runtimeConfig.automation.lowMobileBatteryThreshold || LOW_BATTERY_PERCENT);
  const freshnessMinutes = Number(runtimeConfig.automation.workerLocationFreshnessMinutes || IDLE_THRESHOLD_MINUTES);
  const workerTasksById = tasksPlain.reduce((acc, task) => {
    const key = String(task.assigned_to_user_id || '');
    if (!key) return acc;
    const bucket = acc.get(key) || [];
    bucket.push(task);
    acc.set(key, bucket);
    return acc;
  }, new Map());

  const workers = workerRows.map((worker) => {
    const heartbeat = heartbeatMap.get(String(worker.id)) || null;
    const heartbeatAgeMinutes = ageMinutesFrom(heartbeat?.captured_at);
    const mobileBatteryPercentage = toNumber(
      heartbeat?.mobile_battery_percentage ??
        worker?.metadata?.mobileBatteryPct ??
        worker?.metadata?.phoneBatteryPct,
      null
    );
    const assignedTasks = workerTasksById.get(String(worker.id)) || [];
    const latestTask = assignedTasks[0] || null;
    const staleLocation =
      heartbeatAgeMinutes === null || heartbeatAgeMinutes > freshnessMinutes;
    return {
      workerId: String(worker.id),
      workerName: worker.full_name || `Worker-${String(worker.id).slice(0, 6).toUpperCase()}`,
      employeeCode: worker.employee_code || null,
      email: worker.email || null,
      currentStatus: !heartbeat ? 'Offline' : staleLocation ? 'Stale' : 'Online',
      activeTaskCount: taskCountMap.get(String(worker.id)) || 0,
      latestTaskId: latestTask?.id || null,
      latestTaskStatus: latestTask?.status || null,
      location: heartbeat
        ? {
            latitude: toNumberOrNull(heartbeat.latitude),
            longitude: toNumberOrNull(heartbeat.longitude),
            accuracy: toNumber(heartbeat.accuracy, null),
            capturedAt: toIsoOrNull(heartbeat.captured_at),
            ageMinutes: heartbeatAgeMinutes,
            isStale: staleLocation,
            source: heartbeat.source || 'mobile_app',
          }
        : null,
      mobileBatteryPercentage,
      isCharging: heartbeat?.is_charging ?? worker?.metadata?.isCharging ?? null,
      isLowBattery:
        mobileBatteryPercentage !== null &&
        mobileBatteryPercentage < lowBatteryThreshold &&
        heartbeat?.is_charging !== true,
      lastSeenAt: toIsoOrNull(heartbeat?.captured_at || worker.last_login_at || worker.updated_at),
    };
  });
  const workerById = new Map(workers.map((worker) => [worker.workerId, worker]));

  const tasks = tasksPlain.map((task) => {
    const dueAt = resolveTaskDueAt(task);
    const location = mapLocationForTask(task);
    const device = resolveDeviceForToilet(deviceMaps, task.toilet_unit_id, task.facility_id);
    const worker = task.assigned_to_user_id ? workerById.get(String(task.assigned_to_user_id)) : null;
    const latestAssignment = latestAssignmentByTaskId.get(String(task.id)) || null;
    return {
      taskId: task.id,
      complaintId: task.complaint_id || null,
      facilityId: task.facility_id || null,
      facilityName: task.Facility?.name || null,
      facilityCode: task.Facility?.code || null,
      toiletUnitId: task.toilet_unit_id || null,
      toiletUnitCode: task.ToiletUnit?.code || null,
      toiletLocationLabel: task.ToiletUnit?.location_label || null,
      title: task.title || 'Critical complaint response',
      description: task.description || task.complaint?.description || null,
      taskType: task.task_type,
      priority: task.priority || 'critical',
      status: task.status,
      statusLabel: mapTaskStatusForMap(task.status),
      assignedWorkerId: task.assigned_to_user_id || null,
      assignedWorkerName: task.assignee?.full_name || worker?.workerName || null,
      assignedAt: toIsoOrNull(task.created_at),
      dueAt,
      slaMinutes: task.sla_minutes || null,
      slaBreached: dueAt ? Date.now() > new Date(dueAt).getTime() : false,
      acceptedAt: toIsoOrNull(task.accepted_at),
      startedAt: toIsoOrNull(task.started_at),
      completedAt: toIsoOrNull(task.completed_at),
      assignmentSource: task.assignment_source || latestAssignment?.assignment_source || null,
      assignmentReason: task.assignment_reason || latestAssignment?.reason || null,
      distanceKm: toNumber(task.distance_km, null),
      criticalDetectedAt: toIsoOrNull(task.critical_detected_at),
      latitude: location.latitude,
      longitude: location.longitude,
      locationLabel: location.label,
      workerLocation: worker?.location || null,
      workerBatteryPercentage: worker?.mobileBatteryPercentage ?? null,
      device,
    };
  });
  const taskByComplaintId = new Map(
    tasks.filter((task) => task.complaintId).map((task) => [String(task.complaintId), task])
  );

  const complaints = complaintsPlain.map((complaint) => {
    const location = mapLocationForComplaint(complaint);
    const task = taskByComplaintId.get(String(complaint.id)) || null;
    const device = resolveDeviceForToilet(deviceMaps, complaint.toilet_unit_id, complaint.facility_id);
    return {
      complaintId: complaint.id,
      facilityId: complaint.facility_id || null,
      facilityName: complaint.Facility?.name || null,
      facilityCode: complaint.Facility?.code || null,
      toiletUnitId: complaint.toilet_unit_id || null,
      toiletUnitCode: complaint.ToiletUnit?.code || null,
      toiletLocationLabel: complaint.ToiletUnit?.location_label || null,
      priority: complaint.priority,
      status: complaint.status,
      complaintType: complaint.complaint_type,
      description: complaint.description,
      sourceChannel: complaint.source_channel,
      createdAt: toIsoOrNull(complaint.created_at),
      latitude: location.latitude,
      longitude: location.longitude,
      locationLabel: location.label,
      taskId: task?.taskId || null,
      taskStatus: task?.status || null,
      assignedWorkerId: task?.assignedWorkerId || complaint.assigned_to_user_id || null,
      assignedWorkerName: task?.assignedWorkerName || complaint.assignedTo?.full_name || null,
      device,
    };
  });

  const toiletRows = new Map();
  for (const complaint of complaints) {
    const key = String(complaint.toiletUnitId || complaint.facilityId || complaint.complaintId);
    toiletRows.set(key, {
      toiletUnitId: complaint.toiletUnitId,
      toiletUnitCode: complaint.toiletUnitCode,
      locationLabel: complaint.locationLabel || complaint.toiletLocationLabel,
      facilityId: complaint.facilityId,
      facilityName: complaint.facilityName,
      latitude: complaint.latitude,
      longitude: complaint.longitude,
      activeComplaint: complaint,
      task: complaint.taskId ? taskByComplaintId.get(String(complaint.complaintId)) || null : null,
      device: complaint.device,
    });
  }
  for (const task of tasks) {
    const key = String(task.toiletUnitId || task.facilityId || task.taskId);
    if (!toiletRows.has(key)) {
      toiletRows.set(key, {
        toiletUnitId: task.toiletUnitId,
        toiletUnitCode: task.toiletUnitCode,
        locationLabel: task.locationLabel || task.toiletLocationLabel,
        facilityId: task.facilityId,
        facilityName: task.facilityName,
        latitude: task.latitude,
        longitude: task.longitude,
        activeComplaint: task.complaintId ? complaints.find((item) => String(item.complaintId) === String(task.complaintId)) || null : null,
        task,
        device: task.device,
      });
    }
  }

  const summary = {
    criticalComplaints: complaints.length,
    activeTasks: tasks.length,
    assignedTasks: tasks.filter((task) => task.assignedWorkerId).length,
    unassignedTasks: tasks.filter((task) => !task.assignedWorkerId || task.status === 'unassigned').length,
    workersOnline: workers.filter((worker) => worker.currentStatus === 'Online').length,
    lowBatteryWorkers: workers.filter((worker) => worker.isLowBattery).length,
    staleLocationWorkers: workers.filter((worker) => worker.location?.isStale || !worker.location).length,
    slaBreachedTasks: tasks.filter((task) => task.slaBreached).length,
  };

  return {
    scope: summarizeSupervisorScopeForMap(scope),
    summary,
    workers,
    tasks,
    toilets: [...toiletRows.values()].filter((row) => row.latitude !== null && row.longitude !== null),
    complaints,
    config: emptyPayload.config,
  };
};

const getCheckins = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 1, maxDays: 31 });
  const rows = snapshot.workers.map((worker) => ({
    workerId: worker.workerId,
    workerName: worker.workerName,
    employeeCode: worker.employeeCode,
    assignedSupervisorId: worker.assignedSupervisorId,
    assignedSupervisorName: worker.assignedSupervisorName,
    checkInAt: worker.attendance.checkInAt,
    checkInLocation: worker.attendance.checkInLocation,
    checkInEvidenceUrl: null,
    checkOutAt: worker.attendance.checkOutAt,
    checkOutLocation: worker.attendance.checkOutLocation,
    checkOutEvidenceUrl: null,
    totalDurationMinutes: worker.attendance.totalWorkingMinutes,
    distanceFromAssignedLocationMeters:
      worker.exceptions.find((item) => item.type === 'outside_assigned_area')?.distanceMeters ?? null,
    exceptionFlags: worker.exceptions.map((item) => item.type),
    timeline: [...worker.attendance.checkInLogs, ...worker.attendance.checkOutLogs].sort(
      (left, right) => (toTimestamp(left.at) || 0) - (toTimestamp(right.at) || 0)
    ),
  }));
  return paginateArray(rows, req.query);
};

const getDeviceHealth = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 7, maxDays: 30 });
  let rows = snapshot.workers.map((worker) => ({
    workerId: worker.workerId,
    workerName: worker.workerName,
    employeeCode: worker.employeeCode,
    assignedSupervisorId: worker.assignedSupervisorId,
    assignedSupervisorName: worker.assignedSupervisorName,
    mobileBatteryPct: worker.phoneBatteryPct,
    sensorBatteryPct: worker.device.sensorBatteryPct,
    deviceId: worker.device.mobileDeviceId,
    sensorIds: worker.device.sensorIds,
    lastSyncAt: worker.device.lastSyncAt || worker.lastSeenAt,
    sensorLastSyncAt: worker.device.sensorLastSyncAt,
    appVersion: worker.device.appVersion,
    deviceOnlineStatus: worker.liveStatus === 'Offline' ? 'offline' : 'online',
    gpsPermissionStatus: worker.gpsPermissionStatus || 'Not available',
    networkStatus: worker.networkStatus || 'Not available',
    batteryWarningLevel:
      worker.phoneBatteryPct !== null && worker.phoneBatteryPct < LOW_BATTERY_PERCENT
        ? 'mobile_low'
        : worker.device.sensorBatteryPct !== null && worker.device.sensorBatteryPct < LOW_BATTERY_PERCENT
          ? 'sensor_low'
          : 'normal',
    exceptions: worker.exceptions.filter((item) =>
      ['low_mobile_battery', 'low_sensor_battery', 'worker_offline', 'no_gps_update'].includes(item.type)
    ),
  }));
  if (req.query.warning && String(req.query.warning).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.batteryWarningLevel || '').toLowerCase() === String(req.query.warning).toLowerCase());
  }
  if (req.query.online && String(req.query.online).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.deviceOnlineStatus || '').toLowerCase() === String(req.query.online).toLowerCase());
  }
  if (req.query.search) {
    rows = rows.filter((row) =>
      includesFilter(`${row.workerName} ${row.employeeCode || ''} ${row.deviceId || ''}`, req.query.search)
    );
  }
  return paginateArray(rows, req.query);
};

const getWorkProgress = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 7, maxDays: 90 });
  let rows = snapshot.workers.flatMap((worker) =>
    worker.tasks.map((task) => ({
      ...task,
      evidenceCount: worker.cleanliness.filter((item) => item.inspectionId && item.taskId === task.taskId).length,
      supervisorVerificationStatus: task.supervisorVerificationStatus,
    }))
  );
  if (req.query.status && String(req.query.status).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.status || '').toLowerCase() === String(req.query.status).toLowerCase());
  }
  if (req.query.workerId) {
    rows = rows.filter((row) => String(row.workerId) === String(req.query.workerId));
  }
  if (req.query.search) {
    rows = rows.filter((row) => includesFilter(`${row.workerName || ''} ${row.taskType || ''}`, req.query.search));
  }
  if (req.query.facility) {
    rows = rows.filter((row) => includesFilter(`${row.facilityName || ''} ${row.locationLabel || ''}`, req.query.facility));
  }
  return paginateArray(rows, req.query);
};

const getCleanliness = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 7, maxDays: 90 });
  let rows = snapshot.workers.flatMap((worker) => worker.cleanliness);
  if (req.query.status && String(req.query.status).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.cleanlinessStatus || '').toLowerCase() === String(req.query.status).toLowerCase());
  }
  if (req.query.search) {
    rows = rows.filter((row) => includesFilter(`${row.workerName || ''} ${row.locationLabel || ''}`, req.query.search));
  }
  if (req.query.facility) {
    rows = rows.filter((row) => includesFilter(`${row.facilityName || ''} ${row.locationLabel || ''}`, req.query.facility));
  }
  return paginateArray(rows, req.query);
};

const getAlerts = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 7, maxDays: 90 });
  let rows = snapshot.alerts;
  if (req.query.severity && String(req.query.severity).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.severity || '').toLowerCase() === String(req.query.severity).toLowerCase());
  }
  if (req.query.status && String(req.query.status).toLowerCase() !== 'all') {
    rows = rows.filter((row) => String(row.status || '').toLowerCase() === String(req.query.status).toLowerCase());
  }
  if (req.query.search) {
    rows = rows.filter((row) =>
      includesFilter(`${row.workerName || ''} ${row.facilityName || ''} ${row.alertType || ''} ${row.message || ''}`, req.query.search)
    );
  }
  return paginateArray(rows, req.query);
};

const getDailyReport = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 30, maxDays: 90 });
  const summary = summarizeSnapshot(snapshot);
  return {
    range: snapshot.range,
    summary,
    workers: snapshot.workers.map((worker) => ({
      workerId: worker.workerId,
      workerName: worker.workerName,
      assignedSupervisorId: worker.assignedSupervisorId,
      assignedSupervisorName: worker.assignedSupervisorName,
      attendanceStatus: worker.attendance.status,
      tasksAssigned: worker.productivity.tasksAssigned,
      tasksCompleted: worker.productivity.tasksCompleted,
      averageCompletionMinutes: worker.productivity.averageCompletionMinutes,
      attendancePercentage: worker.productivity.attendancePercentage,
      verificationPassRate: worker.productivity.verificationPassRate,
      repeatIssueCount: worker.productivity.repeatIssueCount,
      alerts: worker.exceptions.length + worker.alerts.length,
    })),
  };
};

const acknowledgeAlert = async (req) => {
  const snapshot = await buildSupervisorSnapshot(req, { defaultDays: 30, maxDays: 90 });
  const actualAlertIds = new Set(
    snapshot.alerts
      .filter((alert) => alert.source === 'backend_alert')
      .map((alert) => String(alert.id))
  );
  if (!actualAlertIds.has(String(req.params.alertId))) {
    throw new AppError('Alert not found in supervisor scope', 404, { code: 'ALERT_NOT_IN_SCOPE' });
  }
  const alert = await Alert.findByPk(req.params.alertId);
  if (!alert) {
    throw new AppError('Alert not found', 404, { code: 'ALERT_NOT_FOUND' });
  }
  await alert.update({
    status: 'acknowledged',
    acknowledged_at: alert.acknowledged_at || new Date(),
    assigned_to_user_id: alert.assigned_to_user_id || req.user.id,
    updated_at: new Date(),
  });
  await createAuditLog({
    req,
    tenantId: alert.tenant_id,
    action: 'supervisor.alert.acknowledge',
    entityType: 'alert',
    entityId: alert.id,
    details: {
      note: req.body?.note || null,
    },
  });
  return { id: alert.id, status: alert.status, acknowledgedAt: alert.acknowledged_at };
};

module.exports = {
  acknowledgeAlert,
  getAlerts,
  getAttendance,
  getCheckins,
  getCleanliness,
  getDailyReport,
  getDeviceHealth,
  getLiveMap,
  getLiveLocations,
  getOverview,
  getWorkerDetail,
  getWorkers,
  getWorkProgress,
};
