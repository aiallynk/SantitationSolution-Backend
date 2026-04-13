const { Op } = require('sequelize');
const { Geography, Facility, InspectionTask } = require('../../models');
const { ScopeLevels, resolveScopedRoleLevel, resolveSeedScopeFromMemberships } = require('./accessProfiles');

const uniqueIds = (values = []) =>
  [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];

const normalizeAssignments = (assignments = []) =>
  (Array.isArray(assignments) ? assignments : []).filter((row) => row && row.status !== 'inactive');

const assignmentFacilityIds = (assignments = [], roleCode = null) =>
  uniqueIds(
    normalizeAssignments(assignments)
      .filter((row) => !roleCode || String(row.assignment_role || '').trim().toLowerCase() === String(roleCode || '').trim().toLowerCase())
      .map((row) => row.facility_id || row.facilityId || null),
  );

const assignmentGeographyIds = (assignments = [], roleCode = null) =>
  uniqueIds(
    normalizeAssignments(assignments)
      .filter((row) => !roleCode || String(row.assignment_role || '').trim().toLowerCase() === String(roleCode || '').trim().toLowerCase())
      .map((row) => row.geography_id || row.geographyId || null),
  );

const expandDescendantGeographies = async ({ tenantId, seedGeographyIds = [] }) => {
  const seeds = uniqueIds(seedGeographyIds);
  if (!tenantId || seeds.length === 0) return seeds;

  const rows = await Geography.findAll({
    where: { tenant_id: tenantId },
    attributes: ['id', 'parent_id'],
    raw: true,
  });

  const childrenByParent = new Map();
  for (const row of rows) {
    const parentId = row.parent_id ? String(row.parent_id) : null;
    if (!parentId) continue;
    const bucket = childrenByParent.get(parentId) || [];
    bucket.push(String(row.id));
    childrenByParent.set(parentId, bucket);
  }

  const visited = new Set();
  const queue = [...seeds];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const children = childrenByParent.get(current) || [];
    for (const childId of children) {
      if (!visited.has(childId)) queue.push(childId);
    }
  }
  return [...visited];
};

const resolveFacilitiesFromGeographyScope = async ({ tenantId, geographyIds = [] }) => {
  const geoIds = uniqueIds(geographyIds);
  if (!tenantId || geoIds.length === 0) return [];
  const rows = await Facility.findAll({
    where: {
      tenant_id: tenantId,
      geography_id: { [Op.in]: geoIds },
    },
    attributes: ['id'],
    raw: true,
  });
  return uniqueIds(rows.map((row) => row.id));
};

const resolveFacilitiesFromAssignedTasks = async ({ tenantId, userId }) => {
  if (!tenantId || !userId) return [];
  const rows = await InspectionTask.findAll({
    where: {
      tenant_id: tenantId,
      assigned_to_user_id: userId,
      status: { [Op.ne]: 'cancelled' },
    },
    attributes: ['facility_id'],
    raw: true,
  });
  return uniqueIds(rows.map((row) => row.facility_id));
};

const resolveEffectiveScope = async ({
  roleCode,
  roleProfile,
  memberships = [],
  assignments = [],
  activeTenantId = null,
  userId = null,
  fallbackGeographyId = null,
}) => {
  const profileScopeLevel = roleProfile?.scopeLevel || ScopeLevels.ORGANIZATION;
  const fixedRoleScopeLevel = resolveScopedRoleLevel(roleCode);

  if (!activeTenantId) {
    return {
      scopeLevel: profileScopeLevel,
      scopeId: null,
      scopeIds: [],
      scopeGeographyIds: [],
      scopeFacilityIds: [],
    };
  }

  if (profileScopeLevel === ScopeLevels.PLATFORM) {
    return {
      scopeLevel: ScopeLevels.PLATFORM,
      scopeId: null,
      scopeIds: [],
      scopeGeographyIds: [],
      scopeFacilityIds: [],
    };
  }

  if (profileScopeLevel === ScopeLevels.ORGANIZATION && !fixedRoleScopeLevel) {
    const geoIds = assignmentGeographyIds(assignments);
    const facilityIds = assignmentFacilityIds(assignments);
    if (facilityIds.length > 0) {
      return {
        scopeLevel: ScopeLevels.FACILITY,
        scopeId: facilityIds[0],
        scopeIds: facilityIds,
        scopeGeographyIds: geoIds,
        scopeFacilityIds: facilityIds,
      };
    }

    const membershipGeoId =
      resolveSeedScopeFromMemberships({
        roleCode,
        memberships,
        activeTenantId,
      }) || fallbackGeographyId;
    if (membershipGeoId) {
      const expandedGeographyIds = await expandDescendantGeographies({
        tenantId: activeTenantId,
        seedGeographyIds: [membershipGeoId],
      });
      const derivedFacilityIds = await resolveFacilitiesFromGeographyScope({
        tenantId: activeTenantId,
        geographyIds: expandedGeographyIds,
      });
      return {
        scopeLevel: profileScopeLevel,
        scopeId: membershipGeoId,
        scopeIds: expandedGeographyIds,
        scopeGeographyIds: expandedGeographyIds,
        scopeFacilityIds: derivedFacilityIds,
      };
    }

    return {
      scopeLevel: ScopeLevels.ORGANIZATION,
      scopeId: activeTenantId,
      scopeIds: [activeTenantId],
      scopeGeographyIds: [],
      scopeFacilityIds: [],
    };
  }

  if (fixedRoleScopeLevel === ScopeLevels.FACILITY || profileScopeLevel === ScopeLevels.FACILITY) {
    const roleFacilityIds = assignmentFacilityIds(assignments, roleCode);
    let fallbackFacilityIds =
      roleFacilityIds.length > 0 ? roleFacilityIds : assignmentFacilityIds(assignments);
    if (fallbackFacilityIds.length === 0) {
      fallbackFacilityIds = await resolveFacilitiesFromAssignedTasks({
        tenantId: activeTenantId,
        userId,
      });
    }
    const roleGeographyIds = assignmentGeographyIds(assignments, roleCode);
    const fallbackGeographyIds =
      roleGeographyIds.length > 0 ? roleGeographyIds : assignmentGeographyIds(assignments);
    return {
      scopeLevel: ScopeLevels.FACILITY,
      scopeId: fallbackFacilityIds[0] || null,
      scopeIds: fallbackFacilityIds,
      scopeGeographyIds: fallbackGeographyIds,
      scopeFacilityIds: fallbackFacilityIds,
    };
  }

  const geographySeed =
    resolveSeedScopeFromMemberships({
      roleCode,
      memberships,
      activeTenantId,
    }) ||
    assignmentGeographyIds(assignments, roleCode)[0] ||
    assignmentGeographyIds(assignments)[0] ||
    fallbackGeographyId ||
    null;

  if (!geographySeed) {
    return {
      scopeLevel: fixedRoleScopeLevel || profileScopeLevel,
      scopeId: null,
      scopeIds: [],
      scopeGeographyIds: [],
      scopeFacilityIds: [],
    };
  }

  const expandedGeographyIds = await expandDescendantGeographies({
    tenantId: activeTenantId,
    seedGeographyIds: [geographySeed],
  });
  const derivedFacilityIds = await resolveFacilitiesFromGeographyScope({
    tenantId: activeTenantId,
    geographyIds: expandedGeographyIds,
  });

  return {
    scopeLevel: fixedRoleScopeLevel || profileScopeLevel,
    scopeId: geographySeed,
    scopeIds: expandedGeographyIds,
    scopeGeographyIds: expandedGeographyIds,
    scopeFacilityIds: derivedFacilityIds,
  };
};

module.exports = {
  uniqueIds,
  resolveEffectiveScope,
  expandDescendantGeographies,
  resolveFacilitiesFromGeographyScope,
  resolveFacilitiesFromAssignedTasks,
};
