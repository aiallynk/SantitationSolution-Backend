'use strict';

const { DataTypes, Op } = require('sequelize');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const addAssignmentLevelIfMissing = async (value) => {
      const level = String(value || '').trim().toLowerCase();
      if (!level) return;
      await queryInterface.sequelize.query(
        `
        DO $$
        DECLARE
          enum_type_name text;
        BEGIN
          SELECT t.typname
          INTO enum_type_name
          FROM pg_type t
          JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname IN ('enum_worker_assignments_assignment_level', 'worker_assignments_assignment_level_enum')
          LIMIT 1;

          IF enum_type_name IS NOT NULL THEN
            EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', enum_type_name, :level);
          END IF;
        END $$;
      `,
        {
          replacements: { level },
        }
      );
    };

    await addAssignmentLevelIfMissing('country');
    await addAssignmentLevelIfMissing('state');
    await addAssignmentLevelIfMissing('district');
    await addAssignmentLevelIfMissing('city');
    await addAssignmentLevelIfMissing('zone');
    await addAssignmentLevelIfMissing('ward');

    await queryInterface.addColumn('tenants', 'contact_name', {
      type: DataTypes.STRING(180),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'contact_email', {
      type: DataTypes.STRING(180),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'contact_mobile', {
      type: DataTypes.STRING(32),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'scope_level', {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'city',
    });
    await queryInterface.addColumn('tenants', 'country_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'state_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'district_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'city_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'zone_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'address_line', {
      type: DataTypes.STRING(300),
      allowNull: true,
    });
    await queryInterface.addColumn('tenants', 'root_geography_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'geographies', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('tenants', ['scope_level'], {
      name: 'tenants_scope_level_idx',
    });
    await queryInterface.addIndex('tenants', ['root_geography_id'], {
      name: 'tenants_root_geography_idx',
    });

    await queryInterface.addColumn('platform_users', 'user_id_code', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await queryInterface.addColumn('platform_users', 'remarks', {
      type: DataTypes.STRING(500),
      allowNull: true,
    });
    await queryInterface.addColumn('platform_users', 'country_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('platform_users', 'state_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('platform_users', 'district_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('platform_users', 'city_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('platform_users', 'zone_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('platform_users', 'ward_name', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addIndex('platform_users', ['user_id_code'], {
      name: 'platform_users_user_id_code_uk',
      unique: true,
      where: {
        user_id_code: { [Op.ne]: null },
      },
    });
    await queryInterface.addIndex('platform_users', ['tenant_id', 'phone'], {
      name: 'platform_users_tenant_phone_idx',
    });

    await queryInterface.addColumn('geographies', 'geometry_type', {
      type: DataTypes.STRING(20),
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'geojson', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'boundary_center_latitude', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'boundary_center_longitude', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'boundary_radius_meters', {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'bounds', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'area_sq_km', {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'boundary_label', {
      type: DataTypes.STRING(220),
      allowNull: true,
    });
    await queryInterface.addColumn('geographies', 'is_operational_zone', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addIndex('geographies', ['tenant_id', 'parent_id', 'level'], {
      name: 'geographies_tenant_parent_level_idx',
    });
    await queryInterface.addIndex('geographies', ['tenant_id', 'is_operational_zone'], {
      name: 'geographies_tenant_operational_idx',
    });

    await queryInterface.addColumn('facilities', 'zone_geography_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'geographies', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('facilities', 'ward_geography_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'geographies', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addColumn('facilities', 'supervisor_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'platform_users', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('facilities', ['tenant_id', 'zone_geography_id'], {
      name: 'facilities_tenant_zone_idx',
    });
    await queryInterface.addIndex('facilities', ['tenant_id', 'ward_geography_id'], {
      name: 'facilities_tenant_ward_idx',
    });
    await queryInterface.addIndex('facilities', ['tenant_id', 'supervisor_user_id'], {
      name: 'facilities_tenant_supervisor_idx',
    });

    await queryInterface.addColumn('worker_assignments', 'supervisor_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'platform_users', key: 'id' },
      onDelete: 'SET NULL',
    });
    await queryInterface.addIndex('worker_assignments', ['tenant_id', 'supervisor_user_id', 'status'], {
      name: 'worker_assignments_tenant_supervisor_status_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('worker_assignments', 'worker_assignments_tenant_supervisor_status_idx');
    await queryInterface.removeColumn('worker_assignments', 'supervisor_user_id');

    await queryInterface.removeIndex('facilities', 'facilities_tenant_supervisor_idx');
    await queryInterface.removeIndex('facilities', 'facilities_tenant_ward_idx');
    await queryInterface.removeIndex('facilities', 'facilities_tenant_zone_idx');
    await queryInterface.removeColumn('facilities', 'supervisor_user_id');
    await queryInterface.removeColumn('facilities', 'ward_geography_id');
    await queryInterface.removeColumn('facilities', 'zone_geography_id');

    await queryInterface.removeIndex('geographies', 'geographies_tenant_operational_idx');
    await queryInterface.removeIndex('geographies', 'geographies_tenant_parent_level_idx');
    await queryInterface.removeColumn('geographies', 'is_operational_zone');
    await queryInterface.removeColumn('geographies', 'boundary_label');
    await queryInterface.removeColumn('geographies', 'area_sq_km');
    await queryInterface.removeColumn('geographies', 'bounds');
    await queryInterface.removeColumn('geographies', 'boundary_radius_meters');
    await queryInterface.removeColumn('geographies', 'boundary_center_longitude');
    await queryInterface.removeColumn('geographies', 'boundary_center_latitude');
    await queryInterface.removeColumn('geographies', 'geojson');
    await queryInterface.removeColumn('geographies', 'geometry_type');

    await queryInterface.removeIndex('platform_users', 'platform_users_tenant_phone_idx');
    await queryInterface.removeIndex('platform_users', 'platform_users_user_id_code_uk');
    await queryInterface.removeColumn('platform_users', 'ward_name');
    await queryInterface.removeColumn('platform_users', 'zone_name');
    await queryInterface.removeColumn('platform_users', 'city_name');
    await queryInterface.removeColumn('platform_users', 'district_name');
    await queryInterface.removeColumn('platform_users', 'state_name');
    await queryInterface.removeColumn('platform_users', 'country_name');
    await queryInterface.removeColumn('platform_users', 'remarks');
    await queryInterface.removeColumn('platform_users', 'user_id_code');

    await queryInterface.removeIndex('tenants', 'tenants_root_geography_idx');
    await queryInterface.removeIndex('tenants', 'tenants_scope_level_idx');
    await queryInterface.removeColumn('tenants', 'root_geography_id');
    await queryInterface.removeColumn('tenants', 'address_line');
    await queryInterface.removeColumn('tenants', 'zone_name');
    await queryInterface.removeColumn('tenants', 'city_name');
    await queryInterface.removeColumn('tenants', 'district_name');
    await queryInterface.removeColumn('tenants', 'state_name');
    await queryInterface.removeColumn('tenants', 'country_name');
    await queryInterface.removeColumn('tenants', 'scope_level');
    await queryInterface.removeColumn('tenants', 'contact_mobile');
    await queryInterface.removeColumn('tenants', 'contact_email');
    await queryInterface.removeColumn('tenants', 'contact_name');
  },
};
