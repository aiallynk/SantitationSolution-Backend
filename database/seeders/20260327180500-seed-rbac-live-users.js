'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');

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

const PERMISSION_DEFINITIONS = [
  ['auth.read', 'Read own auth profile'],
  ['dashboard.read', 'Read dashboard'],
  ['inspection.create', 'Create inspections'],
  ['inspection.review', 'Review inspections'],
  ['task.manage', 'Manage tasks'],
  ['alerts.manage', 'Manage alerts'],
  ['sensor.ingest', 'Ingest sensor data'],
  ['sensor.read', 'Read sensor data'],
  ['super_admin.read', 'Read super admin metrics'],
  ['super_admin.write', 'Manage platform features'],
  ['users.manage', 'Manage users'],
  ['reports.read', 'Read reports'],
  ['reports.export', 'Export reports'],
  ['tenants.manage', 'Manage tenants'],
  ['audit.read', 'Read audit logs'],
];

const ROLE_PERMISSION_MATRIX = {
  super_admin: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'super_admin.read',
    'super_admin.write',
    'users.manage',
    'reports.read',
    'reports.export',
    'tenants.manage',
    'audit.read',
  ],
  tenant_admin: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'users.manage',
    'reports.read',
    'reports.export',
    'audit.read',
  ],
  platform_ops: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'super_admin.read',
    'super_admin.write',
    'sensor.read',
    'alerts.manage',
    'audit.read',
    'reports.read',
  ],
  country_admin: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'users.manage',
    'reports.read',
    'reports.export',
    'audit.read',
  ],
  state_admin: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'users.manage',
    'reports.read',
    'reports.export',
    'audit.read',
  ],
  district_admin: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'users.manage',
    'reports.read',
    'reports.export',
    'audit.read',
  ],
  city_admin: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'users.manage',
    'reports.read',
    'reports.export',
    'audit.read',
  ],
  zone_admin: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'users.manage',
    'reports.read',
    'reports.export',
    'audit.read',
  ],
  facility_manager: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'reports.read',
    'reports.export',
  ],
  contractor_manager: ['auth.read', 'dashboard.read', 'task.manage', 'alerts.manage', 'reports.read', 'reports.export'],
  supervisor: [
    'auth.read',
    'dashboard.read',
    'inspection.review',
    'task.manage',
    'alerts.manage',
    'sensor.read',
    'reports.read',
  ],
  field_worker: ['auth.read', 'inspection.create'],
  auditor: ['auth.read', 'audit.read', 'reports.read', 'reports.export'],
  viewer: ['auth.read', 'dashboard.read', 'reports.read'],
};

const NEW_USER_EMAILS = [
  'tenantadmin@nmc.gov.in',
  'supervisor@nmc.gov.in',
  'worker1@nmc.gov.in',
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();

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
          replacements: {
            id: crypto.randomUUID(),
            code,
            name,
            description: `${name} role`,
            now,
          },
        }
      );
    }

    for (const [code, name] of PERMISSION_DEFINITIONS) {
      await queryInterface.sequelize.query(
        `
        INSERT INTO permissions (id, code, name, description, created_at, updated_at)
        VALUES (:id, :code, :name, :description, :now, :now)
        ON CONFLICT (code)
        DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at
      `,
        {
          replacements: {
            id: crypto.randomUUID(),
            code,
            name,
            description: name,
            now,
          },
        }
      );
    }

    const roleRows = await queryInterface.sequelize.query(
      `SELECT id, code FROM roles`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const permissionRows = await queryInterface.sequelize.query(
      `SELECT id, code FROM permissions`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );

    const roleByCode = Object.fromEntries(roleRows.map((row) => [row.code, row.id]));
    const permissionByCode = Object.fromEntries(permissionRows.map((row) => [row.code, row.id]));

    const existingRolePermissionRows = await queryInterface.sequelize.query(
      `SELECT role_id, permission_id FROM role_permissions`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const existingRolePermissionSet = new Set(
      existingRolePermissionRows.map((row) => `${row.role_id}:${row.permission_id}`)
    );

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
        rolePermissionInserts.push({
          id: crypto.randomUUID(),
          role_id: roleId,
          permission_id: permissionId,
          created_at: now,
          updated_at: now,
        });
      }
    }
    if (rolePermissionInserts.length > 0) {
      await queryInterface.bulkInsert('role_permissions', rolePermissionInserts);
    }

    const tenantRows = await queryInterface.sequelize.query(
      `SELECT id, name FROM tenants ORDER BY created_at ASC LIMIT 1`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    if (!tenantRows.length) {
      return;
    }
    const tenantId = tenantRows[0].id;

    const geographyRows = await queryInterface.sequelize.query(
      `SELECT id FROM geographies WHERE tenant_id = :tenantId ORDER BY created_at ASC LIMIT 1`,
      {
        replacements: { tenantId },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const geographyId = geographyRows[0]?.id || null;

    const existingUsers = await queryInterface.sequelize.query(
      `SELECT id, email FROM platform_users`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const userByEmail = Object.fromEntries(existingUsers.map((row) => [row.email, row.id]));

    const passwordHash = await bcrypt.hash('Password@123', 10);
    const usersToInsert = [
      {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        geography_id: geographyId,
        full_name: 'NMC Tenant Admin',
        email: 'tenantadmin@nmc.gov.in',
        phone: '9000000002',
        password_hash: passwordHash,
        auth_provider: 'local',
        status: 'active',
        last_login_at: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        geography_id: geographyId,
        full_name: 'Zone Supervisor',
        email: 'supervisor@nmc.gov.in',
        phone: '9000000003',
        password_hash: passwordHash,
        auth_provider: 'local',
        status: 'active',
        last_login_at: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: crypto.randomUUID(),
        tenant_id: tenantId,
        geography_id: geographyId,
        full_name: 'Field Worker One',
        email: 'worker1@nmc.gov.in',
        phone: '9000000004',
        password_hash: passwordHash,
        auth_provider: 'local',
        status: 'active',
        last_login_at: null,
        created_at: now,
        updated_at: now,
      },
    ].filter((row) => !userByEmail[row.email]);

    if (usersToInsert.length > 0) {
      await queryInterface.bulkInsert('platform_users', usersToInsert);
    }

    const currentUsers = await queryInterface.sequelize.query(
      `SELECT id, email FROM platform_users WHERE email IN (:emails)`,
      {
        replacements: { emails: NEW_USER_EMAILS },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    currentUsers.forEach((row) => {
      userByEmail[row.email] = row.id;
    });

    const userRolePairs = [
      ['tenantadmin@nmc.gov.in', 'tenant_admin'],
      ['supervisor@nmc.gov.in', 'supervisor'],
      ['worker1@nmc.gov.in', 'field_worker'],
    ];

    const existingUserRoleRows = await queryInterface.sequelize.query(
      `SELECT user_id, role_id FROM user_roles`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const existingUserRoleSet = new Set(
      existingUserRoleRows.map((row) => `${row.user_id}:${row.role_id}`)
    );

    const userRoleInserts = [];
    for (const [email, roleCode] of userRolePairs) {
      const userId = userByEmail[email];
      const roleId = roleByCode[roleCode];
      if (!userId || !roleId) continue;
      const key = `${userId}:${roleId}`;
      if (existingUserRoleSet.has(key)) continue;
      existingUserRoleSet.add(key);
      userRoleInserts.push({
        id: crypto.randomUUID(),
        user_id: userId,
        role_id: roleId,
        tenant_id: tenantId,
        geography_id: geographyId,
        created_at: now,
        updated_at: now,
      });
    }
    if (userRoleInserts.length > 0) {
      await queryInterface.bulkInsert('user_roles', userRoleInserts);
    }

    const facilityRows = await queryInterface.sequelize.query(
      `SELECT id FROM facilities WHERE tenant_id = :tenantId ORDER BY created_at ASC LIMIT 1`,
      {
        replacements: { tenantId },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const facilityId = facilityRows[0]?.id;

    const toiletUnitRows = await queryInterface.sequelize.query(
      `SELECT id FROM toilet_units WHERE facility_id = :facilityId ORDER BY created_at ASC LIMIT 1`,
      {
        replacements: { facilityId },
        type: queryInterface.sequelize.QueryTypes.SELECT,
      }
    );
    const toiletUnitId = toiletUnitRows[0]?.id || null;
    const workerUserId = userByEmail['worker1@nmc.gov.in'];

    if (facilityId && workerUserId) {
      const existingTasks = await queryInterface.sequelize.query(
        `
        SELECT id FROM inspection_tasks
        WHERE assigned_to_user_id = :workerUserId
        LIMIT 1
      `,
        {
          replacements: { workerUserId },
          type: queryInterface.sequelize.QueryTypes.SELECT,
        }
      );

      if (existingTasks.length === 0) {
        await queryInterface.bulkInsert('inspection_tasks', [
          {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            facility_id: facilityId,
            toilet_unit_id: toiletUnitId,
            assigned_to_user_id: workerUserId,
            task_type: 'routine_cleaning',
            scheduled_at: now,
            sla_minutes: 45,
            status: 'pending',
            started_at: null,
            completed_at: null,
            created_at: now,
            updated_at: now,
          },
          {
            id: crypto.randomUUID(),
            tenant_id: tenantId,
            facility_id: facilityId,
            toilet_unit_id: toiletUnitId,
            assigned_to_user_id: workerUserId,
            task_type: 'inspection_followup',
            scheduled_at: new Date(now.getTime() + 60 * 60 * 1000),
            sla_minutes: 60,
            status: 'pending',
            started_at: null,
            completed_at: null,
            created_at: now,
            updated_at: now,
          },
        ]);
      }
    }
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM inspection_tasks
      WHERE assigned_to_user_id IN (
        SELECT id FROM platform_users
        WHERE email IN ('tenantadmin@nmc.gov.in', 'supervisor@nmc.gov.in', 'worker1@nmc.gov.in')
      )
    `);

    await queryInterface.sequelize.query(`
      DELETE FROM user_roles
      WHERE user_id IN (
        SELECT id FROM platform_users
        WHERE email IN ('tenantadmin@nmc.gov.in', 'supervisor@nmc.gov.in', 'worker1@nmc.gov.in')
      )
    `);

    await queryInterface.bulkDelete('platform_users', {
      email: NEW_USER_EMAILS,
    });
  },
};
