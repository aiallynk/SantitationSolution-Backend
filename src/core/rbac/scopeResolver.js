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
    // A tenant activation copy may point at a platform/global geography rather
    // than using it as its parent. Keep both sides of that identity in the
    // traversal, but never load another tenant's geography rows.
    where: {
      is_active: true,
      [Op.or]: [{ tenant_id: tenantId }, { tenant_id: null }],
    },
    attributes: ['id', 'parent_id', 'global_geography_id', 'master_geography_id'],
    raw: true,
  });

  const childrenByParent = new Map();
  const rowsByIdentityId = new Map();
  const rowsById = new Map();
  for (const row of rows) {
    const rowId = String(row.id || '').trim();
    if (!rowId) continue;
    rowsById.set(rowId, row);

    const parentId = row.parent_id ? String(row.parent_id) : null;
    if (parentId) {
      const bucket = childrenByParent.get(parentId) || [];
      bucket.push(rowId);
      childrenByParent.set(parentId, bucket);
    }

    for (const identityId of uniqueIds([
      rowId,
      row.global_geography_id,
      row.master_geography_id,
    ])) {
      const bucket = rowsByIdentityId.get(identityId) || [];
      bucket.push(rowId);
      rowsByIdentityId.set(identityId, bucket);
    }
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

    const currentRow = rowsById.get(current);
    const identityIds = currentRow
      ? uniqueIds([
          currentRow.id,
          currentRow.global_geography_id,
          currentRow.master_geography_id,
        ])
      : [current];
    for (const identityId of identityIds) {
      for (const relatedId of rowsByIdentityId.get(identityId) || []) {
        if (!visited.has(relatedId)) queue.push(relatedId);
      }
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
