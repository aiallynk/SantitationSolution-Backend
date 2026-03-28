const { sendSuccess } = require('../../core/http/response');
const complaintService = require('./complaint.service');

const getComplaints = async (req, res, next) => {
  try {
    const result = await complaintService.listComplaints(req);
    return sendSuccess(res, {
      message: 'Complaints fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const postComplaint = async (req, res, next) => {
  try {
    const data = await complaintService.createComplaint(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Complaint created successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const patchComplaintAssign = async (req, res, next) => {
  try {
    const data = await complaintService.assignComplaint(req);
    return sendSuccess(res, {
      message: 'Complaint assigned successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const patchComplaintResolve = async (req, res, next) => {
  try {
    const data = await complaintService.resolveComplaint(req);
    return sendSuccess(res, {
      message: 'Complaint resolved successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getComplaints,
  postComplaint,
  patchComplaintAssign,
  patchComplaintResolve,
};
