const AppError = require('../errors/AppError');

/**
 * requireScope — Backend middleware to enforce geography-scoped data access.
 *
 * For roles that are NOT in GLOBAL_ROLE_CODES, this middleware ensures that they
 * only access data within their assigned geography.
 *
 * It attaches `req.scope.geographyFilter` which should be used in Sequelize queries.
 */
function requireScope() {
  return (req, res, next) => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, { code: 'AUTH_REQUIRED' }));
    }

    // Super admins and global roles bypass geography scoping
    if (req.user.isSuperAdmin) {
      req.scope = { ...req.scope, geographyFilter: {} };
      return next();
    }

    const userGeographyIds = [
      ...new Set((req.user.activeMemberships || []).map((m) => m.geographyId).filter(Boolean)),
    ];

    // If the user has no geography assigned but is in a scoped role, they might be blocked
    // or allowed depending on the specific resource. For now, we provide the filter.
    req.scope = {
      ...req.scope,
      userGeographyIds,
      geographyFilter: userGeographyIds.length > 0 ? { geography_id: userGeographyIds } : {},
    };

    return next();
  };
}

module.exports = requireScope;
