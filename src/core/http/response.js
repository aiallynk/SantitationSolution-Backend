const sendSuccess = (
  res,
  { statusCode = 200, message = 'Request successful', data = null, meta, ...extra } = {}
) => {
  const payload = {
    success: true,
    message,
    data,
    requestId: res.locals.requestId || null,
  };

  if (meta) {
    payload.meta = meta;
  }

  Object.assign(payload, extra);

  return res.status(statusCode).json(payload);
};

module.exports = {
  sendSuccess,
};
