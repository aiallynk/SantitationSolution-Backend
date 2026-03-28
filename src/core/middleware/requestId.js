const { v4: uuidv4 } = require('uuid');

const attachRequestId = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const id =
    typeof incoming === 'string' && incoming.trim().length > 0
      ? incoming.trim()
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
