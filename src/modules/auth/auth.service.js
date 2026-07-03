const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Op } = require('sequelize');
const AppError = require('../../core/errors/AppError');
const {
  PlatformUser,
  Role,
  Permission,
  LoginSession,
  PasswordResetToken,
  Tenant,
  WorkerAssignment,
  BackupSchedule,
} = require('../../models');
const { resolveRoleProfile } = require('../../core/rbac/accessProfiles');
const { resolveEffectiveScope, uniqueIds } = require('../../core/rbac/scopeResolver');
const {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  decodeTokenExpiry,
} = require('./token.service');
const { createAuditLog } = require('../audit/audit.service');
const { runtimeConfig } = require('../../config/runtime');
const { isValidIanaTimezone } = require('../../utils/timezone');
const { nextDailyRun } = require('../backups/backupSchedule');

const GLOBAL_ROLE_CODES = new Set(['super_admin', 'platform_ops']);

const includeRolePermission = [
  {
    model: Role,
    attributes: ['id', 'code', 'name'],
    through: {
      attributes: ['tenant_id', 'geography_id'],
    },
    include: [{ model: Permission, attributes: ['id', 'code', 'name'] }],
  },
  {
    model: Tenant,
    attributes: ['id', 'name', 'code', 'status'],
  },
  {
    model: WorkerAssignment,
    as: 'assignments',
    required: false,
    where: { status: 'active' },
    attributes: [
      'id',
      'tenant_id',
      'geography_id',
      'facility_id',
      'toilet_unit_id',
      'assignment_level',
      'assignment_role',
      'status',
    ],
  },
];

const normalizeMemberships = (user) => {
  const seen = new Set();
  const memberships = [];
  for (const role of user.Roles || []) {
    const tenantId = role?.UserRole?.tenant_id || user.tenant_id || null;
    const geographyId = role?.UserRole?.geography_id || user.geography_id || null;
    const key = `${role.code}:${tenantId || 'platform'}:${geographyId || 'global'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    memberships.push({
      roleCode: role.code,
      roleName: role.name,
      tenantId,
      geographyId,
      isGlobalRole: GLOBAL_ROLE_CODES.has(role.code),
    });
  }
  return memberships;
};

const unique = (values) => [...new Set(values)];

const resolveActiveTenantId = ({ user, requestedTenantId = null }) => {
  const memberships = normalizeMemberships(user);
  const isSuperAdmin = memberships.some((item) => item.roleCode === 'super_admin');
  if (isSuperAdmin) {
    return requestedTenantId || null;
  }

  const tenantScopedMemberships = memberships.filter((item) => !item.isGlobalRole && item.tenantId);
  const tenantIds = unique(tenantScopedMemberships.map((item) => item.tenantId));
  const hasGlobalOnlyAccess = memberships.length > 0 && tenantIds.length === 0;

  if (requestedTenantId && !tenantIds.includes(requestedTenantId)) {
    throw new AppError('Requested tenant is outside user membership scope', 403, {
      code: 'TENANT_SCOPE_FORBIDDEN',
    });
  }

  if (requestedTenantId) {
    return requestedTenantId;
  }

  if (tenantIds.length > 0) {
    return tenantIds[0];
  }

  if (user.tenant_id) {
    return user.tenant_id;
  }

  if (hasGlobalOnlyAccess) {
    return null;
  }

  throw new AppError('Active tenant context is required', 403, {
    code: 'TENANT_CONTEXT_REQUIRED',
  });
};

const deriveScopedAuth = (user, activeTenantId) => {
  const memberships = normalizeMemberships(user);
  const scopedRoles = [];

  for (const role of user.Roles || []) {
    const roleCode = role.code;
    const roleTenantId = role?.UserRole?.tenant_id || user.tenant_id || null;
    const isGlobalRole = GLOBAL_ROLE_CODES.has(roleCode);

    const inTenantScope =
      isGlobalRole ||
      (activeTenantId ? roleTenantId === activeTenantId : roleTenantId == null);

    if (!inTenantScope) continue;

    scopedRoles.push(roleCode);
  }

  const roleCodes = unique(scopedRoles);
  const allRoleCodes = unique((user.Roles || []).map((role) => role.code));
  const isSuperAdmin = allRoleCodes.includes('super_admin');
  const roleProfile = resolveRoleProfile({ roleCodes });
  const permissionCodes = new Set(
    Array.isArray(roleProfile.permissionCodes) ? roleProfile.permissionCodes : []
  );

  for (const role of user.Roles || []) {
    const roleCode = role.code;
    const roleTenantId = role?.UserRole?.tenant_id || user.tenant_id || null;
    const isGlobalRole = GLOBAL_ROLE_CODES.has(roleCode);
    const inTenantScope =
      isGlobalRole ||
      (activeTenantId ? roleTenantId === activeTenantId : roleTenantId == null);
    if (!inTenantScope) continue;

    for (const permission of role.Permissions || []) {
      permissionCodes.add(permission.code);
    }
  }

  return {
    primaryRoleCode: roleProfile.role || null,
    roleCodes,
    allRoleCodes,
    permissionCodes: [...permissionCodes],
    memberships,
    activeMemberships: memberships.filter((membership) => {
      if (membership.isGlobalRole) return true;
      if (!activeTenantId) return membership.tenantId == null;
      return membership.tenantId === activeTenantId;
    }),
    isSuperAdmin,
  };
};

const mapUser = async ({ user, activeTenantId }) => {
  const scoped = deriveScopedAuth(user, activeTenantId);
  const roleProfile = resolveRoleProfile({ roleCodes: scoped.roleCodes });
  const activeAssignments = (Array.isArray(user.assignments) ? user.assignments : []).filter(
    (row) => row.status === 'active',
  );
  const scope = await resolveEffectiveScope({
    roleCode: roleProfile.role || null,
    roleProfile,
    memberships: scoped.activeMemberships,
    assignments: activeAssignments,
    activeTenantId,
    userId: user.id,
    fallbackGeographyId: user.geography_id || null,
  });
  const assignmentFacilityIds = uniqueIds(
    activeAssignments.map((assignment) => assignment.facility_id || assignment.facilityId || null),
  );
  const assignmentGeographyIds = uniqueIds(
    activeAssignments.map((assignment) => assignment.geography_id || assignment.geographyId || null),
  );

  return {
    id: user.id,
    userIdCode: user.user_id_code || null,
    fullName: user.full_name,
    email: user.email,
    phone: user.phone,
    employeeCode: user.employee_code || null,
    remarks: user.remarks || null,
    countryName: user.country_name || null,
    stateName: user.state_name || null,
    districtName: user.district_name || null,
    cityName: user.city_name || null,
    zoneName: user.zone_name || null,
    wardName: user.ward_name || null,
    lastLoginAt: user.last_login_at || null,
    metadata: user.metadata || {},
    createdAt: user.created_at || null,
    updatedAt: user.updated_at || null,
    tenantId: activeTenantId,
    defaultTenantId: user.tenant_id,
    geographyId: user.geography_id,
    status: user.status,
    role: roleProfile.role || null,
    roleCodes: scoped.roleCodes,
    allRoleCodes: scoped.allRoleCodes,
    permissions: scoped.permissionCodes,
    roleType: roleProfile.roleType,
    personaFamily: roleProfile.personaFamily,
    hierarchyLevel: roleProfile.hierarchyLevel,
    surfaceType: roleProfile.surfaceType,
    scopeType: roleProfile.scopeType,
    managementLevel: roleProfile.managementLevel,
    scopeLevel: scope.scopeLevel,
    scopeId: scope.scopeId,
    scopeIds: scope.scopeIds,
    scopeGeographyIds: scope.scopeGeographyIds,
    scopeFacilityIds: scope.scopeFacilityIds,
    assignmentFacilityIds,
    assignmentGeographyIds,
    organizationId: activeTenantId,
    allowedRoutes: roleProfile.allowedRoutes,
    allowedActions: roleProfile.allowedActions,
    routeKeys: roleProfile.routeKeys,
    actionKeys: roleProfile.actionKeys,
    widgetKeys: roleProfile.widgetKeys,
    allowedDataDomains: roleProfile.allowedDataDomains,
    readOnly: Boolean(roleProfile.readOnly),
    defaultRoute: roleProfile.defaultRoute,
    webEnabled: roleProfile.webEnabled,
    mobileOnly: roleProfile.mobileOnly,
    canAccessWeb: roleProfile.canAccessWeb,
    canAccessMobile: roleProfile.canAccessMobile,
    tenantMemberships: scoped.memberships,
    activeMemberships: scoped.activeMemberships,
    activeTenant: user.Tenant
      ? {
          id: user.Tenant.id,
          name: user.Tenant.name,
          code: user.Tenant.code,
          status: user.Tenant.status,
        }
      : null,
  };
};

const fetchUserForAuth = (identifier) =>
  PlatformUser.findOne({
    where: {
      [Op.or]: [{ email: identifier.toLowerCase() }, { phone: identifier }],
    },
    include: includeRolePermission,
  });

const createSession = async (user, refreshToken, req) => {
  const sessionId = crypto.randomUUID();
  await LoginSession.create({
    id: sessionId,
    user_id: user.id,
    refresh_token_hash: hashToken(refreshToken),
    expires_at: decodeTokenExpiry(refreshToken),
    ip_address: req.ip || null,
    user_agent: req.headers['user-agent'] || null,
  });

  return sessionId;
};

const buildAuthPayload = async ({ user, accessToken, refreshToken, activeTenantId }) => {
  const mapped = await mapUser({ user, activeTenantId });
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresAt: decodeTokenExpiry(accessToken)?.toISOString() || null,
    role: mapped.role || null,
    roleType: mapped.roleType,
    personaFamily: mapped.personaFamily,
    hierarchyLevel: mapped.hierarchyLevel,
    surfaceType: mapped.surfaceType,
    scopeType: mapped.scopeType,
    managementLevel: mapped.managementLevel,
    roleCodes: mapped.roleCodes,
    allRoleCodes: mapped.allRoleCodes,
    permissions: mapped.permissions,
    scopeLevel: mapped.scopeLevel,
    scopeId: mapped.scopeId,
    scopeIds: mapped.scopeIds,
    scopeGeographyIds: mapped.scopeGeographyIds,
    scopeFacilityIds: mapped.scopeFacilityIds,
    organizationId: mapped.organizationId,
    allowedRoutes: mapped.allowedRoutes,
    allowedActions: mapped.allowedActions,
    routeKeys: mapped.routeKeys,
    actionKeys: mapped.actionKeys,
    widgetKeys: mapped.widgetKeys,
    allowedDataDomains: mapped.allowedDataDomains,
    readOnly: mapped.readOnly,
    defaultRoute: mapped.defaultRoute,
    webEnabled: mapped.webEnabled,
    mobileOnly: mapped.mobileOnly,
    canAccessWeb: mapped.canAccessWeb,
    canAccessMobile: mapped.canAccessMobile,
    tenantMemberships: mapped.tenantMemberships,
    activeMemberships: mapped.activeMemberships,
    activeTenantId,
    user: mapped,
  };
};

const login = async ({ identifier, password, tenantId, req }) => {
  const normalizedIdentifier = String(identifier || '').trim().toLowerCase();
  const user = await fetchUserForAuth(normalizedIdentifier);

  if (!user || !user.password_hash) {
    throw new AppError('Invalid credentials', 401, { code: 'INVALID_CREDENTIALS' });
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    throw new AppError('Invalid credentials', 401, { code: 'INVALID_CREDENTIALS' });
  }
  if (user.status !== 'active') {
    throw new AppError('User account is not active', 403, { code: 'USER_NOT_ACTIVE' });
  }

  const activeTenantId = resolveActiveTenantId({ user, requestedTenantId: tenantId || null });

  const accessToken = signAccessToken(user, { tenantId: activeTenantId });
  const refreshDraft = signRefreshToken(user, crypto.randomUUID(), { tenantId: activeTenantId });
  const sessionId = await createSession(user, refreshDraft, req);
  const refreshToken = signRefreshToken(user, sessionId, { tenantId: activeTenantId });

  await LoginSession.update(
    {
      refresh_token_hash: hashToken(refreshToken),
      expires_at: decodeTokenExpiry(refreshToken),
    },
    { where: { id: sessionId } }
  );

  await user.update({ last_login_at: new Date() });
  await createAuditLog({
    req,
    actorUserId: user.id,
    tenantId: activeTenantId,
    action: 'auth.login',
    entityType: 'platform_user',
    entityId: user.id,
    details: { email: user.email, activeTenantId },
  });

  return buildAuthPayload({ user, accessToken, refreshToken, activeTenantId });
};

const refresh = async ({ refreshToken, req }) => {
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (error) {
    throw new AppError('Invalid refresh token', 401, { code: 'INVALID_REFRESH_TOKEN' });
  }

  const session = await LoginSession.findByPk(decoded.sid);
  if (!session || session.revoked_at) {
    throw new AppError('Refresh session no longer valid', 401, { code: 'SESSION_REVOKED' });
  }
  if (new Date(session.expires_at) < new Date()) {
    throw new AppError('Refresh token has expired', 401, { code: 'REFRESH_EXPIRED' });
  }
  if (session.refresh_token_hash !== hashToken(refreshToken)) {
    throw new AppError('Refresh token mismatch', 401, { code: 'REFRESH_MISMATCH' });
  }

  const user = await PlatformUser.findByPk(decoded.sub, {
    include: includeRolePermission,
  });
  if (!user || user.status !== 'active') {
    throw new AppError('User account is not active', 403, { code: 'USER_NOT_ACTIVE' });
  }

  const activeTenantId = resolveActiveTenantId({
    user,
    requestedTenantId: decoded.tenantId || null,
  });

  const accessToken = signAccessToken(user, { tenantId: activeTenantId });
  const nextRefreshToken = signRefreshToken(user, session.id, { tenantId: activeTenantId });

  await session.update({
    refresh_token_hash: hashToken(nextRefreshToken),
    expires_at: decodeTokenExpiry(nextRefreshToken),
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    actorUserId: user.id,
    tenantId: activeTenantId,
    action: 'auth.refresh',
    entityType: 'login_session',
    entityId: session.id,
    details: { activeTenantId },
  });

  return buildAuthPayload({
    user,
    accessToken,
    refreshToken: nextRefreshToken,
    activeTenantId,
  });
};

const logout = async ({ refreshToken, req }) => {
  if (!refreshToken) {
    return { revoked: false };
  }
  let decoded = null;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (error) {
    return { revoked: false };
  }

  const session = await LoginSession.findByPk(decoded.sid);
  if (!session || session.revoked_at) {
    return { revoked: false };
  }

  await session.update({
    revoked_at: new Date(),
    updated_at: new Date(),
  });

  await createAuditLog({
    req,
    actorUserId: decoded.sub,
    tenantId: req.user?.tenantId || decoded.tenantId || null,
    action: 'auth.logout',
    entityType: 'login_session',
    entityId: session.id,
  });

  return { revoked: true };
};

const forgotPassword = async ({ email, req }) => {
  const user = await PlatformUser.findOne({
    where: { email: String(email).trim().toLowerCase() },
  });
  if (!user) {
    return { accepted: true };
  }

  const resetToken = crypto.randomBytes(24).toString('hex');
  await PasswordResetToken.create({
    user_id: user.id,
    token_hash: hashToken(resetToken),
    expires_at: new Date(Date.now() + runtimeConfig.auth.passwordResetTtlMs),
  });

  await createAuditLog({
    req,
    actorUserId: user.id,
    tenantId: user.tenant_id,
    action: 'auth.forgot_password',
    entityType: 'platform_user',
    entityId: user.id,
  });

  // In production this token should be sent through email/SMS provider.
  return {
    accepted: true,
    resetToken,
    expiresInMinutes: Math.round(runtimeConfig.auth.passwordResetTtlMs / 60000),
  };
};

const resetPassword = async ({ token, newPassword, req }) => {
  const tokenHash = hashToken(token);
  const tokenRow = await PasswordResetToken.findOne({
    where: {
      token_hash: tokenHash,
      used_at: null,
      expires_at: { [Op.gt]: new Date() },
    },
  });
  if (!tokenRow) {
    throw new AppError('Reset token is invalid or expired', 400, { code: 'RESET_TOKEN_INVALID' });
  }

  const user = await PlatformUser.findByPk(tokenRow.user_id);
  if (!user) {
    throw new AppError('User not found for reset token', 404, { code: 'USER_NOT_FOUND' });
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await user.update({ password_hash: passwordHash, updated_at: new Date() });
  await tokenRow.update({ used_at: new Date(), updated_at: new Date() });

  await LoginSession.update(
    { revoked_at: new Date(), updated_at: new Date() },
    { where: { user_id: user.id, revoked_at: null } }
  );

  await createAuditLog({
    req,
    actorUserId: user.id,
    tenantId: user.tenant_id,
    action: 'auth.reset_password',
    entityType: 'platform_user',
    entityId: user.id,
  });

  return { updated: true };
};

const verifyResetToken = async ({ token }) => {
  const tokenHash = hashToken(token);
  const tokenRow = await PasswordResetToken.findOne({
    where: {
      token_hash: tokenHash,
      used_at: null,
      expires_at: { [Op.gt]: new Date() },
    },
  });
  if (!tokenRow) {
    throw new AppError('Reset token is invalid or expired', 400, { code: 'RESET_TOKEN_INVALID' });
  }
  return { valid: true };
};

const getMe = async ({ userId, activeTenantId }) => {
  const user = await PlatformUser.findByPk(userId, {
    include: includeRolePermission,
  });
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }
  const resolvedActiveTenantId = resolveActiveTenantId({
    user,
    requestedTenantId: activeTenantId || null,
  });

  return mapUser({ user, activeTenantId: resolvedActiveTenantId });
};

const updateMe = async ({ userId, body, req }) => {
  const user = await PlatformUser.findByPk(userId, {
    include: includeRolePermission,
  });
  if (!user) {
    throw new AppError('User not found', 404, { code: 'USER_NOT_FOUND' });
  }
  const previousTimezone =
    user.metadata?.preferences?.timezone ||
    user.metadata?.accountPreferences?.timezone ||
    null;

  const updates = {
    updated_at: new Date(),
  };

  if (body.fullName !== undefined) {
    const fullName = String(body.fullName || '').trim();
    if (!fullName) {
      throw new AppError('fullName cannot be blank', 400, { code: 'VALIDATION_ERROR' });
    }
    updates.full_name = fullName;
  }

  if (body.phone !== undefined) {
    const phone = String(body.phone || '').trim();
    updates.phone = phone || null;
  }

  if (body.employeeCode !== undefined) {
    const employeeCode = String(body.employeeCode || '').trim();
    updates.employee_code = employeeCode || null;
  }

  if (body.remarks !== undefined) {
    const remarks = String(body.remarks || '').trim();
    updates.remarks = remarks || null;
  }

  if (body.metadata !== undefined) {
    updates.metadata = body.metadata === null ? null : body.metadata;
  }

  await user.update(updates);

  const updatedTimezone =
    body.metadata?.preferences?.timezone ||
    body.metadata?.accountPreferences?.timezone ||
    null;
  if (
    req.user?.isSuperAdmin &&
    isValidIanaTimezone(updatedTimezone) &&
    updatedTimezone !== previousTimezone
  ) {
    const schedules = await BackupSchedule.findAll({
      where: { created_by: user.id },
      attributes: ['id', 'run_time', 'enabled'],
    });
    for (const schedule of schedules) {
      await schedule.update({
        timezone: updatedTimezone,
        next_run_at: schedule.enabled
          ? nextDailyRun(schedule.run_time || '02:00:00', updatedTimezone)
          : null,
        updated_by: user.id,
        updated_at: new Date(),
      });
    }
  }

  await createAuditLog({
    req,
    actorUserId: user.id,
    tenantId: user.tenant_id,
    action: 'user.update_me',
    entityType: 'platform_user',
    entityId: user.id,
    details: { changedFields: Object.keys(body || {}) },
  });

  const refreshed = await PlatformUser.findByPk(userId, {
    include: includeRolePermission,
  });
  const activeTenantId = resolveActiveTenantId({
    user: refreshed,
    requestedTenantId: req.user?.tenantId || null,
  });

  return mapUser({ user: refreshed, activeTenantId });
};

module.exports = {
  login,
  refresh,
  logout,
  forgotPassword,
  verifyResetToken,
  resetPassword,
  getMe,
  updateMe,
};
