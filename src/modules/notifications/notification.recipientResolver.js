const { Op } = require('sequelize');
const {
  PlatformUser,
  Role,
  UserRole,
  WorkerAssignment,
  Facility,
} = require('../../models');
const { ROLE_CODES } = require('../../core/rbac/personaFamilies');

const uniqueIds = (values = []) => [
  ...new Set(
    values
      .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
      .map((value) => String(value))
  ),
];

const intersectIds = (left = [], right = []) => {
  const rightSet = new Set(uniqueIds(right));
  return uniqueIds(left).filter((value) => rightSet.has(value));
};

const fetchRoleIdsByCodes = async (roleCodes = []) => {
  const normalizedCodes = uniqueIds(roleCodes.map((code) => String(code || '').toLowerCase()));
  if (normalizedCodes.length === 0) return [];
  const rows = await Role.findAll({
    where: {
      code: {
        [Op.in]: normalizedCodes,
      },
    },
    attributes: ['id'],
  });
  return rows.map((row) => row.id);
};

const fetchActiveUserIds = async (userIds = []) => {
  const normalizedIds = uniqueIds(userIds);
  if (normalizedIds.length === 0) return [];
  const rows = await PlatformUser.findAll({
    where: {
      id: { [Op.in]: normalizedIds },
      status: 'active',
    },
    attributes: ['id'],
  });
  return rows.map((row) => row.id);
};

const fetchScopedAssignmentUserIds = async ({ tenantId = null, geographyId = null, facilityId = null } = {}) => {
  if (!tenantId && !geographyId && !facilityId) {
    return [];
  }
  const where = {
    status: 'active',
  };
  if (tenantId) where.tenant_id = tenantId;
  if (geographyId) where.geography_id = geographyId;
  if (facilityId) where.facility_id = facilityId;

  const rows = await WorkerAssignment.findAll({
    where,
    attributes: ['user_id', 'supervisor_user_id'],
  });
  return uniqueIds(
    rows.flatMap((row) => [row.user_id, row.supervisor_user_id])
  );
};

const fetchFacilitySupervisorIds = async (facilityId) => {
  if (!facilityId) return [];
  const facility = await Facility.findByPk(facilityId, {
    attributes: ['supervisor_user_id'],
  });
  return uniqueIds([facility?.supervisor_user_id]);
};

const resolveUsersByRoleAndScope = async ({
  roleCodes = [],
  tenantId = null,
  geographyId = null,
  facilityId = null,
} = {}) => {
  const roleIds = await fetchRoleIdsByCodes(roleCodes);
  if (roleIds.length === 0) {
    return [];
  }

  const roleWhere = {
    role_id: { [Op.in]: roleIds },
  };
  if (tenantId) {
    roleWhere.tenant_id = tenantId;
  }
  if (geographyId) {
    roleWhere.geography_id = geographyId;
  }

  const roleRows = await UserRole.findAll({
    where: roleWhere,
    attributes: ['user_id'],
  });

  let candidateUserIds = uniqueIds(roleRows.map((row) => row.user_id));
  if (!tenantId && !geographyId && !facilityId) {
    return fetchActiveUserIds(candidateUserIds);
  }

  const [assignmentUserIds, facilitySupervisorIds] = await Promise.all([
    fetchScopedAssignmentUserIds({ tenantId, geographyId, facilityId }),
    fetchFacilitySupervisorIds(facilityId),
  ]);
  const scopedUserIds = uniqueIds([...assignmentUserIds, ...facilitySupervisorIds]);

  if (scopedUserIds.length > 0) {
    candidateUserIds = intersectIds(candidateUserIds, scopedUserIds);
  }

  return fetchActiveUserIds(candidateUserIds);
};

const resolveTenantAdminIds = async ({ tenantId }) => {
  if (!tenantId) return [];
  return resolveUsersByRoleAndScope({
    roleCodes: [
      ROLE_CODES.TENANT_ADMIN,
      ROLE_CODES.COUNTRY_ADMIN,
      ROLE_CODES.STATE_ADMIN,
      ROLE_CODES.DISTRICT_ADMIN,
      ROLE_CODES.CITY_ADMIN,
      ROLE_CODES.ZONE_ADMIN,
      ROLE_CODES.FACILITY_MANAGER,
    ],
    tenantId,
  });
};

const resolveSupervisorIds = async ({
  tenantId = null,
  geographyId = null,
  facilityId = null,
} = {}) => {
  return resolveUsersByRoleAndScope({
    roleCodes: [ROLE_CODES.SUPERVISOR, ROLE_CODES.FACILITY_MANAGER],
    tenantId,
    geographyId,
    facilityId,
  });
};

const resolvePlatformAdminIds = async () => {
  return resolveUsersByRoleAndScope({
    roleCodes: [ROLE_CODES.SUPER_ADMIN, ROLE_CODES.PLATFORM_OPS],
  });
};

const resolveDirectSupervisorIdsForWorker = async ({ tenantId = null, workerUserId = null } = {}) => {
  if (!workerUserId) return [];
  const rows = await WorkerAssignment.findAll({
    where: {
      user_id: workerUserId,
      status: 'active',
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    attributes: ['supervisor_user_id'],
  });
  return fetchActiveUserIds(rows.map((row) => row.supervisor_user_id));
};

module.exports = {
  uniqueIds,
  resolveUsersByRoleAndScope,
  resolveTenantAdminIds,
  resolveSupervisorIds,
  resolvePlatformAdminIds,
  resolveDirectSupervisorIdsForWorker,
};
