const { sendSuccess } = require('../../core/http/response');
const platformService = require('./platform.service');
const inspectionService = require('../inspections/inspection.service');
const operationalMasterDataService = require('./operationalMasterData.service');

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
    const result = await platformService.listGeographyOptions(req);
    return sendSuccess(res, {
      message: 'Geography options fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const getGlobalGeographyOptions = async (req, res, next) => {
  try {
    const result = await platformService.listGlobalGeographyOptions(req);
    return sendSuccess(res, {
      message: 'Global geography options fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const postGlobalGeographyActivation = async (req, res, next) => {
  try {
    const data = await platformService.activateGlobalGeography(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Global geography activated for tenant',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getGlobalGeographyDataSources = async (req, res, next) => {
  try {
    const data = await platformService.listGlobalGeographyDataSources(req);
    return sendSuccess(res, { message: 'Global geography data sources fetched', data });
  } catch (error) {
    return next(error);
  }
};

const getGeographyImportJobs = async (req, res, next) => {
  try {
    const result = await platformService.listGeographyImportJobs(req);
    return sendSuccess(res, {
      message: 'Geography import jobs fetched successfully',
      data: result.items,
      meta: result.meta,
    });
  } catch (error) {
    return next(error);
  }
};

const postGeographyImportJob = async (req, res, next) => {
  try {
    const data = await platformService.runGeographyImportJob(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Geography import job completed',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const postRequestMissingArea = async (req, res, next) => {
  try {
    const data = await platformService.requestMissingArea(req);
    return sendSuccess(res, {
      statusCode: 201,
      message: 'Missing area request submitted successfully',
      data,
    });
  } catch (error) {
    return next(error);
  }
};

const getGeographyMigrationReviews = async (req, res, next) => {
  try {
    const result = await platformService.listGeographyMigrationReviews(req);
    return sendSuccess(res, { message: 'Geography migration reviews fetched', data: result.items, meta: result.meta });
  } catch (error) {
    return next(error);
  }
};

const patchGeographyMigrationReview = async (req, res, next) => {
  try {
    const data = await platformService.resolveGeographyMigrationReview(req);
    return sendSuccess(res, { message: 'Geography migration review resolved', data });
  } catch (error) {
    return next(error);
  }
};

const putTenantGeographyAssignment = async (req, res, next) => {
  try {
    const data = await platformService.setTenantGeographyAssignment(req);
    return sendSuccess(res, { message: 'Tenant geography activation updated', data });
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

const getOperationalMasterData = async (req, res, next) => {
  try {
    const result = await operationalMasterDataService.listOperationalMasterData(req);
    return sendSuccess(res, {
      message: 'Operational master data fetched successfully',
      data: result.items,
      meta: result.meta,
      summary: result.summary,
    });
  } catch (error) {
    return next(error);
  }
};

const postOperationalMasterData = async (req, res, next) => {
  try {
    const data = await operationalMasterDataService.createOperationalMasterData(req);
    return sendSuccess(res, { statusCode: 201, message: 'Operational master data created successfully', data });
  } catch (error) {
    return next(error);
  }
};

const patchOperationalMasterData = async (req, res, next) => {
  try {
    const data = await operationalMasterDataService.updateOperationalMasterData(req);
    return sendSuccess(res, { message: 'Operational master data updated successfully', data });
  } catch (error) {
    return next(error);
  }
};

const postOperationalMasterDataActivate = async (req, res, next) => {
  try {
    const data = await operationalMasterDataService.activateOperationalMasterData(req);
    return sendSuccess(res, { message: 'Operational master data activated successfully', data });
  } catch (error) {
    return next(error);
  }
};

const postOperationalMasterDataDeactivate = async (req, res, next) => {
  try {
    const data = await operationalMasterDataService.deactivateOperationalMasterData(req);
    return sendSuccess(res, { message: 'Operational master data deactivated successfully', data });
  } catch (error) {
    return next(error);
  }
};

const getFacilityQr = async (req, res, next) => {
  try {
    const row = await platformService.getFacilityQr(req);
    return sendSuccess(res, { message: 'Facility QR fetched successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const postFacilityQrDownload = async (req, res, next) => {
  try {
    const row = await platformService.downloadFacilityQr(req);
    return sendSuccess(res, { message: 'Facility QR download prepared', data: row });
  } catch (error) {
    return next(error);
  }
};

const postFacilityQrPrint = async (req, res, next) => {
  try {
    const row = await platformService.printFacilityQrLabel(req);
    return sendSuccess(res, { message: 'Facility QR label prepared', data: row });
  } catch (error) {
    return next(error);
  }
};

const postFacilityQrRegenerate = async (req, res, next) => {
  try {
    const row = await platformService.regenerateFacilityQr(req);
    return sendSuccess(res, { message: 'Facility QR regenerated successfully', data: row });
  } catch (error) {
    return next(error);
  }
};

const postFacilityQrResolve = async (req, res, next) => {
  try {
    const row = await platformService.resolveFacilityFromQr(req);
    return sendSuccess(res, { message: 'Facility QR resolved successfully', data: row });
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
  getGlobalGeographyOptions,
  postGlobalGeographyActivation,
  getGlobalGeographyDataSources,
  getGeographyImportJobs,
  postGeographyImportJob,
  postRequestMissingArea,
  getGeographyMigrationReviews,
  patchGeographyMigrationReview,
  putTenantGeographyAssignment,
  postGeography,
  patchGeography,
  deleteGeography,
  getOperationalMasterData,
  postOperationalMasterData,
  patchOperationalMasterData,
  postOperationalMasterDataActivate,
  postOperationalMasterDataDeactivate,
  getFacilities,
  postFacility,
  getFacilityQr,
  postFacilityQrDownload,
  postFacilityQrPrint,
  postFacilityQrRegenerate,
  postFacilityQrResolve,
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
