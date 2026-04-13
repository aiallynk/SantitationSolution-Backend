const { ROLE_ACCESS_MATRIX } = require('./accessMatrix');

const TENANT_ADMIN_BASE_PERMISSIONS = [...(ROLE_ACCESS_MATRIX.tenant_admin?.permissionCodes || [])];
const VIEWER_BASE_PERMISSIONS = [...(ROLE_ACCESS_MATRIX.viewer?.permissionCodes || [])];

const ROLE_PERMISSION_BUNDLES = Object.fromEntries(
  Object.entries(ROLE_ACCESS_MATRIX).map(([roleCode, entry]) => [
    roleCode,
    [...new Set((Array.isArray(entry.permissionCodes) ? entry.permissionCodes : []).map((code) => String(code || '').trim()).filter(Boolean))],
  ])
);

module.exports = {
  TENANT_ADMIN_BASE_PERMISSIONS,
  VIEWER_BASE_PERMISSIONS,
  ROLE_PERMISSION_BUNDLES,
};
