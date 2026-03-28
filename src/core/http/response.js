const sendSuccess = (
  res,
  { statusCode = 200, message = 'Request successful', data = null, meta } = {}
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

  return res.status(statusCode).json(payload);
};

module.exports = {
  sendSuccess,
};
