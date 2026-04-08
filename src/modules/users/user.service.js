const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  sequelize,
  PlatformUser,
  Role,
  Permission,
  UserRole,
  Tenant,
  Geography,
  Facility,
  ToiletUnit,
  WorkerAssignment,
} = require('../../models');
const { normalizePagination, sanitizeText } = require('../../utils/validators');
const { createAuditLog } = require('../audit/audit.service');
const { assertRoleScopeRequirements } = require('../../core/rbac/roleScopeRules');
const {
  getPersonaFamily,
  getRequiredScopeType,
  normalizeRoleCode,
} = require('../../core/rbac/personaFamilies');
const {
  assertRoleDelegationAllowed,
  uniqueNormalizedRoleCodes,
} = require('../../core/rbac/roleDelegationRules');
const {
  isGeographyInScope,
  isFacilityInScope,
} = require('../../core/rbac/scopeWhere');

const GLOBAL_ROLE_CODES = new Set(['super_admin', 'platform_ops']);

const unique = (values) => [...new Set(values)];
const normalizeRoleCodes = (roleCodes = []) =>
  uniqueNormalizedRoleCodes(roleCodes).map((roleCode) => normalizeRoleCode(roleCode));

const toStatus = (value, fallback = 'active') => {
  const normalized = String(value || fallback).toLowerCase();
  if (['active', 'inactive', 'locked'].includes(normalized)) return normalized;
  return fallback;
};

const buildUserInclude = ({ roleCode } = {}) => {
  const roleInclude = {
    model: Role,
    attributes: ['id', 'code', 'name', 'description'],
    through: { attributes: ['tenant_id', 'geography_id'] },
    include: [{ model: Permission, attributes: ['id', 'code', 'name'] }],
  };

  if (roleCode) {
    roleInclude.where = { code: roleCode };
    roleInclude.required = true;
  }

  return [
    roleInclude,
    {
      model: Tenant,
      attributes: ['id', 'name', 'code', 'status'],
    },
  ];
};

const mapRoleMemberships = (user) => {
  return unique(
    (user.Roles || []).map((role) => {
      const tenantId = role?.UserRole?.tenant_id || user.tenant_id || null;
      const geographyId = role?.UserRole?.geography_id || user.geography_id || null;
      return JSON.stringify({
        roleCode: role.code,
        roleName: role.name,
        tenantId,
        geographyId,
        global: GLOBAL_ROLE_CODES.has(role.code),
      });
    })
  ).map((serialized) => JSON.parse(serialized));
};

const mapPermissions = (user) =>
  unique(
    (user.Roles || []).flatMap((role) =>
      (role.Permissions || []).map((permission) => permission.code)
    )
  );

const mapAssignment = (row) => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  assignmentLevel: row.assignment_level,
  assignmentRole: row.assignment_role,
  status: row.status,
  geographyId: row.geography_id,
  geographyName: row.geography?.name || null,
  geographyLevel: row.geography?.level || null,
  facilityId: row.facility_id,
  facilityCode: row.facility?.code || null,
  facilityName: row.facility?.name || null,
  toiletUnitId: row.toilet_unit_id,
  toiletUnitCode: row.toiletUnit?.code || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const getAssignmentsByUserIds = async (userIds, { transaction } = {}) => {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();

  const rows = await WorkerAssignment.findAll({
    where: {
      user_id: { [Op.in]: userIds },
      status: 'active',
    },
    include: [
      {
        model: Geography,
        as: 'geography',
        attributes: ['id', 'name', 'level'],
      },
      {
        model: Facility,
        as: 'facility',
        attributes: ['id', 'code', 'name'],
      },
      {
        model: ToiletUnit,
        as: 'toiletUnit',
        attributes: ['id', 'code', 'unit_type'],
      },
    ],
    order: [['created_at', 'DESC']],
    transaction,
  });

  const grouped = new Map();
  for (const row of rows) {
    const bucket = grouped.get(row.user_id) || [];
    bucket.push(mapAssignment(row));
    grouped.set(row.user_id, bucket);
  }
  return grouped;
};

const toPayload = (user, assignmentsByUserId = new Map()) => {
  const memberships = mapRoleMemberships(user);
  const permissions = mapPermissions(user);

  return {
    id: user.id,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    employeeCode: user.employee_code || null,
    tenantId: user.tenant_id,
    tenantName: user.Tenant?.name || null,
    tenantCode: user.Tenant?.code || null,
    geographyId: user.geography_id,
    status: user.status,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    metadata: user.metadata || null,
    roleCodes: unique((user.Roles || []).map((role) => role.code)),
    roleNames: unique((user.Roles || []).map((role) => role.name)),
    permissions,
    memberships,
    assignments: assignmentsByUserId.get(user.id) || [],
  };
};

const isUserWithinScope = (req, user, assignments = []) => {
  if (req.user?.isSuperAdmin) return true;
  if (user.tenant_id !== req.user.tenantId) return false;

  const scopedGeographyIds = new Set(
    (Array.isArray(req.user?.scopeGeographyIds) ? req.user.scopeGeographyIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  const scopedFacilityIds = new Set(
    (Array.isArray(req.user?.scopeFacilityIds) ? req.user.scopeFacilityIds : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  if (scopedGeographyIds.size === 0 && scopedFacilityIds.size === 0) {
    return true;
  }

  const userGeographyId = String(user.geography_id || '').trim();
  if (userGeographyId && scopedGeographyIds.has(userGeographyId)) {
    return true;
  }

  for (const assignment of Array.isArray(assignments) ? assignments : []) {
    const assignmentGeographyId = String(assignment?.geographyId || assignment?.geography_id || '').trim();
    if (assignmentGeographyId && scopedGeographyIds.has(assignmentGeographyId)) {
      return true;
    }
    const assignmentFacilityId = String(assignment?.facilityId || assignment?.facility_id || '').trim();
    if (assignmentFacilityId && scopedFacilityIds.has(assignmentFacilityId)) {
      return true;
    }
  }

  return false;
};

const assertUserScope = (req, user, assignments = []) => {
  if (!req.user.isSuperAdmin && user.tenant_id !== req.user.tenantId) {
    throw new AppError('Cannot access user outside your tenant', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
  if (!isUserWithinScope(req, user, assignments)) {
    throw new AppError('Cannot access user outside your scope', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }
};

const hasGlobalRole = (roleCodes) => roleCodes.some((code) => GLOBAL_ROLE_CODES.has(code));
const hasTenantRole = (roleCodes) => roleCodes.some((code) => !GLOBAL_ROLE_CODES.has(code));

const ensureTenantExists = async (tenantId, { transaction } = {}) => {
  if (!tenantId) return null;
  const tenant = await Tenant.findByPk(tenantId, {
    attributes: ['id', 'name', 'code', 'status'],
    transaction,
  });
  if (!tenant) {
    throw new AppError('Tenant not found', 404, { code: 'TENANT_NOT_FOUND' });
  }
  return tenant;
};

const ensureGeographyScope = async ({ geographyId, tenantId, transaction }) => {
  if (!geographyId) return null;
  const geography = await Geography.findByPk(geographyId, { transaction });
  if (!geography || geography.tenant_id !== tenantId) {
    throw new AppError('geographyId is outside tenant scope', 400, {
      code: 'GEOGRAPHY_SCOPE_INVALID',
    });
  }
  return geography;
};

const ensureFacilityScope = async ({ facilityId, tenantId, transaction }) => {
  if (!facilityId) return null;
  const facility = await Facility.findByPk(facilityId, { transaction });
  if (!facility || facility.tenant_id !== tenantId) {
    throw new AppError('facilityId is outside tenant scope', 400, {
      code: 'FACILITY_SCOPE_INVALID',
    });
  }
  return facility;
};

const ensureToiletUnitScope = async ({ toiletUnitId, tenantId, transaction }) => {
  if (!toiletUnitId) return null;
  const toiletUnit = await ToiletUnit.findByPk(toiletUnitId, {
    include: [{ model: Facility, attributes: ['id', 'tenant_id', 'geography_id'] }],
    transaction,
  });
  if (!toiletUnit || toiletUnit.Facility?.tenant_id !== tenantId) {
    throw new AppError('toiletUnitId is outside tenant scope', 400, {
      code: 'TOILET_UNIT_SCOPE_INVALID',
    });
  }
  return toiletUnit;
};

const resolveRoles = async (roleCodes, { transaction } = {}) => {
  const roles = await Role.findAll({
    where: { code: { [Op.in]: roleCodes } },
    transaction,
  });
  if (roles.length !== roleCodes.length) {
    throw new AppError('One or more role codes are invalid', 400, {
      code: 'ROLE_NOT_FOUND',
    });
  }
  return roles;
};

const resolveCreateTenantId = ({ req, requestedTenantId, roleCodes }) => {
  if (!req.user.isSuperAdmin && requestedTenantId && requestedTenantId !== req.user.tenantId) {
    throw new AppError('Cannot assign users to another tenant', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }

  if (!req.user.isSuperAdmin && hasGlobalRole(roleCodes)) {
    throw new AppError('Only super admin can assign platform roles', 403, {
      code: 'ROLE_SCOPE_FORBIDDEN',
    });
  }

  const tenantId = req.user.isSuperAdmin ? requestedTenantId : req.user.tenantId;

  if (req.user.isSuperAdmin && hasTenantRole(roleCodes) && !tenantId) {
    throw new AppError('tenantId is required for tenant-scoped roles', 400, {
      code: 'TENANT_REQUIRED',
    });
  }

  if (req.user.isSuperAdmin && hasGlobalRole(roleCodes) && tenantId) {
    throw new AppError('Global platform roles cannot be tenant-scoped', 400, {
      code: 'INVALID_GLOBAL_ROLE_SCOPE',
    });
  }

  if (!req.user.isSuperAdmin && !tenantId) {
    throw new AppError('Authenticated user has no tenant scope', 403, {
      code: 'TENANT_CONTEXT_REQUIRED',
    });
  }

  return tenantId || null;
};

const normalizeAssignments = ({ req, roleCodes, tenantId, bodyAssignments, geographyId }) => {
  const explicitAssignments = Array.isArray(bodyAssignments) ? bodyAssignments : [];
  if (explicitAssignments.length > 0) {
    return explicitAssignments;
  }

  if (tenantId && geographyId) {
    return [
      {
        geographyId,
        assignmentLevel: 'geography',
        assignmentRole: roleCodes[0] || 'worker',
      },
    ];
  }

  if (tenantId && !req.user.isSuperAdmin && hasTenantRole(roleCodes)) {
    return [
      {
        assignmentLevel: 'tenant',
        assignmentRole: roleCodes[0] || 'worker',
      },
    ];
  }

  return [];
};

const replaceAssignments = async ({
  req,
  user,
  tenantId,
  roleCodes,
  assignments,
  actorUserId,
  transaction,
}) => {
  await WorkerAssignment.destroy({
    where: { user_id: user.id },
    transaction,
  });

  if (!tenantId || !Array.isArray(assignments) || assignments.length === 0) {
    return;
  }

  const rows = [];

  for (const assignmentRaw of assignments) {
    const assignment = assignmentRaw || {};
    const geography = await ensureGeographyScope({
      geographyId: assignment.geographyId || null,
      tenantId,
      transaction,
    });
    const facility = await ensureFacilityScope({
      facilityId: assignment.facilityId || null,
      tenantId,
      transaction,
    });

    if (geography && !isGeographyInScope(req, geography.id)) {
      throw new AppError('assignment geography is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }
    if (facility && !isFacilityInScope(req, facility.id)) {
      throw new AppError('assignment facility is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }
    if (toiletUnit && !isFacilityInScope(req, toiletUnit.facility_id || null)) {
      throw new AppError('assignment toilet unit is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }
    const toiletUnit = await ensureToiletUnitScope({
      toiletUnitId: assignment.toiletUnitId || null,
      tenantId,
      transaction,
    });

    const inferredLevel =
      assignment.assignmentLevel ||
      (toiletUnit
        ? 'toilet_unit'
        : facility
          ? 'facility'
          : geography
            ? 'geography'
            : 'tenant');

    rows.push({
      tenant_id: tenantId,
      user_id: user.id,
      geography_id: geography?.id || facility?.geography_id || null,
      facility_id: facility?.id || toiletUnit?.facility_id || null,
      toilet_unit_id: toiletUnit?.id || null,
      assignment_level: inferredLevel,
      assignment_role: sanitizeText(assignment.assignmentRole || roleCodes[0] || 'worker', 80),
      status: assignment.status === 'inactive' ? 'inactive' : 'active',
      created_by_user_id: actorUserId,
      updated_by_user_id: actorUserId,
    });
  }

  if (rows.length > 0) {
    await WorkerAssignment.bulkCreate(rows, { transaction });
  }
};

const listUsers = async (req) => {
  const { page, limit, offset } = normalizePagination(req.query);
  const where = {};
  const q = sanitizeText(req.query.q || req.query.search || '', 120);
  if (q) {
    where[Op.or] = [
      { full_name: { [Op.iLike]: `%${q}%` } },
      { email: { [Op.iLike]: `%${q}%` } },
      { phone: { [Op.iLike]: `%${q}%` } },
      { employee_code: { [Op.iLike]: `%${q}%` } },
    ];
  }

  if (req.query.status) {
    where.status = toStatus(req.query.status);
  }

  if (!req.user.isSuperAdmin) {
    where.tenant_id = req.user.tenantId;
  } else if (req.query.tenantId) {
    where.tenant_id = req.query.tenantId;
  }

  const include = buildUserInclude({ roleCode: req.query.roleCode });

  const rows = await PlatformUser.findAll({
    where,
    include,
    order: [['created_at', 'DESC']],
    distinct: true,
  });

  const userIds = rows.map((user) => user.id);
  const assignmentsByUserId = await getAssignmentsByUserIds(userIds);
  const scopedRows = rows.filter((user) =>
    isUserWithinScope(req, user, assignmentsByUserId.get(user.id) || [])
  );
  const pagedRows = scopedRows.slice(offset, offset + limit);
  const count = scopedRows.length;

  return {
    items: pagedRows.map((user) => toPayload(user, assignmentsByUserId)),
    meta: {
      page,
      limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / limit)),
    },
  };
};

const getUserById = async (req) => {
  const user = await PlatformUser.findByPk(req.params.id, {
    include: buildUserInclude(),
  });
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }
  const assignmentsByUserId = await getAssignmentsByUserIds([user.id]);
  const userAssignments = assignmentsByUserId.get(user.id) || [];
  assertUserScope(req, user, userAssignments);

  return toPayload(user, assignmentsByUserId);
};

const createUser = async (req) => {
  const roleCodes = normalizeRoleCodes(req.body.roleCodes || []);
  if (roleCodes.length === 0) {
    throw new AppError('roleCodes must be a non-empty array', 400, {
      code: 'VALIDATION_ERROR',
    });
  }

  assertRoleDelegationAllowed({
    actorRoleCodes: req.user.roleCodes || req.user.allRoleCodes || [],
    targetRoleCodes: roleCodes,
    isSuperAdmin: Boolean(req.user.isSuperAdmin),
  });

  const requestedTenantId = req.body.tenantId || null;
  const tenantId = resolveCreateTenantId({
    req,
    requestedTenantId,
    roleCodes,
  });

  return sequelize.transaction(async (transaction) => {
    await resolveRoles(roleCodes, { transaction });
    await ensureTenantExists(tenantId, { transaction });
    const resolvedGeography = await ensureGeographyScope({
      geographyId: req.body.geographyId || null,
      tenantId,
      transaction,
    });
    if (resolvedGeography && !isGeographyInScope(req, resolvedGeography.id)) {
      throw new AppError('geographyId is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }

    const normalizedEmail = String(req.body.email).trim().toLowerCase();
    const existing = await PlatformUser.findOne({
      where: { email: normalizedEmail },
      transaction,
    });
    if (existing) {
      throw new AppError('Email already exists', 409, { code: 'EMAIL_EXISTS' });
    }

    if (tenantId && req.body.employeeCode) {
      const duplicateEmployeeCode = await PlatformUser.findOne({
        where: {
          tenant_id: tenantId,
          employee_code: sanitizeText(req.body.employeeCode, 64),
        },
        transaction,
      });
      if (duplicateEmployeeCode) {
        throw new AppError('employeeCode already exists in tenant scope', 409, {
          code: 'EMPLOYEE_CODE_EXISTS',
        });
      }
    }

    const passwordHash = await bcrypt.hash(req.body.password, 10);
    const user = await PlatformUser.create(
      {
        tenant_id: tenantId,
        geography_id: req.body.geographyId || null,
        full_name: sanitizeText(req.body.fullName, 180),
        email: normalizedEmail,
        phone: req.body.phone ? sanitizeText(req.body.phone, 32) : null,
        employee_code: req.body.employeeCode
          ? sanitizeText(req.body.employeeCode, 64)
          : null,
        password_hash: passwordHash,
        auth_provider: 'local',
        status: toStatus(req.body.status),
        metadata: req.body.metadata || null,
      },
      { transaction }
    );

    const roles = await resolveRoles(roleCodes, { transaction });
    await Promise.all(
      roles.map((role) =>
        UserRole.create(
          {
            user_id: user.id,
            role_id: role.id,
            tenant_id: tenantId,
            geography_id: req.body.geographyId || null,
          },
          { transaction }
        )
      )
    );

    const assignments = normalizeAssignments({
      req,
      roleCodes,
      tenantId,
      bodyAssignments: req.body.assignments,
      geographyId: req.body.geographyId || null,
    });
    assertRoleScopeRequirements({
      roleCodes,
      geographyId: req.body.geographyId || null,
      assignments,
    });

    await replaceAssignments({
      req,
      user,
      tenantId,
      roleCodes,
      assignments,
      actorUserId: req.user.id,
      transaction,
    });

    const payload = await PlatformUser.findByPk(user.id, {
      include: buildUserInclude(),
      transaction,
    });

    const assignmentsByUserId = await getAssignmentsByUserIds([user.id], {
      transaction,
    });

    await createAuditLog({
      req,
      action: 'users.create',
      entityType: 'platform_user',
      entityId: user.id,
      tenantId: user.tenant_id,
      details: {
        roleCodes,
        assignmentCount: assignments.length,
      },
    });

    return toPayload(payload, assignmentsByUserId);
  });
};

const patchUser = async (req) => {
  const user = await PlatformUser.findByPk(req.params.id, {
    include: buildUserInclude(),
  });
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }
  const existingAssignmentsByUserId = await getAssignmentsByUserIds([user.id]);
  const existingUserAssignments = existingAssignmentsByUserId.get(user.id) || [];
  assertUserScope(req, user, existingUserAssignments);

  const nextTenantId = req.user.isSuperAdmin
    ? req.body.tenantId !== undefined
      ? req.body.tenantId
      : user.tenant_id
    : user.tenant_id;

  if (!req.user.isSuperAdmin && req.body.tenantId && req.body.tenantId !== req.user.tenantId) {
    throw new AppError('Cannot move user to another tenant', 403, {
      code: 'SCOPE_FORBIDDEN',
    });
  }

  return sequelize.transaction(async (transaction) => {
    await ensureTenantExists(nextTenantId, { transaction });
    const resolvedGeography = await ensureGeographyScope({
      geographyId: req.body.geographyId || user.geography_id,
      tenantId: nextTenantId,
      transaction,
    });
    if (resolvedGeography && !isGeographyInScope(req, resolvedGeography.id)) {
      throw new AppError('geographyId is outside actor scope', 403, {
        code: 'SCOPE_FORBIDDEN',
      });
    }

    const updates = {};
    if (req.body.fullName) updates.full_name = sanitizeText(req.body.fullName, 180);
    if (req.body.email !== undefined) {
      updates.email = String(req.body.email || '').trim().toLowerCase();
    }
    if (req.body.phone !== undefined) updates.phone = req.body.phone ? sanitizeText(req.body.phone, 32) : null;
    if (req.body.status) updates.status = toStatus(req.body.status, user.status);
    if (req.body.password) {
      updates.password_hash = await bcrypt.hash(req.body.password, 10);
    }
    if (req.body.employeeCode !== undefined) {
      updates.employee_code = req.body.employeeCode
        ? sanitizeText(req.body.employeeCode, 64)
        : null;
    }
    if (req.body.metadata !== undefined) {
      updates.metadata = req.body.metadata;
    }
    if (req.body.geographyId !== undefined) {
      updates.geography_id = req.body.geographyId || null;
    }
    if (req.user.isSuperAdmin && req.body.tenantId !== undefined) {
      updates.tenant_id = nextTenantId || null;
    }

    if (
      updates.email &&
      updates.email !== user.email
    ) {
      const duplicateEmail = await PlatformUser.findOne({
        where: {
          id: { [Op.ne]: user.id },
          email: updates.email,
        },
        transaction,
      });
      if (duplicateEmail) {
        throw new AppError('Email already exists', 409, { code: 'EMAIL_EXISTS' });
      }
    }

    if (
      updates.employee_code &&
      (updates.employee_code !== user.employee_code || updates.tenant_id !== user.tenant_id)
    ) {
      const duplicateEmployeeCode = await PlatformUser.findOne({
        where: {
          id: { [Op.ne]: user.id },
          tenant_id: updates.tenant_id ?? user.tenant_id,
          employee_code: updates.employee_code,
        },
        transaction,
      });
      if (duplicateEmployeeCode) {
        throw new AppError('employeeCode already exists in tenant scope', 409, {
          code: 'EMPLOYEE_CODE_EXISTS',
        });
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date();
      await user.update(updates, { transaction });
    }
    const nextGeographyId = Object.prototype.hasOwnProperty.call(updates, 'geography_id')
      ? updates.geography_id
      : user.geography_id;

    let roleCodes = unique((user.Roles || []).map((role) => role.code));
    if (Array.isArray(req.body.roleCodes) && req.body.roleCodes.length > 0) {
      roleCodes = normalizeRoleCodes(req.body.roleCodes);
      if (!req.user.isSuperAdmin && hasGlobalRole(roleCodes)) {
        throw new AppError('Only super admin can assign platform roles', 403, {
          code: 'ROLE_SCOPE_FORBIDDEN',
        });
      }
      assertRoleDelegationAllowed({
        actorRoleCodes: req.user.roleCodes || req.user.allRoleCodes || [],
        targetRoleCodes: roleCodes,
        isSuperAdmin: Boolean(req.user.isSuperAdmin),
      });
      if (req.user.isSuperAdmin && hasTenantRole(roleCodes) && !nextTenantId) {
        throw new AppError('Cannot assign tenant-scoped role without tenant', 400, {
          code: 'TENANT_REQUIRED',
        });
      }
      if (req.user.isSuperAdmin && hasGlobalRole(roleCodes) && nextTenantId) {
        throw new AppError('Cannot assign global platform role to tenant-scoped user', 400, {
          code: 'INVALID_ROLE_SCOPE',
        });
      }

      const roles = await resolveRoles(roleCodes, { transaction });
      await UserRole.destroy({ where: { user_id: user.id }, transaction });
      await Promise.all(
        roles.map((role) =>
          UserRole.create(
            {
              user_id: user.id,
              role_id: role.id,
              tenant_id: nextTenantId,
              geography_id: nextGeographyId,
            },
            { transaction }
          )
        )
      );
    }

    const shouldReplaceAssignments =
      req.body.assignments !== undefined ||
      req.body.geographyId !== undefined ||
      req.body.clearAssignments === true;

    let nextAssignmentsForScopeValidation = null;
    if (shouldReplaceAssignments) {
      const assignments = req.body.clearAssignments
        ? []
        : normalizeAssignments({
            req,
            roleCodes,
            tenantId: nextTenantId,
            bodyAssignments: req.body.assignments,
            geographyId: nextGeographyId,
          });
      nextAssignmentsForScopeValidation = assignments;

      await replaceAssignments({
        req,
        user,
        tenantId: nextTenantId,
        roleCodes,
        assignments,
        actorUserId: req.user.id,
        transaction,
      });
    }

    const shouldValidateRoleScope =
      Array.isArray(req.body.roleCodes) ||
      req.body.geographyId !== undefined ||
      req.body.assignments !== undefined ||
      req.body.clearAssignments === true;

    if (shouldValidateRoleScope) {
      if (!nextAssignmentsForScopeValidation) {
        const existingAssignments = await WorkerAssignment.findAll({
          where: {
            user_id: user.id,
            status: 'active',
          },
          attributes: ['geography_id', 'facility_id', 'toilet_unit_id'],
          transaction,
        });
        nextAssignmentsForScopeValidation = existingAssignments.map((assignment) => ({
          geographyId: assignment.geography_id || null,
          facilityId: assignment.facility_id || null,
          toiletUnitId: assignment.toilet_unit_id || null,
        }));
      }
      assertRoleScopeRequirements({
        roleCodes,
        geographyId: nextGeographyId || null,
        assignments: nextAssignmentsForScopeValidation,
      });
    }

    const payload = await PlatformUser.findByPk(user.id, {
      include: buildUserInclude(),
      transaction,
    });
    const assignmentsByUserId = await getAssignmentsByUserIds([user.id], {
      transaction,
    });

    await createAuditLog({
      req,
      action: 'users.update',
      entityType: 'platform_user',
      entityId: user.id,
      tenantId: payload.tenant_id,
      details: {
        changedFields: Object.keys(req.body || {}),
      },
    });

    return toPayload(payload, assignmentsByUserId);
  });
};

const listRoles = async () => {
  const roles = await Role.findAll({
    include: [{ model: Permission, attributes: ['id', 'code', 'name'] }],
    order: [['name', 'ASC']],
  });
  return roles.map((role) => ({
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    personaFamily: getPersonaFamily(role.code),
    requiredScopeType: getRequiredScopeType(role.code),
    permissionCodes: unique((role.Permissions || []).map((permission) => permission.code)),
  }));
};

const listPermissions = async () => {
  const permissions = await Permission.findAll({ order: [['name', 'ASC']] });
  return permissions.map((permission) => ({
    id: permission.id,
    code: permission.code,
    name: permission.name,
    description: permission.description,
  }));
};

module.exports = {
  listUsers,
  getUserById,
  createUser,
  patchUser,
  listRoles,
  listPermissions,
};
