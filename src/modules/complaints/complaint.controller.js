const { sendSuccess } = require('../../core/http/response');
const complaintService = require('./complaint.service');

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const renderSimpleHtml = ({
  title = 'Request Error',
  message = 'Unable to process request',
} = {}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; font-family: "Segoe UI", Tahoma, sans-serif; background: #f4f6f8; color: #1f2937; }
    .card { max-width: 680px; margin: 32px auto; background: #fff; border: 1px solid #d8dee6; border-radius: 12px; padding: 18px; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0; line-height: 1.5; color: #4b5563; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;

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

const getComplaintById = async (req, res, next) => {
  try {
    const data = await complaintService.getComplaintById(req);
    return sendSuccess(res, {
      message: 'Complaint fetched successfully',
      data,
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

const getPublicFeedbackForm = async (req, res) => {
  try {
    const html = await complaintService.getPublicFeedbackFormPage(req);
    return res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(html);
  } catch (error) {
    const status = Number(error?.statusCode || 500);
    const title = status === 404 ? 'Toilet Not Found' : 'Feedback Form Unavailable';
    const message = error?.message || 'Unable to load the feedback form';
    return res
      .status(status)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(renderSimpleHtml({ title, message }));
  }
};

const postPublicFeedback = async (req, res, next) => {
  try {
    const data = await complaintService.createPublicComplaint(req);

    if (req.accepts('html')) {
      const toiletId = encodeURIComponent(data.toiletUnitId || req.params.toiletId || '');
      const ticket = encodeURIComponent(data.id || '');
      return res.redirect(
        `/api/v1/public-feedback/toilets/${toiletId}?submitted=1&ticket=${ticket}`
      );
    }

    return sendSuccess(res, {
      statusCode: 201,
      message: 'Public feedback submitted successfully',
      data,
    });
  } catch (error) {
    if (req.accepts('html')) {
      const toiletId = encodeURIComponent(req.params.toiletId || '');
      const message = encodeURIComponent(error?.message || 'Unable to submit feedback');
      return res.redirect(`/api/v1/public-feedback/toilets/${toiletId}?error=${message}`);
    }
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

const postComplaintDispatch = async (req, res, next) => {
  try {
    const data = await complaintService.dispatchComplaint(req);
    return sendSuccess(res, {
      message: 'Complaint dispatch notifications sent successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getComplaints,
  getComplaintById,
  postComplaint,
  getPublicFeedbackForm,
  postPublicFeedback,
  patchComplaintAssign,
  patchComplaintResolve,
  postComplaintDispatch,
};

