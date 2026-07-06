const {
  Op,
  col,
  fn,
  literal,
} = require('sequelize');
const {
  Inspection,
  AiAnalysisResult,
  Alert,
  Facility,
  Complaint,
  ToiletUnit,
} = require('../../models');
const {
  buildAccessContextFromUser,
  applyScopeToQuery,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');

const scopedWhere = (req) => {
  const where = applyScopeToQuery(
    {},
    buildAccessContextFromUser(req?.user || {}),
    'report',
    { tenantKey: 'tenant_id', facilityKey: 'facility_id' },
  );
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      where.facility_id = '00000000-0000-0000-0000-000000000000';
    } else {
      where.facility_id = req.query.facilityId;
    }
  }
  return where;
};

const scopedFacilityEntityWhere = (req) => {
  const where = applyScopeToQuery(
    {},
    buildAccessContextFromUser(req?.user || {}),
    'facility',
    { tenantKey: 'tenant_id', facilityKey: 'id' },
  );
  if (req.query.facilityId) {
    if (!isFacilityInScope(req, req.query.facilityId)) {
      where.id = '00000000-0000-0000-0000-000000000000';
    } else {
      where.id = req.query.facilityId;
    }
  }
  return where;
};

const uniqueIds = (values = []) =>
  [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => (value === null || value === undefined ? '' : String(value).trim()))
        .filter(Boolean)
    ),
  ];

const loadDeletedToiletIdsForScope = async (req) => {
  const rows = await ToiletUnit.findAll({
    where: { deleted_at: { [Op.not]: null } },
    attributes: ['id'],
    include: [
      {
        model: Facility,
        attributes: [],
        required: true,
        where: scopedFacilityEntityWhere(req),
      },
    ],
    raw: true,
  });
  return uniqueIds(rows.map((row) => row.id));
};

const excludeDeletedToiletsFromInspectionWhere = (where = {}, deletedToiletIds = []) => {
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

const getInspectionReport = async (req) => {
  const deletedToiletIds = await loadDeletedToiletIdsForScope(req);
  const rows = await Inspection.findAll({
    where: excludeDeletedToiletsFromInspectionWhere(scopedWhere(req), deletedToiletIds),
    include: [{ model: AiAnalysisResult }],
    order: [['captured_at', 'DESC']],
    limit: Number(req.query.limit || 1000),
  });

  return rows.map((row) => ({
    id: row.id,
    facilityId: row.facility_id,
    toiletUnitId: row.toilet_unit_id,
    inspectionType: row.inspection_type,
    capturedAt: row.captured_at,
    processingStatus: row.processing_status,
    overallStatus: row.overall_status,
    cleanlinessScore: Number(row.AiAnalysisResults?.[0]?.cleanliness_score || 0),
  }));
};

const getAlertReport = async (req) => {
  const rows = await Alert.findAll({
    where: scopedWhere(req),
    order: [['created_at', 'DESC']],
    limit: Number(req.query.limit || 1000),
  });
  return rows.map((row) => ({
    id: row.id,
    alertType: row.alert_type,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    message: row.message,
    facilityId: row.facility_id,
  }));
};

const getFacilityPerformanceReport = async (req) => {
  const deletedToiletIds = await loadDeletedToiletIdsForScope(req);
  const scopedRecordWhere = excludeDeletedToiletsFromInspectionWhere(
    scopedWhere(req),
    deletedToiletIds,
  );

  // Aggregate in Postgres instead of loading every inspection, AI payload, and
  // complaint into Node. AI rows can contain large JSON fields, so materializing
  // the full association can exceed the database driver's read timeout.
  const [facilities, inspectionAggregates, complaintAggregates] = await Promise.all([
    Facility.findAll({
      where: scopedFacilityEntityWhere(req),
      attributes: ['id', 'code', 'name'],
      raw: true,
    }),
    Inspection.findAll({
      where: scopedRecordWhere,
      attributes: [
        'facility_id',
        [fn('COUNT', literal('DISTINCT "Inspection"."id"')), 'inspectionCount'],
        [fn('AVG', col('AiAnalysisResults.cleanliness_score')), 'cleanlinessAverage'],
      ],
      include: [
        {
          model: AiAnalysisResult,
          attributes: [],
          required: false,
        },
      ],
      group: ['Inspection.facility_id'],
      raw: true,
    }),
    Complaint.findAll({
      where: scopedRecordWhere,
      attributes: [
        'facility_id',
        [fn('COUNT', col('Complaint.id')), 'complaintCount'],
      ],
      group: ['Complaint.facility_id'],
      raw: true,
    }),
  ]);

  const inspectionsByFacility = new Map(
    inspectionAggregates.map((row) => [String(row.facility_id), row]),
  );
  const complaintsByFacility = new Map(
    complaintAggregates.map((row) => [String(row.facility_id), row]),
  );

  return facilities.map((facility) => {
    const inspectionSummary = inspectionsByFacility.get(String(facility.id));
    const complaintSummary = complaintsByFacility.get(String(facility.id));

    return {
      facilityId: facility.id,
      facilityCode: facility.code,
      facilityName: facility.name,
      inspections: Number(inspectionSummary?.inspectionCount || 0),
      complaints: Number(complaintSummary?.complaintCount || 0),
      cleanlinessAverage: Number(
        Number(inspectionSummary?.cleanlinessAverage || 0).toFixed(2),
      ),
    };
  });
};

const toCsv = (rows) => {
  if (!rows || rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      headers
        .map((header) => {
          const value = row[header] ?? '';
          const escaped = String(value).replace(/"/g, '""');
          return `"${escaped}"`;
        })
        .join(',')
    );
  }
  return lines.join('\n');
};

const exportReport = async (req) => {
  const type = req.query.type || 'csv';
  const reportType = req.query.report || req.query.reportType || 'inspections';
  let rows = [];

  if (reportType === 'inspections') rows = await getInspectionReport(req);
  if (reportType === 'alerts') rows = await getAlertReport(req);
  if (reportType === 'facility-performance') rows = await getFacilityPerformanceReport(req);

  if (type === 'csv') {
    return {
      format: 'csv',
      mimeType: 'text/csv',
      fileName: `${reportType}-${Date.now()}.csv`,
      content: toCsv(rows),
    };
  }

  return {
    format: 'json',
    mimeType: 'application/json',
    fileName: `${reportType}-${Date.now()}.json`,
    content: JSON.stringify(rows, null, 2),
  };
};

module.exports = {
  getInspectionReport,
  getAlertReport,
  getFacilityPerformanceReport,
  exportReport,
};
