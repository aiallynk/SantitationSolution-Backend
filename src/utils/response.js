const sendSuccess = (res, {
  statusCode = 200,
  message = 'Request successful',
  data = null,
  meta,
} = {}) => {
  const payload = {
    status: 'success',
    message,
    data,
  };

  if (meta) {
    payload.meta = meta;
  }

  return res.status(statusCode).json(payload);
};

module.exports = {
  sendSuccess,
};
