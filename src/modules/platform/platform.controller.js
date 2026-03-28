const { sendSuccess } = require('../../core/http/response');
const platformService = require('./platform.service');

const getTenants = async (req, res, next) => {
  try {
    const data = await platformService.listTenants(req);
    return sendSuccess(res, { message: 'Tenants fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const postTenant = async (req, res, next) => {
  try {
    const row = await platformService.createTenant(req);
    return sendSuccess(res, { statusCode: 201, message: 'Tenant created successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const patchTenant = async (req, res, next) => {
  try {
    const row = await platformService.patchTenant(req);
    return sendSuccess(res, { message: 'Tenant updated successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const getGeographiesTree = async (req, res, next) => {
  try {
    const data = await platformService.listGeographyTree(req);
    return sendSuccess(res, { message: 'Geography tree fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const postGeography = async (req, res, next) => {
  try {
    const row = await platformService.createGeography(req);
    return sendSuccess(res, { statusCode: 201, message: 'Geography created successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const getFacilities = async (req, res, next) => {
  try {
    const result = await platformService.listFacilities(req);
    return sendSuccess(res, {
      message: 'Facilities fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const postFacility = async (req, res, next) => {
  try {
    const row = await platformService.createFacility(req);
    return sendSuccess(res, { statusCode: 201, message: 'Facility created successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const getFacilityById = async (req, res, next) => {
  try {
    const row = await platformService.getFacilityById(req);
    return sendSuccess(res, { message: 'Facility fetched successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const patchFacility = async (req, res, next) => {
  try {
    const row = await platformService.patchFacility(req);
    return sendSuccess(res, { message: 'Facility updated successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const getToiletBlocks = async (req, res, next) => {
  try {
    const data = await platformService.listBlocks(req);
    return sendSuccess(res, { message: 'Toilet blocks fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const postToiletBlock = async (req, res, next) => {
  try {
    const row = await platformService.createBlock(req);
    return sendSuccess(res, { statusCode: 201, message: 'Toilet block created successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const getToiletUnits = async (req, res, next) => {
  try {
    const data = await platformService.listUnits(req);
    return sendSuccess(res, { message: 'Toilet units fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const postToiletUnit = async (req, res, next) => {
  try {
    const row = await platformService.createUnit(req);
    return sendSuccess(res, { statusCode: 201, message: 'Toilet unit created successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getTenants,
  postTenant,
  patchTenant,
  getGeographiesTree,
  postGeography,
  getFacilities,
  postFacility,
  getFacilityById,
  patchFacility,
  getToiletBlocks,
  postToiletBlock,
  getToiletUnits,
  postToiletUnit,
};
