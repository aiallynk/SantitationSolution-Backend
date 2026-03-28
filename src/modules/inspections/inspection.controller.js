const { sendSuccess } = require('../../core/http/response');
const inspectionService = require('./inspection.service');
const { getInspectionAnalysisTrend } = require('../analysis/analysis.service');

const postInspection = async (req, res, next) => {
  try {
    const data = await inspectionService.createInspection(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Inspection created successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postInspectionMedia = async (req, res, next) => {
  try {
    const data = await inspectionService.uploadInspectionMedia(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Inspection media uploaded successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postSubmitInspection = async (req, res, next) => {
  try {
    const data = await inspectionService.submitInspection(req);
    return sendSuccess(res, {
      statusCode: 202,
      message: 'Inspection submitted and queued for analysis',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const patchReviewInspection = async (req, res, next) => {
  try {
    const data = await inspectionService.reviewInspection(req);
    return sendSuccess(res, {
      message: 'Inspection review updated successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getInspectionById = async (req, res, next) => {
  try {
    const data = await inspectionService.getInspectionById(req);
    return sendSuccess(res, {
      message: 'Inspection fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getMyInspections = async (req, res, next) => {
  try {
    const result = await inspectionService.listInspections(req, true);
    return sendSuccess(res, {
      message: 'My inspections fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getAllInspections = async (req, res, next) => {
  try {
    const result = await inspectionService.listInspections(req, false);
    return sendSuccess(res, {
      message: 'Inspections fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getInspectionTrend = async (req, res, next) => {
  try {
    const data = await getInspectionAnalysisTrend(req.params.id, req, {
      limit: req.query.limit,
    });
    return sendSuccess(res, {
      message: 'Inspection trend fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  postInspection,
  postInspectionMedia,
  postSubmitInspection,
  getInspectionById,
  getInspectionTrend,
  getMyInspections,
  getAllInspections,
  patchReviewInspection,
};
