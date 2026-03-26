const { Op } = require('sequelize');
const Inspection = require('./inspection.model');
const User = require('../users/user.model');
const AppError = require('../../core/errors/AppError');
const { uploadInspectionImage, deleteTempFile } = require('./image.service');
const { queueInspectionProcessing } = require('../../jobs/processInspection.job');
const {
  sanitizeText,
  parseOptionalNumber,
  parsePositiveInteger,
} = require('../../utils/validators');

const INSPECTION_UPLOAD_FOLDER = 'ecovision/inspections';

const safeJsonParse = (value, fallback) => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
};

const normalizeCoordinate = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const mapInspectionRecord = (record, workerMap = {}) => {
  const data = record.get ? record.get({ plain: true }) : record;
  const findings = safeJsonParse(data.findings_json, []);
  const scoreBreakdown = safeJsonParse(data.score_breakdown_json, {});

  return {
    id: data.id,
    workerId: data.worker_id,
    workerName: workerMap[data.worker_id] || null,
    toiletCode: data.toilet_code,
    toiletName: data.toilet_name,
    city: data.city,
    ward: data.ward,
    zone: data.zone,
    sector: data.sector,
    latitude: normalizeCoordinate(data.latitude),
    longitude: normalizeCoordinate(data.longitude),
    beforeImageUrl: data.before_image_url || data.image_url || null,
    afterImageUrl: data.after_image_url || null,
    legacyImageUrl: data.image_url || null,
    scoreBefore: data.score_before,
    scoreAfter: data.score_after,
    improvementScore: data.improvement_score,
    overallScore: data.overall_score,
    legacyScore: data.score,
    severity: data.severity,
    status: data.status,
    findings,
    scoreBreakdown,
    remarks: data.remarks,
    processedAt: data.processed_at,
    createdAt: data.created_at,
  };
};

const getWorkerMap = async (inspections) => {
  const workerIds = [...new Set(inspections.map((inspection) => inspection.worker_id).filter(Boolean))];

  if (workerIds.length === 0) {
    return {};
  }

  const workers = await User.findAll({
    attributes: ['id', 'username'],
    where: {
      id: {
        [Op.in]: workerIds,
      },
    },
    raw: true,
  });

  return workers.reduce((acc, worker) => {
    acc[worker.id] = worker.username;
    return acc;
  }, {});
};

const parsePagination = (query) => {
  const parsedPage = parsePositiveInteger(query.page, 1);
  const parsedLimit = parsePositiveInteger(query.limit, 20);
  const page = Number.isNaN(parsedPage) ? 1 : parsedPage;
  const requestedLimit = Number.isNaN(parsedLimit) ? 20 : parsedLimit;
  const limit = Math.min(requestedLimit, 100);

  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
};

const normalizeMetadata = (body) => {
  return {
    toilet_code: sanitizeText(body.toiletCode, 80),
    toilet_name: sanitizeText(body.toiletName, 120),
    city: sanitizeText(body.city, 80),
    ward: sanitizeText(body.ward, 80),
    zone: sanitizeText(body.zone, 80),
    sector: sanitizeText(body.sector, 80),
    latitude: parseOptionalNumber(body.latitude),
    longitude: parseOptionalNumber(body.longitude),
    remarks: sanitizeText(body.remarks, 500) || null,
  };
};

const createLegacyInspection = async ({ workerId, file }) => {
  if (!file || !file.path) {
    throw new AppError('Please upload an image file', 400);
  }

  try {
    const uploaded = await uploadInspectionImage(file.path, `${INSPECTION_UPLOAD_FOLDER}/legacy`);

    const inspection = await Inspection.create({
      worker_id: workerId,
      image_url: uploaded.secure_url,
      before_image_url: uploaded.secure_url,
      status: 'pending',
    });

    queueInspectionProcessing(inspection.id);

    return {
      id: inspection.id,
      inspectionId: inspection.id,
      status: inspection.status,
      imageUrl: uploaded.secure_url,
      message: 'Inspection uploaded successfully. Processing started.',
    };
  } finally {
    await deleteTempFile(file.path);
  }
};

const submitInspection = async ({ workerId, body, files }) => {
  const beforeFile = files.beforeImage[0];
  const afterFile = files.afterImage[0];
  const metadata = normalizeMetadata(body);

  let beforeUpload;
  let afterUpload;

  try {
    [beforeUpload, afterUpload] = await Promise.all([
      uploadInspectionImage(beforeFile.path, `${INSPECTION_UPLOAD_FOLDER}/before`),
      uploadInspectionImage(afterFile.path, `${INSPECTION_UPLOAD_FOLDER}/after`),
    ]);
  } finally {
    await Promise.all([
      deleteTempFile(beforeFile.path),
      deleteTempFile(afterFile.path),
    ]);
  }

  const inspection = await Inspection.create({
    worker_id: workerId,
    toilet_code: metadata.toilet_code,
    toilet_name: metadata.toilet_name,
    city: metadata.city,
    ward: metadata.ward,
    zone: metadata.zone,
    sector: metadata.sector,
    latitude: Number.isNaN(metadata.latitude) ? null : metadata.latitude,
    longitude: Number.isNaN(metadata.longitude) ? null : metadata.longitude,
    before_image_url: beforeUpload.secure_url,
    after_image_url: afterUpload.secure_url,
    image_url: beforeUpload.secure_url,
    remarks: metadata.remarks,
    status: 'pending',
  });

  queueInspectionProcessing(inspection.id);

  return {
    inspectionId: inspection.id,
    status: inspection.status,
    beforeImageUrl: beforeUpload.secure_url,
    afterImageUrl: afterUpload.secure_url,
    message: 'Inspection submitted successfully',
  };
};

const buildAdminFilters = (query) => {
  const where = {};

  if (query.status) {
    where.status = query.status;
  }

  if (query.severity) {
    where.severity = query.severity;
  }

  if (query.zone) {
    where.zone = sanitizeText(query.zone, 80);
  }

  if (query.ward) {
    where.ward = sanitizeText(query.ward, 80);
  }

  return where;
};

const getAllInspections = async (query) => {
  const { page, limit, offset } = parsePagination(query);
  const where = buildAdminFilters(query);

  const { rows, count } = await Inspection.findAndCountAll({
    where,
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });

  const workerMap = await getWorkerMap(rows);
  const items = rows.map((item) => mapInspectionRecord(item, workerMap));

  return {
    inspections: items,
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getRecentInspections = async (query) => {
  const parsedLimit = parsePositiveInteger(query.limit, 10);
  const requestedLimit = Number.isNaN(parsedLimit) ? 10 : parsedLimit;
  const limit = Math.min(requestedLimit, 50);

  const rows = await Inspection.findAll({
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
  });

  const workerMap = await getWorkerMap(rows);

  return rows.map((item) => {
    const mapped = mapInspectionRecord(item, workerMap);

    return {
      id: mapped.id,
      workerId: mapped.workerId,
      workerName: mapped.workerName,
      toiletCode: mapped.toiletCode,
      toiletName: mapped.toiletName,
      zone: mapped.zone,
      ward: mapped.ward,
      status: mapped.status,
      severity: mapped.severity,
      overallScore: mapped.overallScore,
      improvementScore: mapped.improvementScore,
      beforeImageUrl: mapped.beforeImageUrl,
      afterImageUrl: mapped.afterImageUrl,
      createdAt: mapped.createdAt,
      processedAt: mapped.processedAt,
    };
  });
};

const getInspectionById = async (inspectionId) => {
  const inspection = await Inspection.findByPk(inspectionId);

  if (!inspection) {
    throw new AppError('Inspection not found', 404);
  }

  const workerMap = await getWorkerMap([inspection]);
  return mapInspectionRecord(inspection, workerMap);
};

const getMyInspections = async (workerId, query) => {
  const { page, limit, offset } = parsePagination(query);
  const where = {
    worker_id: workerId,
  };

  if (query.status) {
    where.status = query.status;
  }

  if (query.severity) {
    where.severity = query.severity;
  }

  const { rows, count } = await Inspection.findAndCountAll({
    where,
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
    offset,
  });

  const items = rows.map((item) => mapInspectionRecord(item));

  return {
    inspections: items,
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

module.exports = {
  createLegacyInspection,
  submitInspection,
  getAllInspections,
  getRecentInspections,
  getInspectionById,
  getMyInspections,
};
