const { sendSuccess } = require('../../core/http/response');
const userService = require('./user.service');

const getUsers = async (req, res, next) => {
  try {
    const payload = await userService.listUsers(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Users fetched successfully',
      data: payload.items,
      meta: payload.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getUserById = async (req, res, next) => {
  try {
    const user = await userService.getUserById(req);
    return sendSuccess(res, {
      message: 'User fetched successfully',
      data: user,
    });
  } catch (error) {
    return next(error);
  }
};

const postUser = async (req, res, next) => {
  try {
    const payload = await userService.createUser(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'User created successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const patchUser = async (req, res, next) => {
  try {
    const payload = await userService.patchUser(req);
    return sendSuccess(res, {
      statusCode: 200,
      message: 'User updated successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const getRoles = async (req, res, next) => {
  try {
    const payload = await userService.listRoles();
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Roles fetched successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

const getPermissions = async (req, res, next) => {
  try {
    const payload = await userService.listPermissions();
    return sendSuccess(res, {
      statusCode: 200,
      message: 'Permissions fetched successfully',
      data: payload,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getUsers,
  getUserById,
  postUser,
  patchUser,
  getRoles,
  getPermissions,
};
