'use strict';

const crypto = require('crypto');

const ROLE_DEFINITIONS = [
  ['super_admin', 'Super Admin'],
  ['platform_ops', 'Platform Operations'],
  ['tenant_admin', 'Tenant Admin'],
  ['state_admin', 'State Admin'],
  ['district_admin', 'District Admin'],
  ['city_admin', 'City Admin'],
  ['zone_admin', 'Zone Admin'],
  ['facility_manager', 'Facility Manager'],
  ['supervisor', 'Supervisor'],
  ['field_worker', 'Field Worker'],
  ['contractor_manager', 'Contractor Manager'],
  ['viewer', 'Viewer'],
  ['auditor', 'Auditor'],
  ['country_admin', 'Country Admin'],
];

const ROLE_PERMISSION_MATRIX = {
  super_admin: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'super_admin.read', 'super_admin.write', 'users.manage', 'reports.read', 'reports.export', 'tenants.manage', 'audit.read'],
  platform_ops: ['auth.read', 'dashboard.read', 'inspection.review', 'super_admin.read', 'super_admin.write', 'sensor.read', 'alerts.manage', 'audit.read', 'reports.read'],
  tenant_admin: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'users.manage', 'reports.read', 'reports.export', 'audit.read'],
  country_admin: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'users.manage', 'reports.read', 'reports.export', 'audit.read'],
  state_admin: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'users.manage', 'reports.read', 'reports.export', 'audit.read'],
  district_admin: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'users.manage', 'reports.read', 'reports.export', 'audit.read'],
  city_admin: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'users.manage', 'reports.read', 'reports.export', 'audit.read'],
  zone_admin: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'users.manage', 'reports.read', 'reports.export', 'audit.read'],
  facility_manager: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'reports.read', 'reports.export'],
  contractor_manager: ['auth.read', 'dashboard.read', 'task.manage', 'alerts.manage', 'reports.read', 'reports.export'],
  supervisor: ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'reports.read'],
  field_worker: ['auth.read', 'inspection.create'],
  auditor: ['auth.read', 'audit.read', 'reports.read', 'reports.export'],
  viewer: ['auth.read', 'dashboard.read', 'reports.read'],
};

module.exports = {
  async up(queryInterface) {
    const now = new Date();

    // 1. Insert/Update Roles
    for (const [code, name] of ROLE_DEFINITIONS) {
      await queryInterface.sequelize.query(
        `
        INSERT INTO roles (id, code, name, description, created_at, updated_at)
        VALUES (:id, :code, :name, :description, :now, :now)
        ON CONFLICT (code)
        DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at
      `,
        {
          replacements: { id: crypto.randomUUID(), code, name, description: `${name} role`, now },
        }
      );
    }

    // 2. Map Roles & Permissions
    const roleRows = await queryInterface.sequelize.query(`SELECT id, code FROM roles`, { type: queryInterface.sequelize.QueryTypes.SELECT });
    const permissionRows = await queryInterface.sequelize.query(`SELECT id, code FROM permissions`, { type: queryInterface.sequelize.QueryTypes.SELECT });
    const roleByCode = Object.fromEntries(roleRows.map((row) => [row.code, row.id]));
    const permissionByCode = Object.fromEntries(permissionRows.map((row) => [row.code, row.id]));

    const existingRolePermissionRows = await queryInterface.sequelize.query(`SELECT role_id, permission_id FROM role_permissions`, { type: queryInterface.sequelize.QueryTypes.SELECT });
    const existingRolePermissionSet = new Set(existingRolePermissionRows.map((row) => `${row.role_id}:${row.permission_id}`));

    const rolePermissionInserts = [];
    for (const [roleCode, permissionCodes] of Object.entries(ROLE_PERMISSION_MATRIX)) {
      const roleId = roleByCode[roleCode];
      if (!roleId) continue;
      for (const permissionCode of permissionCodes) {
        const permissionId = permissionByCode[permissionCode];
        if (!permissionId) continue;
        const key = `${roleId}:${permissionId}`;
        if (existingRolePermissionSet.has(key)) continue;
        existingRolePermissionSet.add(key);
        rolePermissionInserts.push({ id: crypto.randomUUID(), role_id: roleId, permission_id: permissionId, created_at: now, updated_at: now });
      }
    }

    if (rolePermissionInserts.length > 0) {
      await queryInterface.bulkInsert('role_permissions', rolePermissionInserts);
    }
  },

  async down(queryInterface) {
    // Keep this empty
  },
};
