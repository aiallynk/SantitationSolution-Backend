const { v4: uuidv4 } = require('uuid');

const attachRequestId = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const normalizedIncoming =
    typeof incoming === 'string'
      ? incoming.trim().replace(/[^a-zA-Z0-9\-_.:]/g, '').slice(0, 120)
      : '';
  const id =
    normalizedIncoming.length > 0
      ? normalizedIncoming
      : uuidv4();

  req.requestId = id;
  res.locals.requestId = id;
  res.setHeader('x-request-id', id);
  next();
};

module.exports = {
  attachRequestId,
  requestId: attachRequestId,
};
