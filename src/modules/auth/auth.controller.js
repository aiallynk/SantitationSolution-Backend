const authService = require('./auth.service');
const { sendSuccess } = require('../../utils/response');

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    const normalizedUsername = typeof username === 'string' ? username.trim() : username;
    const result = await authService.login(normalizedUsername, password);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Login successful',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

const getMe = async (req, res, next) => {
  try {
    const user = authService.getMe(req.user);

    sendSuccess(res, {
      statusCode: 200,
      message: 'Authenticated user fetched successfully',
      data: user,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  login,
  getMe,
};
