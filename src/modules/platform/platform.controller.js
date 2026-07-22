const { sendSuccess } = require('../../core/http/response');
const platformService = require('./platform.service');
const inspectionService = require('../inspections/inspection.service');

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

const getOwnTenantProfile = async (req, res, next) => {
  try {
    const row = await platformService.getOwnTenantProfile(req);
    return sendSuccess(res, { message: 'Tenant profile fetched successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const patchOwnTenantProfile = async (req, res, next) => {
  try {
    const row = await platformService.patchOwnTenantProfile(req);
    return sendSuccess(res, { message: 'Tenant profile updated successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const getOwnTenantAiScoringMode = async (req, res, next) => {
  try { return sendSuccess(res, { message: 'AI scoring mode fetched successfully', data: await platformService.getOwnTenantAiScoringMode(req) }); }
  catch (error) { return next(error); }
};
const patchOwnTenantAiScoringMode = async (req, res, next) => {
  try { return sendSuccess(res, { message: 'AI scoring mode updated successfully', data: await platformService.patchOwnTenantAiScoringMode(req) }); }
  catch (error) { return next(error); }
};

const getGeographiesTree = async (req, res, next) => {
  try {
    const data = await platformService.listGeographyTree(req);
    return sendSuccess(res, { message: 'Geography tree fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getGeographyOptions = async (req, res, next) => {
  try {
    const data = await platformService.listGeographyOptions(req);
    return sendSuccess(res, { message: 'Geography options fetched successfully', data });
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

const patchGeography = async (req, res, next) => {
  try {
    const row = await platformService.patchGeography(req);
    return sendSuccess(res, { message: 'Geography updated successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const deleteGeography = async (req, res, next) => {
  try {
    const row = await platformService.removeGeography(req);
    return sendSuccess(res, { message: 'Geography deleted successfully', data: row });
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

const deleteFacility = async (req, res, next) => {
  try {
    const row = await platformService.removeFacility(req);
    return sendSuccess(res, { message: 'Facility deleted successfully', data: row });
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

const getToiletMap = async (req, res, next) => {
  try {
    const data = await platformService.listToiletMap(req);
    return sendSuccess(res, {
      message: 'Toilet map data fetched successfully',
      data,
      meta: { total: data.length },
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletUnitByQr = async (req, res, next) => {
  try {
    const data = await platformService.resolveUnitByQr(req);
    return sendSuccess(res, {
      message: data?.message || 'Toilet unit resolved successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postToiletUnitByQr = async (req, res, next) => {
  try {
    const data = await platformService.resolveUnitByQrDetailed(req);
    return sendSuccess(res, {
      message: data?.message || 'QR resolution completed',
      data,
    });
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

const patchToiletUnitDeactivate = async (req, res, next) => {
  try {
    const row = await platformService.deactivateToiletUnit(req);
    return sendSuccess(res, { message: 'Toilet deactivated successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const patchToiletUnitReactivate = async (req, res, next) => {
  try {
    const row = await platformService.reactivateToiletUnit(req);
    return sendSuccess(res, { message: 'Toilet reactivated successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const deleteToiletUnit = async (req, res, next) => {
  try {
    const row = await platformService.softDeleteToiletUnit(req);
    return sendSuccess(res, { message: 'Toilet removed from tenant frontend successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const postToiletUnitsBulk = async (req, res, next) => {
  try {
    const data = await platformService.createUnitsBulk(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: `Bulk toilet creation completed (${data.quantityCreated})`,
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletDetails = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletDetailsById(req);
    return sendSuccess(res, { message: 'Toilet details fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getToiletLatestInspection = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletLatestInspectionById(req);
    return sendSuccess(res, { message: 'Toilet latest inspection fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getToiletScoreTrends = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletScoreTrendsById(req);
    return sendSuccess(res, { message: 'Toilet score trends fetched successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getToiletInspectionHistory = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletInspectionHistoryById(req);
    return sendSuccess(res, {
      message: 'Toilet inspection history fetched successfully',
      data: data.items,
      meta: data.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getToiletInspections = async (req, res, next) => {
  try {
    const data = await inspectionService.getToiletInspections(req);
    return sendSuccess(res, {
      message: 'Toilet inspections fetched successfully',
      data: data.items,
      meta: data.meta,
    });
  } catch (error) {
    return next(error);
  }
};

module.exports = {
  getTenants,
  postTenant,
  patchTenant,
  getOwnTenantProfile,
  patchOwnTenantProfile,
  getOwnTenantAiScoringMode,
  patchOwnTenantAiScoringMode,
  getGeographiesTree,
  getGeographyOptions,
  postGeography,
  patchGeography,
  deleteGeography,
  getFacilities,
  postFacility,
  getFacilityById,
  patchFacility,
  deleteFacility,
  getToiletBlocks,
  postToiletBlock,
  getToiletUnits,
  getToiletMap,
  getToiletUnitByQr,
  postToiletUnitByQr,
  postToiletUnit,
  patchToiletUnitDeactivate,
  patchToiletUnitReactivate,
  deleteToiletUnit,
  postToiletUnitsBulk,
  getToiletInspections,
  getToiletDetails,
  getToiletLatestInspection,
  getToiletScoreTrends,
  getToiletInspectionHistory,
};
