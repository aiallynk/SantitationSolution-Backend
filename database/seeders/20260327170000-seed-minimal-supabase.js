'use strict';

const bcrypt = require('bcrypt');

const ids = {
  tenant: 'b1111111-1111-4111-8111-111111111111',
  geography: 'b2222222-2222-4222-8222-222222222222',
  facility: 'b3333333-3333-4333-8333-333333333333',
  block: 'b4444444-4444-4444-8444-444444444444',
  unit: 'b5555555-5555-4555-8555-555555555555',
  roleSuperAdmin: 'b6666666-6666-4666-8666-666666666666',
  superAdminUser: 'b7777777-7777-4777-8777-777777777777',
  userRole: 'b8888888-8888-4888-8888-888888888888',
  taskOne: 'b9999999-9999-4999-8999-999999999991',
  taskTwo: 'b9999999-9999-4999-8999-999999999992',
};

const DEFAULT_SEED_PASSWORD = String(
  process.env.DEFAULT_SEED_PASSWORD || process.env.PERSONA_SEED_PASSWORD || '11111111'
);

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();
    const passwordHash = await bcrypt.hash(DEFAULT_SEED_PASSWORD, 10);

    await queryInterface.bulkInsert('tenants', [
      {
        id: ids.tenant,
        name: 'Supabase Demo Tenant',
        code: 'SUPA-DEMO',
        status: 'active',
        country_code: 'IN',
        metadata: JSON.stringify({ source: 'minimal-seed' }),
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('geographies', [
      {
        id: ids.geography,
        tenant_id: ids.tenant,
        parent_id: null,
        level: 'city',
        code: 'CITY-01',
        name: 'Demo City',
        centroid_latitude: 19.076,
        centroid_longitude: 72.8777,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('facilities', [
      {
        id: ids.facility,
        tenant_id: ids.tenant,
        geography_id: ids.geography,
        code: 'FAC-001',
        name: 'Central Bus Stand Toilet Complex',
        facility_type: 'toilet_complex',
        address_line: 'Central Bus Stand',
        latitude: 19.076,
        longitude: 72.8777,
        status: 'active',
        metadata: JSON.stringify({ source: 'minimal-seed' }),
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('toilet_blocks', [
      {
        id: ids.block,
        facility_id: ids.facility,
        code: 'BLK-A',
        name: 'Main Block A',
        gender_type: 'general',
        status: 'active',
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('toilet_units', [
      {
        id: ids.unit,
        facility_id: ids.facility,
        toilet_block_id: ids.block,
        code: 'UNIT-01',
        unit_type: 'general',
        status: 'moderate',
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('roles', [
      {
        id: ids.roleSuperAdmin,
        code: 'super_admin',
        name: 'Super Admin',
        description: 'Platform owner role',
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('platform_users', [
      {
        id: ids.superAdminUser,
        tenant_id: null,
        geography_id: null,
        full_name: 'Platform Super Admin',
        email: 'superadmin@platform.gov',
        phone: '9000001111',
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
        id: ids.userRole,
        user_id: ids.superAdminUser,
        role_id: ids.roleSuperAdmin,
        tenant_id: null,
        geography_id: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('inspection_tasks', [
      {
        id: ids.taskOne,
        tenant_id: ids.tenant,
        facility_id: ids.facility,
        toilet_unit_id: ids.unit,
        assigned_to_user_id: ids.superAdminUser,
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
        id: ids.taskTwo,
        tenant_id: ids.tenant,
        facility_id: ids.facility,
        toilet_unit_id: ids.unit,
        assigned_to_user_id: ids.superAdminUser,
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
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('inspection_tasks', { id: [ids.taskOne, ids.taskTwo] }, {});
    await queryInterface.bulkDelete('user_roles', { id: ids.userRole }, {});
    await queryInterface.bulkDelete('platform_users', { id: ids.superAdminUser }, {});
    await queryInterface.bulkDelete('roles', { id: ids.roleSuperAdmin }, {});
    await queryInterface.bulkDelete('toilet_units', { id: ids.unit }, {});
    await queryInterface.bulkDelete('toilet_blocks', { id: ids.block }, {});
    await queryInterface.bulkDelete('facilities', { id: ids.facility }, {});
    await queryInterface.bulkDelete('geographies', { id: ids.geography }, {});
    await queryInterface.bulkDelete('tenants', { id: ids.tenant }, {});
  },
};
