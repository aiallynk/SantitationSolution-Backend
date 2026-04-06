const jwt = require('jsonwebtoken');
const AppError = require('../errors/AppError');
const { PlatformUser, Role, Permission } = require('../../models');

const ACCESS_TOKEN_SECRET = process.env.JWT_SECRET || 'change-me-access-secret';
// Legacy compatibility note:
// `platform_ops` remains global-scoped here for backward compatibility only.
// Do not elevate or auto-migrate it to `super_admin` without an explicit migration plan.
const GLOBAL_ROLE_CODES = new Set(['super_admin', 'platform_ops']);

const parseBearer = (req) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice('Bearer '.length).trim();
};

const getTokenFromRequest = (req) => {
  return parseBearer(req) || req.query.token || null;
};

const fetchUserWithRoles = async (userId) => {
  return PlatformUser.findByPk(userId, {
    include: [
      {
        model: Role,
        through: {
          attributes: ['tenant_id', 'geography_id'],
        },
        include: [{ model: Permission }],
      },
    ],
  });
};

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
    });
  }
  return memberships;
};

const pickActiveTenantId = (req, user, memberships) => {
  const requested = String(req.headers['x-tenant-id'] || req.query.tenantId || '').trim() || null;
  if (user.isSuperAdmin) {
    return requested;
  }

  const tenantIds = [...new Set(memberships.map((item) => item.tenantId).filter(Boolean))];
  const fallbackTenantId = tenantIds[0] || user.tenant_id || null;

  if (!requested) {
    return fallbackTenantId;
  }

  if (!tenantIds.includes(requested)) {
    throw new AppError('Tenant context is outside user scope', 403, { code: 'TENANT_SCOPE_FORBIDDEN' });
  }
  return requested;
};

const buildAuthContext = ({ req, user }) => {
  const allRoleCodes = [...new Set((user.Roles || []).map((role) => role.code))];
  const memberships = normalizeMemberships(user);
  const isSuperAdmin = allRoleCodes.includes('super_admin');
  const activeTenantId = pickActiveTenantId(req, { ...user, isSuperAdmin }, memberships);

  const activeMemberships = memberships.filter((membership) => {
    if (GLOBAL_ROLE_CODES.has(membership.roleCode)) return true;
    if (!activeTenantId) return membership.tenantId == null;
    return membership.tenantId === activeTenantId;
  });

  const roleCodes = [...new Set(activeMemberships.map((item) => item.roleCode))];
  const permissionCodes = new Set();
  for (const role of user.Roles || []) {
    const roleTenantId = role?.UserRole?.tenant_id || user.tenant_id || null;
    const roleIsGlobal = GLOBAL_ROLE_CODES.has(role.code);
    if (!roleIsGlobal && activeTenantId && roleTenantId !== activeTenantId) continue;
    if (!roleIsGlobal && !activeTenantId && roleTenantId != null) continue;
    for (const permission of role.Permissions || []) {
      permissionCodes.add(permission.code);
    }
  }

  return {
    id: user.id,
    tenantId: activeTenantId,
    defaultTenantId: user.tenant_id || null,
    geographyId: user.geography_id || null,
    email: user.email,
    fullName: user.full_name,
    employeeCode: user.employee_code || null,
    status: user.status,
    allRoleCodes,
    roleCodes,
    permissionCodes: [...permissionCodes],
    memberships,
    activeMemberships,
    activeTenantId,
    isSuperAdmin,
  };
};

const getAuthContextFromToken = async ({ token, tenantId = null } = {}) => {
  if (!token) {
    throw new AppError('Authentication required', 401, { code: 'AUTH_REQUIRED' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
  } catch (error) {
    throw new AppError('Invalid or expired token', 401, { code: 'INVALID_TOKEN' });
  }

  const user = await fetchUserWithRoles(decoded.sub);
  if (!user || user.status !== 'active') {
    throw new AppError('User is not active', 401, { code: 'USER_INACTIVE' });
  }

  const preferredTenantId = tenantId || decoded.tenantId || null;
  const requestLike = {
    headers: preferredTenantId ? { 'x-tenant-id': preferredTenantId } : {},
    query: preferredTenantId ? { tenantId: preferredTenantId } : {},
  };

  return buildAuthContext({ req: requestLike, user });
};

const protect = async (req, res, next) => {
  try {
    const token = getTokenFromRequest(req);
    const requestedTenantId =
      String(req.headers['x-tenant-id'] || req.query.tenantId || '').trim() || null;
    req.user = await getAuthContextFromToken({
      token,
      tenantId: requestedTenantId,
    });
    return next();
  } catch (error) {
    return next(error);
  }
};

const requireRoles = (...roleCodes) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, { code: 'AUTH_REQUIRED' }));
    }
    const hasRole = req.user.roleCodes.some((roleCode) => roleCodes.includes(roleCode));
    if (!hasRole) {
      return next(new AppError('Insufficient role permissions', 403, { code: 'ROLE_FORBIDDEN' }));
    }
    return next();
  };
};

const requirePermissions = (...permissionCodes) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, { code: 'AUTH_REQUIRED' }));
    }
    const userPermissions = new Set(req.user.permissionCodes || []);
    const hasAll = permissionCodes.every((code) => userPermissions.has(code));
    if (!hasAll && !req.user.isSuperAdmin) {
      return next(new AppError('Insufficient permission scope', 403, { code: 'PERMISSION_FORBIDDEN' }));
    }
    return next();
  };
};

const requireAnyPermissions = (...permissionCodes) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, { code: 'AUTH_REQUIRED' }));
    }
    if (req.user.isSuperAdmin) {
      return next();
    }
    const userPermissions = new Set(req.user.permissionCodes || []);
    const hasAny = permissionCodes.some((code) => userPermissions.has(code));
    if (!hasAny) {
      return next(new AppError('Insufficient permission scope', 403, { code: 'PERMISSION_FORBIDDEN' }));
    }
    return next();
  };
};

const requireTenantContext = () => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, { code: 'AUTH_REQUIRED' }));
    }
    if (req.user.isSuperAdmin) {
      return next();
    }
    if (!req.user.tenantId) {
      return next(new AppError('Tenant context is required', 403, { code: 'TENANT_CONTEXT_REQUIRED' }));
    }
    return next();
  };
};

const applyTenantFilter = (tenantKey = 'tenant_id') => {
  return (req, res, next) => {
    req.scope = req.scope || {};
    req.scope.tenantFilter =
      req.user?.isSuperAdmin && req.query.tenantId
        ? { [tenantKey]: req.query.tenantId }
        : req.user?.tenantId
          ? { [tenantKey]: req.user.tenantId }
          : {};
    return next();
  };
};

const tenantScoped = () => {
  return (req, res, next) => {
    req.scope = {
      tenantId: req.user?.tenantId || null,
      geographyId: req.user?.geographyId || null,
      isSuperAdmin: Boolean(req.user?.isSuperAdmin),
    };
    return next();
  };
};

module.exports = {
  protect,
  requireRoles,
  requirePermissions,
  requireAnyPermissions,
  requireTenantContext,
  applyTenantFilter,
  tenantScoped,
  getAuthContextFromToken,
  getTokenFromRequest,
};
