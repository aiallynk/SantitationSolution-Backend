const { sendSuccess } = require('../../core/http/response');
const taskService = require('./task.service');

const getMyTasks = async (req, res, next) => {
  try {
    const result = await taskService.getMyTasks(req);
    return sendSuccess(res, {
      message: 'Assigned tasks fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getTasks = async (req, res, next) => {
  try {
    const result = await taskService.listTasks(req);
    return sendSuccess(res, {
      message: 'Tasks fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getTaskById = async (req, res, next) => {
  try {
    const task = await taskService.getTaskById(req);
    return sendSuccess(res, {
      message: 'Task fetched successfully',
      data: task,
    });
  } catch (error) {
    return next(error);
  }
};

const postTask = async (req, res, next) => {
  try {
    const task = await taskService.createTask(req);
    return sendSuccess(res, {
      message: 'Task created successfully',
      data: task,
    });
  } catch (error) {
    return next(error);
  }
};

const patchTaskStart = async (req, res, next) => {
  try {
    const task = await taskService.startTask(req);
    return sendSuccess(res, {
      message: 'Task started successfully',
      data: task,
    });
  } catch (error) {
    return next(error);
  }
};

const patchTaskComplete = async (req, res, next) => {
  try {
    const task = await taskService.completeTask(req);
    return sendSuccess(res, {
      message: 'Task completed successfully',
      data: task,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getTasks,
  getTaskById,
  getMyTasks,
  postTask,
  patchTaskStart,
  patchTaskComplete,
};
