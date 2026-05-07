const { Op, fn, col, literal, QueryTypes } = require('sequelize');
const {
  sequelize,
  Facility,
  Inspection,
  InspectionMedia,
  AiAnalysisResult,
  Alert,
  SensorDevice,
  SensorReading,
  InspectionTask,
  Complaint,
  StorageUsageMetric,
  DashboardAggregate,
  PlatformUser,
  WorkerAssignment,
  UserRole,
  Role,
  ToiletUnit,
} = require('../../models');
const {
  EMPTY_SCOPE_UUID,
  buildAccessContextFromUser,
  applyScopeToQuery,
  uniqueIds,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');
const { ROLE_CODES } = require('../../core/rbac/personaFamilies');
const {
  resolveDateRange,
  applyDateRangeToWhere,
} = require('../../utils/dateRange');

const scopedTenantWhere = (req, where = {}, key = 'tenant_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'tenant', {
    tenantKey: key,
  });
};

const scopedFacilityWhere = (req, where = {}, facilityKey = 'facility_id', tenantKey = 'tenant_id') => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'facility', {
    tenantKey,
    facilityKey,
  });
};

const scopedFacilityEntityWhere = (req, where = {}) => {
  return applyScopeToQuery(where, buildAccessContextFromUser(req?.user || {}), 'facility', {
    tenantKey: 'tenant_id',
    geographyKey: 'geography_id',
    facilityKey: 'id',
  });
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toTimestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
};

const toIsoOrNull = (value) => {
  const time = toTimestamp(value);
  return time == null ? null : new Date(time).toISOString();
};

const pickEarlierIso = (left, right) => {
  if (!left) return right || null;
  if (!right) return left || null;
  return toTimestamp(left) <= toTimestamp(right) ? left : right;
};

const pickLaterIso = (left, right) => {
  if (!left) return right || null;
  if (!right) return left || null;
  return toTimestamp(left) >= toTimestamp(right) ? left : right;
};

const isOnOrAfter = (isoValue, thresholdDate) => {
  const ts = toTimestamp(isoValue);
  const threshold = toTimestamp(thresholdDate);
  if (ts == null || threshold == null) return false;
  return ts >= threshold;
};

const getOverview = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const tenantFilter = scopedTenantWhere(req);
  const facilityEntityFilter = scopedFacilityEntityWhere(req);
  const inspectionTenantFilter = scopedFacilityWhere(req);
  const alertTenantFilter = scopedFacilityWhere(req);
  const taskTenantFilter = scopedFacilityWhere(req);
  const complaintTenantFilter = scopedFacilityWhere(req);
  const sensorTenantFilter = scopedFacilityWhere(req);
  const userScopeFilter = applyScopeToQuery(
    { ...tenantFilter },
    buildAccessContextFromUser(req?.user || {}),
    'geography',
    { tenantKey: 'tenant_id', geographyKey: 'geography_id' },
  );

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const inspectionActivityFilter = dateRange.provided
    ? applyDateRangeToWhere(inspectionTenantFilter, 'captured_at', dateRange)
    : { ...inspectionTenantFilter, created_at: { [Op.gte]: todayStart } };
  const analysisInspectionFilter = dateRange.provided
    ? applyDateRangeToWhere(inspectionTenantFilter, 'captured_at', dateRange)
    : inspectionTenantFilter;
  const alertActivityFilter = dateRange.provided
    ? applyDateRangeToWhere(alertTenantFilter, 'created_at', dateRange)
    : alertTenantFilter;
  const complaintActivityFilter = dateRange.provided
    ? applyDateRangeToWhere(complaintTenantFilter, 'created_at', dateRange)
    : complaintTenantFilter;
  const taskActivityFilter = dateRange.provided
    ? applyDateRangeToWhere(taskTenantFilter, 'scheduled_at', dateRange)
    : taskTenantFilter;

  const [
    totalFacilities,
    activeAlerts,
    inspectionsInRange,
    avgCleanlinessRow,
    sensorsOnline,
    totalSensors,
    openComplaints,
    tasksInProgress,
    usersActive,
  ] = await Promise.all([
    Facility.count({ where: facilityEntityFilter }),
    Alert.count({ where: { ...alertActivityFilter, status: { [Op.in]: ['open', 'acknowledged'] } } }),
    Inspection.count({ where: inspectionActivityFilter }),
    AiAnalysisResult.findOne({
      attributes: [[fn('AVG', col('cleanliness_score')), 'avgCleanliness']],
      include: [
        {
          model: Inspection,
          attributes: [],
          required: true,
          where: analysisInspectionFilter,
        },
      ],
      raw: true,
    }),
    SensorDevice.count({ where: { ...sensorTenantFilter, status: 'active' } }),
    SensorDevice.count({ where: sensorTenantFilter }),
    Complaint.count({ where: { ...complaintActivityFilter, status: { [Op.ne]: 'resolved' } } }),
    InspectionTask.count({ where: { ...taskActivityFilter, status: 'in_progress' } }),
    PlatformUser.count({ where: { ...userScopeFilter, status: 'active' } }),
  ]);

  return {
    totalFacilities,
    activeAlerts,
    inspectionsCompletedToday: inspectionsInRange,
    inspectionsInRange,
    cleanlinessAverage: Number(toNumber(avgCleanlinessRow?.avgCleanliness, 0).toFixed(2)),
    sensorHealth: {
      online: sensorsOnline,
      total: totalSensors,
      onlinePercent: totalSensors === 0 ? 0 : Number(((sensorsOnline / totalSensors) * 100).toFixed(2)),
    },
    openComplaints,
    workerProductivity: {
      tasksInProgress,
      activeUsers: usersActive,
    },
    dateRange: {
      range: dateRange.range,
      label: dateRange.label,
      days: dateRange.days,
      start: dateRange.start ? dateRange.start.toISOString() : null,
      end: dateRange.end ? dateRange.end.toISOString() : null,
    },
  };
};

const getMap = async (req) => {
  const facilities = await Facility.findAll({
    where: scopedFacilityEntityWhere(req),
    order: [['name', 'ASC']],
  });

  const facilityIds = facilities.map((facility) => facility.id);
  const latestAnalysisByFacility = {};

  if (facilityIds.length > 0) {
    const inspections = await Inspection.findAll({
      where: { facility_id: { [Op.in]: facilityIds } },
      include: [{ model: AiAnalysisResult }],
      order: [['captured_at', 'DESC']],
    });
    inspections.forEach((inspection) => {
      if (latestAnalysisByFacility[inspection.facility_id]) return;
      const analysis = (inspection.AiAnalysisResults || [])[0];
      if (analysis) {
        latestAnalysisByFacility[inspection.facility_id] = analysis;
      }
    });
  }

  return facilities.map((facility) => {
    const analysis = latestAnalysisByFacility[facility.id];
    return {
      facilityId: facility.id,
      facilityCode: facility.code,
      facilityName: facility.name,
      latitude: toNumber(facility.latitude, null),
      longitude: toNumber(facility.longitude, null),
      cleanlinessScore: analysis ? Number(analysis.cleanliness_score) : null,
      hygieneScore: analysis ? Number(analysis.hygiene_score) : null,
      facilityType: facility.facility_type,
      status: facility.status,
    };
  });
};

const getHeatmap = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const north = toNumber(req.query.north, null);
  const south = toNumber(req.query.south, null);
  const east = toNumber(req.query.east, null);
  const west = toNumber(req.query.west, null);
  const where = applyDateRangeToWhere(
    {
      ...scopedFacilityWhere(req),
      latitude: Number.isFinite(south) && Number.isFinite(north)
        ? { [Op.between]: [Math.min(south, north), Math.max(south, north)] }
        : { [Op.ne]: null },
      longitude: Number.isFinite(west) && Number.isFinite(east)
        ? { [Op.between]: [Math.min(west, east), Math.max(west, east)] }
        : { [Op.ne]: null },
    },
    'captured_at',
    dateRange,
  );

  const inspections = await Inspection.findAll({
    where,
    include: [{ model: AiAnalysisResult }],
    order: [['captured_at', 'DESC']],
    limit: Number(req.query.limit || 500),
  });

  const severity = String(req.query.severity || 'all').trim().toLowerCase();
  const matchesSeverity = (score) => {
    if (!severity || severity === 'all') return true;
    if (severity === 'critical') return score < 55;
    if (severity === 'warning' || severity === 'moderate') return score >= 55 && score < 75;
    if (severity === 'good' || severity === 'clean') return score >= 75;
    return true;
  };

  return inspections.map((inspection) => ({
    inspectionId: inspection.id,
    facilityId: inspection.facility_id,
    latitude: toNumber(inspection.latitude, null),
    longitude: toNumber(inspection.longitude, null),
    avgScore: toNumber(inspection.AiAnalysisResults?.[0]?.cleanliness_score, 0),
    count: 1,
    label: inspection.overall_status || inspection.processing_status,
  })).filter((point) => matchesSeverity(toNumber(point.avgScore, 0)));
};

const getFacilityDashboard = async (req) => {
  const facilityId = req.params.id;
  const facility = await Facility.findByPk(facilityId);
  if (!facility) return null;
  if (!req.user.isSuperAdmin && facility.tenant_id !== req.user.tenantId) return null;
  if (!isFacilityInScope(req, facility.id)) return null;

  const [inspections, alerts, tasks, complaints] = await Promise.all([
    Inspection.findAll({
      where: scopedFacilityWhere(req, { facility_id: facilityId }),
      include: [{ model: AiAnalysisResult }, { model: InspectionMedia }],
      order: [['captured_at', 'DESC']],
      limit: 20,
    }),
    Alert.findAll({
      where: scopedFacilityWhere(req, { facility_id: facilityId }),
      order: [['created_at', 'DESC']],
      limit: 30,
    }),
    InspectionTask.findAll({
      where: scopedFacilityWhere(req, { facility_id: facilityId }),
      order: [['scheduled_at', 'DESC']],
      limit: 20,
    }),
    Complaint.findAll({
      where: scopedFacilityWhere(req, { facility_id: facilityId }),
      order: [['created_at', 'DESC']],
      limit: 20,
    }),
  ]);

  return {
    facility: {
      id: facility.id,
      code: facility.code,
      name: facility.name,
      addressLine: facility.address_line,
      latitude: toNumber(facility.latitude, null),
      longitude: toNumber(facility.longitude, null),
      status: facility.status,
    },
    inspections: inspections.map((item) => {
      const media = Array.isArray(item.InspectionMedia) ? item.InspectionMedia : [];
      const beforeMediaCount = media.filter((m) => m.capture_stage === 'before').length;
      const afterMediaCount = media.filter((m) => m.capture_stage === 'after').length;
      return {
        id: item.id,
        capturedAt: item.captured_at,
        processingStatus: item.processing_status,
        pipelineStatus: item.pipeline_status || item.processing_status,
        overallStatus: item.overall_status,
        cleanlinessScore: toNumber(item.AiAnalysisResults?.[0]?.cleanliness_score, null),
        beforeMediaCount,
        afterMediaCount,
        totalMediaCount: media.length,
        reviewRequired: Boolean(item.review_required),
      };
    }),
    alerts: alerts.map((alert) => ({
      id: alert.id,
      message: alert.message,
      severity: alert.severity,
      status: alert.status,
      createdAt: alert.created_at,
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      taskType: task.task_type,
      status: task.status,
      scheduledAt: task.scheduled_at,
      completedAt: task.completed_at,
    })),
    complaints: complaints.map((complaint) => ({
      id: complaint.id,
      complaintType: complaint.complaint_type,
      status: complaint.status,
      priority: complaint.priority,
      createdAt: complaint.created_at,
    })),
  };
};

const getTrends = async (req) => {
  const dateRange = resolveDateRange(req.query, { defaultDays: 14, maxDays: 90 });
  const days = dateRange.days || 14;
  const start = dateRange.start || new Date();
  start.setHours(0, 0, 0, 0);

  const replacements = {
    start,
  };
  let tenantClause = '';
  let facilityClause = '';
  if (!req.user.isSuperAdmin) {
    replacements.tenantId = req.user.tenantId;
    tenantClause = 'AND i.tenant_id = :tenantId';
  } else if (req.query.tenantId) {
    replacements.tenantId = req.query.tenantId;
    tenantClause = 'AND i.tenant_id = :tenantId';
  }
  const scopedFacilityIds = uniqueIds(req.user?.scopeFacilityIds || []);
  if (!req.user.isSuperAdmin && scopedFacilityIds.length > 0) {
    replacements.scopeFacilityIds = scopedFacilityIds;
    facilityClause = 'AND i.facility_id IN (:scopeFacilityIds)';
  } else if (!req.user.isSuperAdmin && req.user?.scopeLevel === 'facility') {
    replacements.scopeFacilityIds = [EMPTY_SCOPE_UUID];
    facilityClause = 'AND i.facility_id IN (:scopeFacilityIds)';
  }

  const rows = await sequelize.query(
    `
      SELECT
        DATE(i.captured_at) AS label,
        COUNT(i.id)::int AS "inspectionCount",
        COALESCE(AVG(a.cleanliness_score), 0)::numeric AS "avgCleanliness"
      FROM inspections i
      LEFT JOIN ai_analysis_results a ON a.inspection_id = i.id
      WHERE i.captured_at >= :start
        ${tenantClause}
        ${facilityClause}
      GROUP BY DATE(i.captured_at)
      ORDER BY DATE(i.captured_at) ASC
    `,
    {
      replacements,
      type: QueryTypes.SELECT,
    }
  );

  const map = new Map(rows.map((row) => [String(row.label), row]));
  const points = [];
  for (let i = 0; i < days; i += 1) {
    const current = new Date(start);
    current.setDate(start.getDate() + i);
    const label = current.toISOString().slice(0, 10);
    const row = map.get(label);
    points.push({
      label,
      inspectionCount: Number(row?.inspectionCount || 0),
      cleanlinessAverage: Number(toNumber(row?.avgCleanliness, 0).toFixed(2)),
    });
  }
  return points;
};

const getWorkforce = async (req) => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const lookbackRaw = Number(req.query.activityDays || 7);
  const activityLookbackDays = Number.isFinite(lookbackRaw)
    ? Math.min(Math.max(lookbackRaw, 1), 30)
    : 7;
  const requestedRange = resolveDateRange(req.query, { maxDays: 30 });
  const activityStart = requestedRange.start || new Date(todayStart);
  if (!requestedRange.start) {
    activityStart.setDate(activityStart.getDate() - (activityLookbackDays - 1));
  }
  const scopedTaskWhere = requestedRange.provided
    ? applyDateRangeToWhere(scopedFacilityWhere(req), 'scheduled_at', requestedRange)
    : scopedFacilityWhere(req);

  const scopedTaskRows = await InspectionTask.findAll({
    where: scopedTaskWhere,
    attributes: [
      'assigned_to_user_id',
      'facility_id',
      'toilet_unit_id',
      'status',
      'scheduled_at',
      'started_at',
      'completed_at',
      'created_at',
    ],
    raw: true,
  });

  const assignmentScopeWhere = applyScopeToQuery(
    scopedTenantWhere(req, { status: 'active' }),
    buildAccessContextFromUser(req?.user || {}),
    'audit',
    {
      tenantKey: 'tenant_id',
      geographyKey: 'geography_id',
      facilityKey: 'facility_id',
    },
  );
  const scopedAssignmentRows = await WorkerAssignment.findAll({
    where: assignmentScopeWhere,
    attributes: ['user_id', 'geography_id', 'facility_id', 'toilet_unit_id'],
    raw: true,
  });

  const taskWorkerIds = uniqueIds(scopedTaskRows.map((row) => row.assigned_to_user_id));
  const assignmentWorkerIds = uniqueIds(scopedAssignmentRows.map((row) => row.user_id));
  const candidateWorkerIds = uniqueIds([...taskWorkerIds, ...assignmentWorkerIds]);
  if (candidateWorkerIds.length === 0) return [];

  const fieldWorkerRole = await Role.findOne({
    where: { code: ROLE_CODES.FIELD_WORKER },
    attributes: ['id'],
    raw: true,
  });
  if (!fieldWorkerRole?.id) return [];

  const fieldWorkerRoleRows = await UserRole.findAll({
    where: {
      ...scopedTenantWhere(req, { role_id: fieldWorkerRole.id }, 'tenant_id'),
      user_id: { [Op.in]: candidateWorkerIds },
    },
    attributes: ['user_id'],
    raw: true,
  });
  const scopedWorkerIds = uniqueIds(fieldWorkerRoleRows.map((row) => row.user_id));
  if (scopedWorkerIds.length === 0) return [];

  const workerRows = await PlatformUser.findAll({
    where: {
      id: { [Op.in]: scopedWorkerIds },
      status: 'active',
    },
    attributes: ['id', 'full_name', 'employee_code', 'metadata', 'updated_at'],
    raw: true,
  });
  if (workerRows.length === 0) return [];

  const activeWorkerIds = uniqueIds(workerRows.map((row) => row.id));
  const activeWorkerIdSet = new Set(activeWorkerIds.map((id) => String(id)));

  const assignmentRows = scopedAssignmentRows.filter((row) =>
    activeWorkerIdSet.has(String(row.user_id || ''))
  );
  const taskRows = scopedTaskRows.filter((row) =>
    activeWorkerIdSet.has(String(row.assigned_to_user_id || ''))
  );

  const assignmentToiletUnitIds = uniqueIds(assignmentRows.map((row) => row.toilet_unit_id));
  const assignmentToiletUnitRows =
    assignmentToiletUnitIds.length > 0
      ? await ToiletUnit.findAll({
          where: { id: { [Op.in]: assignmentToiletUnitIds } },
          attributes: ['id', 'facility_id', 'location_label'],
          raw: true,
        })
      : [];
  const assignmentToiletUnitById = new Map(
    assignmentToiletUnitRows.map((row) => [String(row.id), row])
  );

  const isSupervisorActor = (Array.isArray(req.user?.roleCodes) ? req.user.roleCodes : []).includes(
    ROLE_CODES.SUPERVISOR
  );

  const workforceByWorkerId = new Map();
  for (const worker of workerRows) {
    const workerId = String(worker.id);
    workforceByWorkerId.set(workerId, {
      workerId,
      workerName: worker.full_name || `Worker-${workerId.slice(0, 6).toUpperCase()}`,
      employeeCode: worker.employee_code || null,
      phoneBatteryPct: toNumber(
        worker?.metadata?.phoneBatteryPct ??
          worker?.metadata?.batteryPct ??
          worker?.metadata?.deviceBatteryPct,
        null
      ),
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      averageCompletionAccumulator: 0,
      checkInLogs: [],
      checkOutLogs: [],
      locationTrail: [],
      facilityIds: new Set(),
      lastSeenAt: toIsoOrNull(worker.updated_at),
      latestLocationPoint: null,
      firstInspectionTodayAt: null,
      assignedToSupervisor: Boolean(isSupervisorActor),
      supervisorId: isSupervisorActor ? req.user.id : null,
    });
  }

  for (const assignment of assignmentRows) {
    const workerId = String(assignment.user_id || '');
    const row = workforceByWorkerId.get(workerId);
    if (!row) continue;
    if (assignment.facility_id) {
      row.facilityIds.add(String(assignment.facility_id));
    } else if (assignment.toilet_unit_id) {
      const toiletUnit = assignmentToiletUnitById.get(String(assignment.toilet_unit_id));
      if (toiletUnit?.facility_id) {
        row.facilityIds.add(String(toiletUnit.facility_id));
      }
    }
  }

  for (const task of taskRows) {
    const workerId = String(task.assigned_to_user_id || '');
    const row = workforceByWorkerId.get(workerId);
    if (!row) continue;

    row.totalTasks += 1;
    if (task.status === 'completed') {
      row.completedTasks += 1;
      const completedAtTs = toTimestamp(task.completed_at);
      const createdAtTs = toTimestamp(task.created_at);
      if (completedAtTs != null && createdAtTs != null) {
        row.averageCompletionAccumulator += Math.max(0, (completedAtTs - createdAtTs) / 60000);
      }
    } else if (task.status === 'in_progress') {
      row.inProgressTasks += 1;
    }

    if (task.facility_id) {
      row.facilityIds.add(String(task.facility_id));
    }

    const startedAt = toIsoOrNull(task.started_at);
    if (startedAt && isOnOrAfter(startedAt, todayStart)) {
      row.checkInLogs.push({
        at: startedAt,
        source: 'task_start',
        facilityId: task.facility_id || null,
        toiletUnitId: task.toilet_unit_id || null,
      });
    }

    const completedAt = toIsoOrNull(task.completed_at);
    if (completedAt && isOnOrAfter(completedAt, todayStart)) {
      row.checkOutLogs.push({
        at: completedAt,
        source: 'task_complete',
        facilityId: task.facility_id || null,
        toiletUnitId: task.toilet_unit_id || null,
      });
    }

    const activityAt =
      completedAt ||
      startedAt ||
      toIsoOrNull(task.created_at) ||
      toIsoOrNull(task.scheduled_at) ||
      null;
    row.lastSeenAt = pickLaterIso(row.lastSeenAt, activityAt);
  }

  const inspectionRows = await Inspection.findAll({
    where: scopedFacilityWhere(req, {
      inspector_user_id: { [Op.in]: activeWorkerIds },
      captured_at: { [Op.gte]: activityStart },
    }),
    attributes: [
      'id',
      'inspector_user_id',
      'facility_id',
      'toilet_unit_id',
      'latitude',
      'longitude',
      'captured_at',
      'submitted_at',
      'created_at',
    ],
    include: [
      {
        model: Facility,
        attributes: ['id', 'name', 'address_line'],
      },
      {
        model: ToiletUnit,
        attributes: ['id', 'code', 'location_label'],
      },
    ],
    order: [['captured_at', 'DESC']],
  });

  for (const inspection of inspectionRows) {
    const workerId = String(inspection.inspector_user_id || '');
    const row = workforceByWorkerId.get(workerId);
    if (!row) continue;

    const eventAt = toIsoOrNull(
      inspection.submitted_at || inspection.captured_at || inspection.created_at
    );
    if (!eventAt) continue;

    const lat = toNumber(inspection.latitude, null);
    const lng = toNumber(inspection.longitude, null);
    const locationLabel =
      inspection.ToiletUnit?.location_label ||
      inspection.Facility?.name ||
      inspection.Facility?.address_line ||
      null;

    const point = {
      at: eventAt,
      source: 'inspection',
      inspectionId: inspection.id,
      facilityId: inspection.facility_id || null,
      facilityName: inspection.Facility?.name || null,
      toiletUnitId: inspection.toilet_unit_id || null,
      toiletUnitCode: inspection.ToiletUnit?.code || null,
      locationLabel,
      gpsLat: lat,
      gpsLng: lng,
    };

    if (
      !row.latestLocationPoint ||
      toTimestamp(point.at) > toTimestamp(row.latestLocationPoint.at)
    ) {
      row.latestLocationPoint = point;
    }

    if (inspection.facility_id) {
      row.facilityIds.add(String(inspection.facility_id));
    }

    row.lastSeenAt = pickLaterIso(row.lastSeenAt, point.at);

    if (isOnOrAfter(point.at, todayStart)) {
      row.locationTrail.push(point);
      row.firstInspectionTodayAt = pickEarlierIso(row.firstInspectionTodayAt, point.at);
    }
  }

  for (const row of workforceByWorkerId.values()) {
    if (row.checkInLogs.length === 0 && row.firstInspectionTodayAt) {
      row.checkInLogs.push({
        at: row.firstInspectionTodayAt,
        source: 'inspection_capture',
        facilityId: row.latestLocationPoint?.facilityId || null,
        toiletUnitId: row.latestLocationPoint?.toiletUnitId || null,
        locationLabel: row.latestLocationPoint?.locationLabel || null,
        gpsLat: row.latestLocationPoint?.gpsLat ?? null,
        gpsLng: row.latestLocationPoint?.gpsLng ?? null,
      });
    }
  }

  const allFacilityIds = uniqueIds(
    [...workforceByWorkerId.values()].flatMap((row) => [...row.facilityIds.values()])
  );

  const facilityRows =
    allFacilityIds.length > 0
      ? await Facility.findAll({
          where: { id: { [Op.in]: allFacilityIds } },
          attributes: ['id', 'name', 'address_line'],
          raw: true,
        })
      : [];
  const facilityById = new Map(facilityRows.map((row) => [String(row.id), row]));

  const sensorRows =
    allFacilityIds.length > 0
      ? await SensorDevice.findAll({
          where: scopedFacilityWhere(req, {
            facility_id: { [Op.in]: allFacilityIds },
          }),
          attributes: ['facility_id', 'status'],
          raw: true,
        })
      : [];

  const sensorByFacilityId = new Map();
  for (const sensor of sensorRows) {
    const facilityId = String(sensor.facility_id || '');
    if (!facilityId) continue;
    const bucket = sensorByFacilityId.get(facilityId) || { total: 0, online: 0, offline: 0 };
    bucket.total += 1;
    if (sensor.status === 'active') {
      bucket.online += 1;
    } else {
      bucket.offline += 1;
    }
    sensorByFacilityId.set(facilityId, bucket);
  }

  const results = [];
  const nowIso = new Date().toISOString();

  for (const row of workforceByWorkerId.values()) {
    const checkInLogs = row.checkInLogs
      .filter((entry) => Boolean(entry?.at))
      .sort((left, right) => toTimestamp(left.at) - toTimestamp(right.at));
    const checkOutLogs = row.checkOutLogs
      .filter((entry) => Boolean(entry?.at))
      .sort((left, right) => toTimestamp(left.at) - toTimestamp(right.at));
    const locationTrail = row.locationTrail
      .filter((entry) => Boolean(entry?.at))
      .sort((left, right) => toTimestamp(right.at) - toTimestamp(left.at))
      .slice(0, 25);

    const checkInAt = checkInLogs[0]?.at || null;
    const checkOutAt = checkOutLogs[checkOutLogs.length - 1]?.at || null;

    let attendanceStatus = 'Absent';
    if (checkOutAt) {
      attendanceStatus = 'Checked out';
    } else if (checkInAt || row.inProgressTasks > 0 || locationTrail.length > 0) {
      attendanceStatus = 'Present';
    }

    const shiftStartTs = toTimestamp(checkInAt);
    const shiftEndTs = toTimestamp(checkOutAt || nowIso);
    const workingMinutes =
      shiftStartTs != null && shiftEndTs != null
        ? Math.max(0, Math.round((shiftEndTs - shiftStartTs) / 60000))
        : 0;

    const workerFacilityIds = [...row.facilityIds.values()];
    const sensorTotals = workerFacilityIds.reduce(
      (acc, facilityId) => {
        const current = sensorByFacilityId.get(String(facilityId));
        if (!current) return acc;
        acc.total += current.total;
        acc.online += current.online;
        acc.offline += current.offline;
        return acc;
      },
      { total: 0, online: 0, offline: 0 }
    );

    const fallbackFacility = facilityById.get(String(workerFacilityIds[0] || '')) || null;
    const locationLabel =
      row.latestLocationPoint?.locationLabel ||
      fallbackFacility?.name ||
      fallbackFacility?.address_line ||
      null;

    results.push({
      workerId: row.workerId,
      workerName: row.workerName,
      employeeCode: row.employeeCode,
      attendanceStatus,
      checkInAt,
      checkOutAt,
      checkInLogs: checkInLogs.slice(0, 25),
      checkOutLogs: checkOutLogs.slice(0, 25),
      totalTasks: row.totalTasks,
      completedTasks: row.completedTasks,
      inProgressTasks: row.inProgressTasks,
      averageCompletionMinutes:
        row.completedTasks > 0
          ? Number((row.averageCompletionAccumulator / row.completedTasks).toFixed(2))
          : 0,
      workingMinutes,
      workingHours: Number((workingMinutes / 60).toFixed(2)),
      phoneBatteryPct: row.phoneBatteryPct,
      sensorTotal: workerFacilityIds.length > 0 ? sensorTotals.total : null,
      sensorOnline: workerFacilityIds.length > 0 ? sensorTotals.online : null,
      sensorOffline: workerFacilityIds.length > 0 ? sensorTotals.offline : null,
      gpsLat: row.latestLocationPoint?.gpsLat ?? null,
      gpsLng: row.latestLocationPoint?.gpsLng ?? null,
      locationLabel,
      locationTrail,
      lastSeenAt: row.lastSeenAt || checkOutAt || checkInAt || null,
      assignedToSupervisor: row.assignedToSupervisor,
      supervisorId: row.supervisorId,
      facilityIds: workerFacilityIds,
      facilityCount: workerFacilityIds.length,
      currentLocation: row.latestLocationPoint || null,
    });
  }

  return results.sort((left, right) =>
    String(left.workerName || left.workerId || '').localeCompare(
      String(right.workerName || right.workerId || '')
    )
  );
};

const getSla = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const tasks = await InspectionTask.findAll({
    where: dateRange.provided
      ? applyDateRangeToWhere(scopedFacilityWhere(req), 'scheduled_at', dateRange)
      : scopedFacilityWhere(req),
    order: [['scheduled_at', 'DESC']],
    limit: 500,
  });

  const now = Date.now();
  let breached = 0;
  let onTrack = 0;
  const breachedList = [];
  for (const task of tasks) {
    if (!task.sla_minutes) continue;
    const dueAt = new Date(task.scheduled_at).getTime() + task.sla_minutes * 60000;
    const isBreached = task.status !== 'completed' && now > dueAt;
    if (isBreached) {
      breached += 1;
      breachedList.push({
        taskId: task.id,
        scheduledAt: task.scheduled_at,
        slaMinutes: task.sla_minutes,
        status: task.status,
      });
    } else {
      onTrack += 1;
    }
  }

  return {
    breached,
    onTrack,
    totalTracked: breached + onTrack,
    breachedList: breachedList.slice(0, 100),
  };
};

const getStorageUsage = async (req) => {
  const rows = await StorageUsageMetric.findAll({
    where: scopedTenantWhere(req),
    order: [['measured_at', 'DESC']],
    limit: Number(req.query.limit || 30),
  });
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    bucketName: row.bucket_name,
    usedBytes: Number(row.used_bytes),
    objectCount: Number(row.object_count),
    measuredAt: row.measured_at,
  }));
};

const getPlatformHealth = async (req) => {
  const dateRange = resolveDateRange(req.query, { maxDays: 90 });
  const latestAggregate = await DashboardAggregate.findOne({
    where: scopedTenantWhere(req),
    order: [['aggregate_date', 'DESC']],
  });

  const [alerts, sensorsFaulty] = await Promise.all([
    Alert.count({
      where: {
        ...(dateRange.provided
          ? applyDateRangeToWhere(scopedFacilityWhere(req), 'created_at', dateRange)
          : scopedFacilityWhere(req)),
        status: 'open',
      },
    }),
    SensorDevice.count({
      where: {
        ...scopedFacilityWhere(req),
        status: 'faulty',
      },
    }),
  ]);

  return {
    openAlerts: alerts,
    faultySensors: sensorsFaulty,
    latestAggregateDate: latestAggregate?.aggregate_date || null,
    latestAggregateMetrics: latestAggregate?.metrics || null,
  };
};

const getContractorPerformance = async (req) => {
  // Contractor mapping is not a first-class table yet; derive from facility metadata.
  const facilities = await Facility.findAll({
    where: scopedFacilityEntityWhere(req),
    attributes: ['id', 'metadata'],
  });
  const byContractor = {};
  facilities.forEach((facility) => {
    const contractor = facility.metadata?.contractor || 'Unknown Contractor';
    byContractor[contractor] = byContractor[contractor] || { contractor, facilities: 0 };
    byContractor[contractor].facilities += 1;
  });
  return Object.values(byContractor);
};

module.exports = {
  getOverview,
  getMap,
  getHeatmap,
  getFacilityDashboard,
  getTrends,
  getWorkforce,
  getSla,
  getStorageUsage,
  getPlatformHealth,
  getContractorPerformance,
};
