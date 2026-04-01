'use strict';

const { v4: uuidv4 } = require('uuid');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // 1. Get all roles and permissions
    const [roles] = await queryInterface.sequelize.query('SELECT id, code FROM roles');
    const [permissions] = await queryInterface.sequelize.query('SELECT id, code FROM permissions');

    const roleMap = roles.reduce((acc, r) => ({ ...acc, [r.code]: r.id }), {});
    const permMap = permissions.reduce((acc, p) => ({ ...acc, [p.code]: p.id }), {});

    const associations = [];
    const now = new Date();

    const matrix = {
      super_admin: Object.keys(permMap),
      platform_ops: ['dashboard.read', 'audit.read', 'reports.read', 'sensor.read', 'alerts.manage', 'super_admin.read', 'super_admin.write'],
      tenant_admin: Object.keys(permMap).filter(p => !p.startsWith('super_admin.') && p !== 'tenants.manage'),
      state_admin: ['dashboard.read', 'inspection.review', 'reports.read', 'reports.export', 'alerts.manage', 'task.manage', 'audit.read'],
      district_admin: ['dashboard.read', 'inspection.review', 'alerts.manage', 'task.manage', 'reports.read', 'sensor.read'],
      city_admin: ['dashboard.read', 'inspection.review', 'alerts.manage', 'task.manage', 'reports.read', 'sensor.read'],
      zone_admin: ['dashboard.read', 'inspection.review', 'alerts.manage', 'task.manage', 'sensor.read'],
      contractor_manager: ['dashboard.read', 'task.manage', 'alerts.manage', 'inspection.review', 'reports.read', 'reports.export'],
      supervisor: ['inspection.review', 'alerts.manage', 'task.manage'],
      facility_manager: ['dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'reports.read'],
      field_worker: ['auth.read', 'inspection.create'],
      auditor: ['dashboard.read', 'inspection.review', 'reports.read', 'reports.export', 'audit.read'],
      viewer: ['dashboard.read', 'reports.read', 'inspection.review'],
    };

    for (const [roleCode, permCodes] of Object.entries(matrix)) {
      const roleId = roleMap[roleCode];
      if (!roleId) continue;

      for (const permCode of permCodes) {
        const permId = permMap[permCode];
        if (!permId) continue;

        associations.push({
          id: uuidv4(),
          role_id: roleId,
          permission_id: permId,
          created_at: now,
          updated_at: now,
        });
      }
    }

    // Clear existing associations first to ensure a clean state
    await queryInterface.bulkDelete('role_permissions', null, {});
    
    // Insert new associations
    if (associations.length > 0) {
      await queryInterface.bulkInsert('role_permissions', associations);
    }

    console.log(`Successfully seeded ${associations.length} role-permission mappings.`);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.bulkDelete('role_permissions', null, {});
  },
};
