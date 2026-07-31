'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS operational_master_data (
        id UUID PRIMARY KEY,
        master_type VARCHAR(80) NOT NULL,
        code VARCHAR(120) NOT NULL,
        name VARCHAR(200) NOT NULL,
        description VARCHAR(600),
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        source_scope VARCHAR(20) NOT NULL,
        state_id UUID REFERENCES geographies(id) ON DELETE SET NULL,
        tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
        is_mandatory BOOLEAN NOT NULL DEFAULT FALSE,
        allow_tenant_override BOOLEAN NOT NULL DEFAULT FALSE,
        parent_id UUID REFERENCES operational_master_data(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
        updated_by_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT operational_master_data_status_ck CHECK (status IN ('active', 'inactive')),
        CONSTRAINT operational_master_data_scope_ck CHECK (source_scope IN ('PLATFORM', 'STATE', 'TENANT'))
      );

      CREATE INDEX IF NOT EXISTS operational_master_data_scope_idx
        ON operational_master_data(master_type, source_scope, state_id, tenant_id, status, updated_at DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS operational_master_data_code_scope_uk
        ON operational_master_data (
          master_type,
          LOWER(code),
          source_scope,
          COALESCE(state_id, '00000000-0000-0000-0000-000000000000'::uuid),
          COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
        );
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS operational_master_data_code_scope_uk;
      DROP INDEX IF EXISTS operational_master_data_scope_idx;
      DROP TABLE IF EXISTS operational_master_data;
    `);
  },
};
