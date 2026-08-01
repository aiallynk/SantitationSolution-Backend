const { Op } = require('sequelize');
const { Geography, Facility, InspectionTask, Tenant } = require('../../models');
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
      [Op.or]: [
        { geography_id: { [Op.in]: geoIds } },
        { zone_geography_id: { [Op.in]: geoIds } },
        { ward_geography_id: { [Op.in]: geoIds } },
      ],
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

const resolveLegacyFacilitiesFromNamedTenantScope = async ({
  tenantId,
  scopeLevel,
  scopeLocationNames = {},
}) => {
  const requiredFieldsByLevel = {
    country: ['countryName'],
    state: ['countryName', 'stateName'],
    district: ['countryName', 'stateName', 'districtName'],
    city: ['countryName', 'stateName', 'districtName', 'cityName'],
  };
  const requiredFields = requiredFieldsByLevel[String(scopeLevel || '').toLowerCase()] || [];
  if (!tenantId || requiredFields.length === 0) return [];

  const tenant = await Tenant.findByPk(tenantId, {
    attributes: ['country_name', 'state_name', 'district_name', 'city_name'],
    raw: true,
  });
  if (!tenant) return [];

  const tenantNames = {
    countryName: tenant.country_name,
    stateName: tenant.state_name,
    districtName: tenant.district_name,
    cityName: tenant.city_name,
  };
  const matchesTenantBaseline = requiredFields.every((field) => {
    const expected = String(scopeLocationNames[field] || '').trim().toLowerCase();
    const actual = String(tenantNames[field] || '').trim().toLowerCase();
    return expected && actual && expected === actual;
  });
  if (!matchesTenantBaseline) return [];

  const facilities = await Facility.findAll({
    where: { tenant_id: tenantId },
    attributes: ['id'],
    raw: true,
  });
  return uniqueIds(facilities.map((row) => row.id));
};

const resolveEffectiveScope = async ({
  roleCode,
  roleProfile,
  memberships = [],
  assignments = [],
  activeTenantId = null,
  userId = null,
  fallbackGeographyId = null,
  scopeLocationNames = {},
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
    const roleGeographyIds = assignmentGeographyIds(assignments, roleCode);
    let fallbackGeographyIds =
      roleGeographyIds.length > 0 ? roleGeographyIds : assignmentGeographyIds(assignments);

    if (fallbackGeographyIds.length > 0) {
      fallbackGeographyIds = await expandDescendantGeographies({
        tenantId: activeTenantId,
        seedGeographyIds: fallbackGeographyIds,
      });
    }

    // Support zone/ward geography assignments for facility-scoped personas
    // by deriving the reachable facilities in that geography tree.
    if (fallbackFacilityIds.length === 0 && fallbackGeographyIds.length > 0) {
      fallbackFacilityIds = await resolveFacilitiesFromGeographyScope({
        tenantId: activeTenantId,
        geographyIds: fallbackGeographyIds,
      });
    }

    if (fallbackFacilityIds.length === 0) {
      fallbackFacilityIds = await resolveFacilitiesFromAssignedTasks({
        tenantId: activeTenantId,
        userId,
      });
    }
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
    const roleFacilityIds = assignmentFacilityIds(assignments, roleCode);
    const fallbackFacilityIds =
      roleFacilityIds.length > 0 ? roleFacilityIds : assignmentFacilityIds(assignments);
    if (fallbackFacilityIds.length > 0) {
      const fallbackGeographyIds = assignmentGeographyIds(assignments, roleCode);
      return {
        scopeLevel: fixedRoleScopeLevel || profileScopeLevel,
        scopeId: fallbackFacilityIds[0],
        scopeIds: fallbackFacilityIds,
        scopeGeographyIds: fallbackGeographyIds,
        scopeFacilityIds: fallbackFacilityIds,
      };
    }
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
  let derivedFacilityIds = await resolveFacilitiesFromGeographyScope({
    tenantId: activeTenantId,
    geographyIds: expandedGeographyIds,
  });
  if (derivedFacilityIds.length === 0) {
    derivedFacilityIds = await resolveLegacyFacilitiesFromNamedTenantScope({
      tenantId: activeTenantId,
      scopeLevel: fixedRoleScopeLevel || profileScopeLevel,
      scopeLocationNames,
    });
  }

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
  resolveLegacyFacilitiesFromNamedTenantScope,
};
