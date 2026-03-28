const { sendSuccess } = require('../../core/http/response');
const reportService = require('./report.service');

const getInspectionReport = async (req, res, next) => {
  try {
    const data = await reportService.getInspectionReport(req);
    return sendSuccess(res, { message: 'Inspection report fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getAlertReport = async (req, res, next) => {
  try {
    const data = await reportService.getAlertReport(req);
    return sendSuccess(res, { message: 'Alert report fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getFacilityPerformanceReport = async (req, res, next) => {
  try {
    const data = await reportService.getFacilityPerformanceReport(req);
    return sendSuccess(res, { message: 'Facility performance report fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getExport = async (req, res, next) => {
  try {
    const exported = await reportService.exportReport(req);
    res.setHeader('Content-Type', exported.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
    return res.status(200).send(exported.content);
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getInspectionReport,
  getAlertReport,
  getFacilityPerformanceReport,
  getExport,
};
