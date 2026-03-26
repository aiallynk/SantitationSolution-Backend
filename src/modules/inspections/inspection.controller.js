const inspectionService = require('./inspection.service');
const { sendSuccess } = require('../../utils/response');

const uploadLegacyInspection = async (req, res, next) => {
  try {
    const result = await inspectionService.createLegacyInspection({
      workerId: req.user.id,
      file: req.file,
    });

    sendSuccess(res, {
      statusCode: 201,
      message: result.message,
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const submitInspection = async (req, res, next) => {
  try {
    const result = await inspectionService.submitInspection({
      workerId: req.user.id,
      body: req.body,
      files: req.files,
    });

    sendSuccess(res, {
      statusCode: 201,
      message: 'Inspection submitted successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const getAllInspections = async (req, res, next) => {
  try {
    const result = await inspectionService.getAllInspections(req.query);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Inspections fetched successfully',
      data: result.inspections,
      meta: result.meta,
    });
  } catch (error) {
    next(error);
  }
};

const getRecentInspections = async (req, res, next) => {
  try {
    const inspections = await inspectionService.getRecentInspections(req.query);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Recent inspections fetched successfully',
      data: inspections,
    });
  } catch (error) {
    next(error);
  }
};

const getInspectionById = async (req, res, next) => {
  try {
    const inspection = await inspectionService.getInspectionById(req.params.id);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Inspection details fetched successfully',
      data: inspection,
    });
  } catch (error) {
    next(error);
  }
};

const getMyInspections = async (req, res, next) => {
  try {
    const result = await inspectionService.getMyInspections(req.user.id, req.query);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Worker inspection history fetched successfully',
      data: result.inspections,
      meta: result.meta,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  uploadLegacyInspection,
  submitInspection,
  getAllInspections,
  getRecentInspections,
  getInspectionById,
  getMyInspections,
};
