const { Op } = require('sequelize');
const sequelize = require('../../config/database');
const Inspection = require('../inspections/inspection.model');
const Alert = require('../alerts/alert.model');
const { parsePositiveInteger } = require('../../utils/validators');
const AppError = require('../../core/errors/AppError');

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundToTwo = (value) => {
  const numeric = toNumber(value, 0);
  return Number(numeric.toFixed(2));
};

const formatDateLabel = (dateInput) => {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return String(dateInput).slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
};

const getSummary = async () => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);

  const [
    totalInspections,
    inspectionsToday,
    criticalInspections,
    improvedInspections,
    pendingProcessing,
    totalAlerts,
    averageResult,
  ] = await Promise.all([
    Inspection.count(),
    Inspection.count({
      where: {
        created_at: {
          [Op.gte]: todayStart,
          [Op.lt]: tomorrowStart,
        },
      },
    }),
    Inspection.count({
      where: {
        severity: 'critical',
      },
    }),
    Inspection.count({
      where: {
        improvement_score: {
          [Op.gt]: 0,
        },
      },
    }),
    Inspection.count({
      where: {
        status: {
          [Op.in]: ['pending', 'processing'],
        },
      },
    }),
    Alert.count(),
    Inspection.findOne({
      attributes: [
        [sequelize.fn('AVG', sequelize.col('overall_score')), 'averageOverallScore'],
      ],
      where: {
        status: 'completed',
        overall_score: {
          [Op.ne]: null,
        },
      },
      raw: true,
    }),
  ]);

  const averageOverallScore = roundToTwo(averageResult ? averageResult.averageOverallScore : 0);

  return {
    totalInspections,
    inspectionsToday,
    averageOverallScore,
    averageScore: averageOverallScore,
    criticalInspections,
    improvedInspections,
    pendingProcessing,
    totalAlerts,
  };
};

const getAlerts = async (query) => {
  const parsedLimit = parsePositiveInteger(query.limit, 50);
  const limit = Math.min(Number.isNaN(parsedLimit) ? 50 : parsedLimit, 200);

  const alerts = await Alert.findAll({
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    raw: true,
  });

  return alerts.map((alert) => ({
    id: alert.id,
    inspection_id: alert.inspection_id,
    severity: alert.severity,
    message: alert.message,
    status: alert.status,
    created_at: alert.created_at,
  }));
};

const getHeatmap = async () => {
  const inspections = await Inspection.findAll({
    where: {
      latitude: {
        [Op.ne]: null,
      },
      longitude: {
        [Op.ne]: null,
      },
    },
    order: [['created_at', 'DESC']],
    raw: true,
  });

  return inspections.map((inspection) => ({
    inspectionId: inspection.id,
    toiletCode: inspection.toilet_code,
    toiletName: inspection.toilet_name,
    latitude: toNumber(inspection.latitude, null),
    longitude: toNumber(inspection.longitude, null),
    overallScore: inspection.overall_score,
    severity: inspection.severity,
    zone: inspection.zone,
    ward: inspection.ward,
    sector: inspection.sector,
  }));
};

const getTrends = async (query) => {
  const parsedDays = parsePositiveInteger(query.days, 7);
  const days = Math.min(Number.isNaN(parsedDays) ? 7 : parsedDays, 90);

  const startDate = new Date();
  startDate.setHours(0, 0, 0, 0);
  startDate.setDate(startDate.getDate() - (days - 1));

  const rows = await Inspection.findAll({
    attributes: [
      [sequelize.fn('DATE', sequelize.col('created_at')), 'label'],
      [sequelize.fn('AVG', sequelize.col('score_before')), 'averageBeforeScore'],
      [sequelize.fn('AVG', sequelize.col('score_after')), 'averageAfterScore'],
      [sequelize.fn('AVG', sequelize.col('overall_score')), 'averageOverallScore'],
      [sequelize.fn('COUNT', sequelize.col('id')), 'inspectionCount'],
    ],
    where: {
      created_at: {
        [Op.gte]: startDate,
      },
    },
    group: [sequelize.literal('DATE(created_at)')],
    order: [sequelize.literal('DATE(created_at) ASC')],
    raw: true,
  });

  const mapByDate = rows.reduce((acc, row) => {
    const label = formatDateLabel(row.label);
    acc[label] = row;
    return acc;
  }, {});

  const trendSeries = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(startDate);
    date.setDate(startDate.getDate() + i);

    const label = formatDateLabel(date);
    const row = mapByDate[label] || {};

    trendSeries.push({
      label,
      averageBeforeScore: roundToTwo(row.averageBeforeScore || 0),
      averageAfterScore: roundToTwo(row.averageAfterScore || 0),
      averageOverallScore: roundToTwo(row.averageOverallScore || 0),
      inspectionCount: Number.parseInt(row.inspectionCount, 10) || 0,
    });
  }

  return trendSeries;
};

const getZoneSummaries = async () => {
  const rows = await Inspection.findAll({
    attributes: [
      'zone',
      [sequelize.fn('COUNT', sequelize.col('id')), 'inspectionCount'],
      [sequelize.fn('AVG', sequelize.col('overall_score')), 'averageScore'],
      [sequelize.literal("SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END)"), 'criticalCount'],
      [sequelize.literal("SUM(CASE WHEN improvement_score > 0 THEN 1 ELSE 0 END)"), 'improvedCount'],
    ],
    where: {
      zone: {
        [Op.ne]: null,
      },
    },
    group: ['zone'],
    order: [['zone', 'ASC']],
    raw: true,
  });

  return rows.map((row) => ({
    zone: row.zone,
    inspectionCount: Number.parseInt(row.inspectionCount, 10) || 0,
    averageScore: roundToTwo(row.averageScore || 0),
    criticalCount: Number.parseInt(row.criticalCount, 10) || 0,
    improvedCount: Number.parseInt(row.improvedCount, 10) || 0,
  }));
};

const getCriticalInspections = async () => {
  const inspections = await Inspection.findAll({
    where: {
      status: 'completed',
      [Op.or]: [
        { severity: { [Op.in]: ['critical', 'poor'] } },
        { overall_score: { [Op.lte]: 60 } },
      ],
    },
    order: [['created_at', 'DESC']],
    limit: 20,
    raw: true,
  });

  const inspectionIds = inspections.map((item) => item.id);
  const alerts = inspectionIds.length > 0
    ? await Alert.findAll({
      where: {
        inspection_id: {
          [Op.in]: inspectionIds,
        },
      },
      order: [['created_at', 'DESC']],
      raw: true,
    })
    : [];

  const latestAlertByInspection = alerts.reduce((acc, alert) => {
    if (!acc[alert.inspection_id]) {
      acc[alert.inspection_id] = alert;
    }

    return acc;
  }, {});

  return inspections.map((inspection) => {
    const linkedAlert = latestAlertByInspection[inspection.id];

    return {
      inspectionId: inspection.id,
      toiletCode: inspection.toilet_code,
      toiletName: inspection.toilet_name,
      zone: inspection.zone,
      ward: inspection.ward,
      overallScore: inspection.overall_score,
      scoreAfter: inspection.score_after,
      severity: inspection.severity,
      status: inspection.status,
      createdAt: inspection.created_at,
      alertId: linkedAlert ? linkedAlert.id : null,
      alertStatus: linkedAlert ? linkedAlert.status : null,
      alertMessage: linkedAlert ? linkedAlert.message : null,
    };
  });
};

const acknowledgeAlert = async (alertId) => {
  const alert = await Alert.findByPk(alertId);

  if (!alert) {
    throw new AppError('Alert not found', 404);
  }

  if (alert.status === 'open') {
    alert.status = 'acknowledged';
    await alert.save();
  }

  return {
    id: alert.id,
    inspection_id: alert.inspection_id,
    severity: alert.severity,
    message: alert.message,
    status: alert.status,
    created_at: alert.created_at,
  };
};

module.exports = {
  getSummary,
  getAlerts,
  getHeatmap,
  getTrends,
  getZoneSummaries,
  getCriticalInspections,
  acknowledgeAlert,
};
