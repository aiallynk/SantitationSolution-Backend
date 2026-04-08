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
} = require('../../models');
const {
  EMPTY_SCOPE_UUID,
  applyTenantScope,
  applyGeographyScope,
  applyFacilityScope,
  uniqueIds,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');

const scopedTenantWhere = (req, where = {}, key = 'tenant_id') => {
  return applyTenantScope(where, req, key);
};

const scopedFacilityWhere = (req, where = {}, facilityKey = 'facility_id', tenantKey = 'tenant_id') => {
  let next = scopedTenantWhere(req, where, tenantKey);
  next = applyFacilityScope(next, req, facilityKey);
  return next;
};

const scopedFacilityEntityWhere = (req, where = {}) => {
  let next = scopedTenantWhere(req, where);
  next = applyGeographyScope(next, req, 'geography_id');

  if (req.user?.isSuperAdmin) return next;

  const facilityIds = uniqueIds(req.user?.scopeFacilityIds || []);
  if (facilityIds.length > 0) {
    next.id = { [Op.in]: facilityIds };
  } else if (req.user?.scopeLevel === 'facility') {
    next.id = EMPTY_SCOPE_UUID;
  }

  return next;
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getOverview = async (req) => {
  const tenantFilter = scopedTenantWhere(req);
  const facilityEntityFilter = scopedFacilityEntityWhere(req);
  const inspectionTenantFilter = scopedFacilityWhere(req);
  const alertTenantFilter = scopedFacilityWhere(req);
  const taskTenantFilter = scopedFacilityWhere(req);
  const complaintTenantFilter = scopedFacilityWhere(req);
  const sensorTenantFilter = scopedFacilityWhere(req);
  const userScopeFilter = applyGeographyScope({ ...tenantFilter }, req, 'geography_id');

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    totalFacilities,
    activeAlerts,
    inspectionsToday,
    avgCleanlinessRow,
    sensorsOnline,
    totalSensors,
    openComplaints,
    tasksInProgress,
    usersActive,
  ] = await Promise.all([
    Facility.count({ where: facilityEntityFilter }),
    Alert.count({ where: { ...alertTenantFilter, status: { [Op.in]: ['open', 'acknowledged'] } } }),
    Inspection.count({
      where: {
        ...inspectionTenantFilter,
        created_at: { [Op.gte]: todayStart },
      },
    }),
    AiAnalysisResult.findOne({
      attributes: [[fn('AVG', col('cleanliness_score')), 'avgCleanliness']],
      include: [
        {
          model: Inspection,
          attributes: [],
          required: true,
          where: inspectionTenantFilter,
        },
      ],
      raw: true,
    }),
    SensorDevice.count({ where: { ...sensorTenantFilter, status: 'active' } }),
    SensorDevice.count({ where: sensorTenantFilter }),
    Complaint.count({ where: { ...complaintTenantFilter, status: { [Op.ne]: 'resolved' } } }),
    InspectionTask.count({ where: { ...taskTenantFilter, status: 'in_progress' } }),
    PlatformUser.count({ where: { ...userScopeFilter, status: 'active' } }),
  ]);

  return {
    totalFacilities,
    activeAlerts,
    inspectionsCompletedToday: inspectionsToday,
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
  const inspections = await Inspection.findAll({
    where: {
      ...scopedFacilityWhere(req),
      latitude: { [Op.ne]: null },
      longitude: { [Op.ne]: null },
    },
    include: [{ model: AiAnalysisResult }],
    order: [['captured_at', 'DESC']],
    limit: Number(req.query.limit || 500),
  });

  return inspections.map((inspection) => ({
    inspectionId: inspection.id,
    facilityId: inspection.facility_id,
    latitude: toNumber(inspection.latitude, null),
    longitude: toNumber(inspection.longitude, null),
    avgScore: toNumber(inspection.AiAnalysisResults?.[0]?.cleanliness_score, 0),
    count: 1,
    label: inspection.overall_status || inspection.processing_status,
  }));
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
  const days = Math.min(Number(req.query.days || 14), 90);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));

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
  const tasks = await InspectionTask.findAll({
    where: scopedFacilityWhere(req),
    attributes: ['assigned_to_user_id', 'status', 'completed_at', 'created_at'],
  });

  const byWorker = {};
  for (const task of tasks) {
    if (!byWorker[task.assigned_to_user_id]) {
      byWorker[task.assigned_to_user_id] = {
        workerId: task.assigned_to_user_id,
        totalTasks: 0,
        completedTasks: 0,
        inProgressTasks: 0,
        averageCompletionMinutes: 0,
      };
    }
    const row = byWorker[task.assigned_to_user_id];
    row.totalTasks += 1;
    if (task.status === 'completed') {
      row.completedTasks += 1;
      if (task.completed_at && task.created_at) {
        const durationMinutes =
          (new Date(task.completed_at).getTime() - new Date(task.created_at).getTime()) / 60000;
        row.averageCompletionMinutes += Math.max(0, durationMinutes);
      }
    } else if (task.status === 'in_progress') {
      row.inProgressTasks += 1;
    }
  }
  return Object.values(byWorker).map((row) => ({
    ...row,
    averageCompletionMinutes:
      row.completedTasks > 0 ? Number((row.averageCompletionMinutes / row.completedTasks).toFixed(2)) : 0,
  }));
};

const getSla = async (req) => {
  const tasks = await InspectionTask.findAll({
    where: scopedFacilityWhere(req),
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
  const latestAggregate = await DashboardAggregate.findOne({
    where: scopedTenantWhere(req),
    order: [['aggregate_date', 'DESC']],
  });

  const [alerts, sensorsFaulty] = await Promise.all([
    Alert.count({
      where: {
        ...scopedFacilityWhere(req),
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
