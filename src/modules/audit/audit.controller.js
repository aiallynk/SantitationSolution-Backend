const { sendSuccess } = require('../../core/http/response');
const auditService = require('./audit.service');

const getAuditLogs = async (req, res, next) => {
  try {
    const result = await auditService.listAuditLogs(req);
    return sendSuccess(res, {
      message: 'Audit logs fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getAuditLogs,
};
