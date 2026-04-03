const { sendSuccess } = require('../../core/http/response');
const inspectionService = require('./inspection.service');
const inspectionUploadService = require('./inspectionUpload.service');
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

const postInspectionStart = async (req, res, next) => {
  try {
    const data = await inspectionService.startInspection(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Inspection started successfully',
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

const postInspectionMediaUploadSessions = async (req, res, next) => {
  try {
    const data = await inspectionUploadService.createUploadSessions(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Upload session(s) created successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postInspectionMediaConfirm = async (req, res, next) => {
  try {
    const data = await inspectionUploadService.confirmUpload(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Inspection media upload confirmed successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postInspectionMediaRetry = async (req, res, next) => {
  try {
    const data = await inspectionUploadService.retryUploadSession(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Inspection media retry session created successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postInspectionImageUploadSession = async (req, res, next) => {
  try {
    req.params.id = req.body.inspectionId || req.params.id;
    if (!Array.isArray(req.body.images) && req.body.image) {
      req.body.images = [req.body.image];
    }
    const data = await inspectionUploadService.createUploadSessions(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Inspection image upload session created successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postInspectionImageConfirmUpload = async (req, res, next) => {
  try {
    req.params.id = req.body.inspectionId || req.params.id;
    req.params.mediaId = req.body.mediaId || req.params.mediaId;
    const data = await inspectionUploadService.confirmUpload(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Inspection image upload confirmed successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postInspectionImageTriggerAi = async (req, res, next) => {
  try {
    const data = await inspectionService.triggerInspectionImageAnalysis(req);
    return sendSuccess(res, {
      statusCode: 202,
      message: 'Inspection image AI analysis queued successfully',
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

const getInspectionImages = async (req, res, next) => {
  try {
    const data = await inspectionService.getInspectionImages(req);
    return sendSuccess(res, {
      message: 'Inspection images fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getInspectionImageById = async (req, res, next) => {
  try {
    const data = await inspectionService.getInspectionImageById(req);
    return sendSuccess(res, {
      message: 'Inspection image fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletInspections = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletInspections(req);
    return sendSuccess(res, {
      message: 'Toilet inspections fetched successfully',
      data: data.items,
      meta: data.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getInspectionComparison = async (req, res, next) => {
  try {
    const data = await inspectionService.getInspectionComparisonById(req);
    return sendSuccess(res, {
      message: 'Inspection comparison fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletDetails = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletDetailsById(req);
    return sendSuccess(res, {
      message: 'Toilet details fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletLatestInspection = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletLatestInspectionById(req);
    return sendSuccess(res, {
      message: 'Toilet latest inspection fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletScoreTrends = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletScoreTrendsById(req);
    return sendSuccess(res, {
      message: 'Toilet score trends fetched successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletInspectionHistory = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletInspectionHistoryById(req);
    return sendSuccess(res, {
      message: 'Toilet inspection history fetched successfully',
      data: data.items,
      meta: data.meta,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  postInspection,
  postInspectionStart,
  postInspectionMedia,
  postInspectionImageUploadSession,
  postInspectionImageConfirmUpload,
  postInspectionImageTriggerAi,
  postInspectionMediaUploadSessions,
  postInspectionMediaConfirm,
  postInspectionMediaRetry,
  postSubmitInspection,
  getInspectionById,
  getInspectionImages,
  getInspectionImageById,
  getInspectionTrend,
  getMyInspections,
  getAllInspections,
  patchReviewInspection,
  getToiletInspections,
  getInspectionComparison,
  getToiletDetails,
  getToiletLatestInspection,
  getToiletScoreTrends,
  getToiletInspectionHistory,
};
