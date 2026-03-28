'use strict';

const bcrypt = require('bcrypt');

const ids = {
  tenant: '11111111-1111-4111-8111-111111111111',
  country: '22222222-2222-4222-8222-222222222221',
  state: '22222222-2222-4222-8222-222222222222',
  district: '22222222-2222-4222-8222-222222222223',
  city: '22222222-2222-4222-8222-222222222224',
  zone: '22222222-2222-4222-8222-222222222225',
  ward: '22222222-2222-4222-8222-222222222226',
  facility: '33333333-3333-4333-8333-333333333331',
  block: '33333333-3333-4333-8333-333333333332',
  unit1: '33333333-3333-4333-8333-333333333333',
  unit2: '33333333-3333-4333-8333-333333333334',
  userSuperAdmin: '44444444-4444-4444-8444-444444444441',
  userTenantAdmin: '44444444-4444-4444-8444-444444444442',
  userSupervisor: '44444444-4444-4444-8444-444444444443',
  userWorker: '44444444-4444-4444-8444-444444444444',
  sensor1: '55555555-5555-4555-8555-555555555551',
  sensor2: '55555555-5555-4555-8555-555555555552',
  task1: '66666666-6666-4666-8666-666666666661',
  task2: '66666666-6666-4666-8666-666666666662',
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const passwordHash = await bcrypt.hash('Password@123', 10);

    await queryInterface.bulkInsert('tenants', [
      {
        id: ids.tenant,
        name: 'Nashik Municipal Corporation',
        code: 'NMC',
        status: 'active',
        country_code: 'IN',
        metadata: { clientType: 'municipal', plan: 'enterprise' },
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('geographies', [
      {
        id: ids.country,
        tenant_id: ids.tenant,
        parent_id: null,
        level: 'country',
        code: 'IN',
        name: 'India',
        centroid_latitude: 20.5937,
        centroid_longitude: 78.9629,
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.state,
        tenant_id: ids.tenant,
        parent_id: ids.country,
        level: 'state',
        code: 'MH',
        name: 'Maharashtra',
        centroid_latitude: 19.7515,
        centroid_longitude: 75.7139,
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.district,
        tenant_id: ids.tenant,
        parent_id: ids.state,
        level: 'district',
        code: 'NSK-DIST',
        name: 'Nashik District',
        centroid_latitude: 20.0059,
        centroid_longitude: 73.7897,
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.city,
        tenant_id: ids.tenant,
        parent_id: ids.district,
        level: 'city',
        code: 'NSK-CITY',
        name: 'Nashik',
        centroid_latitude: 20.0059,
        centroid_longitude: 73.7897,
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.zone,
        tenant_id: ids.tenant,
        parent_id: ids.city,
        level: 'zone',
        code: 'PANCHAVATI',
        name: 'Panchavati Zone',
        centroid_latitude: 20.0161,
        centroid_longitude: 73.7937,
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.ward,
        tenant_id: ids.tenant,
        parent_id: ids.zone,
        level: 'ward',
        code: 'WARD-12',
        name: 'Ward 12',
        centroid_latitude: 20.0121,
        centroid_longitude: 73.7889,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('facilities', [
      {
        id: ids.facility,
        tenant_id: ids.tenant,
        geography_id: ids.ward,
        code: 'NSK-T-001',
        name: 'CBS Bus Stand Toilet Complex',
        facility_type: 'toilet_complex',
        address_line: 'CBS Bus Stand, Nashik',
        latitude: 19.9971,
        longitude: 73.7895,
        status: 'active',
        metadata: { contractor: 'CleanCity Services' },
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('toilet_blocks', [
      {
        id: ids.block,
        facility_id: ids.facility,
        code: 'BLOCK-A',
        name: 'Main Block A',
        gender_type: 'general',
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('toilet_units', [
      {
        id: ids.unit1,
        facility_id: ids.facility,
        toilet_block_id: ids.block,
        code: 'U-01',
        unit_type: 'male',
        status: 'moderate',
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.unit2,
        facility_id: ids.facility,
        toilet_block_id: ids.block,
        code: 'U-02',
        unit_type: 'female',
        status: 'clean',
        created_at: now,
        updated_at: now,
      },
    ]);

    const roles = [
      ['super_admin', 'Super Admin'],
      ['platform_ops', 'Platform Operations'],
      ['tenant_admin', 'Tenant Admin'],
      ['country_admin', 'Country Admin'],
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
    ];

    const roleRows = roles.map(([code, name], index) => ({
      id: `77777777-7777-4777-8777-${String(100000000000 + index).slice(1)}`,
      code,
      name,
      description: `${name} role`,
      created_at: now,
      updated_at: now,
    }));
    await queryInterface.bulkInsert('roles', roleRows);

    const permissions = [
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

    const permissionRows = permissions.map(([code, name], index) => ({
      id: `88888888-8888-4888-8888-${String(100000000000 + index).slice(1)}`,
      code,
      name,
      description: name,
      created_at: now,
      updated_at: now,
    }));
    await queryInterface.bulkInsert('permissions', permissionRows);

    const roleByCode = Object.fromEntries(roleRows.map((role) => [role.code, role.id]));
    const permissionByCode = Object.fromEntries(permissionRows.map((permission) => [permission.code, permission.id]));

    const rolePermissions = [
      ['super_admin', ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'super_admin.read', 'super_admin.write', 'users.manage', 'reports.read', 'reports.export', 'tenants.manage', 'audit.read']],
      ['tenant_admin', ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'users.manage', 'reports.read', 'reports.export', 'audit.read']],
      ['supervisor', ['auth.read', 'dashboard.read', 'inspection.review', 'task.manage', 'alerts.manage', 'sensor.read', 'reports.read']],
      ['field_worker', ['auth.read', 'inspection.create', 'dashboard.read']],
      ['viewer', ['auth.read', 'dashboard.read', 'reports.read']],
    ];

    const rolePermissionRows = [];
    for (const [roleCode, permissionCodes] of rolePermissions) {
      for (const permissionCode of permissionCodes) {
        rolePermissionRows.push({
          id: `99999999-9999-4999-8999-${String(100000000000 + rolePermissionRows.length).slice(1)}`,
          role_id: roleByCode[roleCode],
          permission_id: permissionByCode[permissionCode],
          created_at: now,
          updated_at: now,
        });
      }
    }
    await queryInterface.bulkInsert('role_permissions', rolePermissionRows);

    await queryInterface.bulkInsert('platform_users', [
      {
        id: ids.userSuperAdmin,
        tenant_id: null,
        geography_id: null,
        full_name: 'Platform Super Admin',
        email: 'superadmin@platform.gov',
        phone: '9000000001',
        password_hash: passwordHash,
        auth_provider: 'local',
        status: 'active',
        last_login_at: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.userTenantAdmin,
        tenant_id: ids.tenant,
        geography_id: ids.city,
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
        id: ids.userSupervisor,
        tenant_id: ids.tenant,
        geography_id: ids.zone,
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
        id: ids.userWorker,
        tenant_id: ids.tenant,
        geography_id: ids.ward,
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
    ]);

    await queryInterface.bulkInsert('user_roles', [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        user_id: ids.userSuperAdmin,
        role_id: roleByCode.super_admin,
        tenant_id: null,
        geography_id: null,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        user_id: ids.userTenantAdmin,
        role_id: roleByCode.tenant_admin,
        tenant_id: ids.tenant,
        geography_id: ids.city,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
        user_id: ids.userSupervisor,
        role_id: roleByCode.supervisor,
        tenant_id: ids.tenant,
        geography_id: ids.zone,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        user_id: ids.userWorker,
        role_id: roleByCode.field_worker,
        tenant_id: ids.tenant,
        geography_id: ids.ward,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('inspection_tasks', [
      {
        id: ids.task1,
        tenant_id: ids.tenant,
        facility_id: ids.facility,
        toilet_unit_id: ids.unit1,
        assigned_to_user_id: ids.userWorker,
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
        id: ids.task2,
        tenant_id: ids.tenant,
        facility_id: ids.facility,
        toilet_unit_id: ids.unit2,
        assigned_to_user_id: ids.userWorker,
        task_type: 'inspection_followup',
        scheduled_at: now,
        sla_minutes: 60,
        status: 'pending',
        started_at: null,
        completed_at: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('sensor_devices', [
      {
        id: ids.sensor1,
        tenant_id: ids.tenant,
        facility_id: ids.facility,
        toilet_block_id: ids.block,
        toilet_unit_id: ids.unit1,
        device_id: 'SENSOR-ODOR-001',
        serial_no: 'ODR-001',
        device_type: 'odor',
        status: 'active',
        firmware_version: '1.0.3',
        last_seen_at: now,
        metadata: { vendor: 'GovIoT' },
        created_at: now,
        updated_at: now,
      },
      {
        id: ids.sensor2,
        tenant_id: ids.tenant,
        facility_id: ids.facility,
        toilet_block_id: ids.block,
        toilet_unit_id: ids.unit2,
        device_id: 'SENSOR-ENV-002',
        serial_no: 'ENV-002',
        device_type: 'environment',
        status: 'active',
        firmware_version: '1.1.0',
        last_seen_at: now,
        metadata: { vendor: 'GovIoT' },
        created_at: now,
        updated_at: now,
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('sensor_devices', null, {});
    await queryInterface.bulkDelete('inspection_tasks', null, {});
    await queryInterface.bulkDelete('user_roles', null, {});
    await queryInterface.bulkDelete('platform_users', null, {});
    await queryInterface.bulkDelete('role_permissions', null, {});
    await queryInterface.bulkDelete('permissions', null, {});
    await queryInterface.bulkDelete('roles', null, {});
    await queryInterface.bulkDelete('toilet_units', null, {});
    await queryInterface.bulkDelete('toilet_blocks', null, {});
    await queryInterface.bulkDelete('facilities', null, {});
    await queryInterface.bulkDelete('geographies', null, {});
    await queryInterface.bulkDelete('tenants', null, {});
  },
};
