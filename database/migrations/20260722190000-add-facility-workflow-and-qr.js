'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE geographies
      ADD COLUMN IF NOT EXISTS description VARCHAR(600);

      ALTER TABLE facilities
      ADD COLUMN IF NOT EXISTS contact_name VARCHAR(180);
      ALTER TABLE facilities
      ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(32);
      ALTER TABLE facilities
      ADD COLUMN IF NOT EXISTS contact_email VARCHAR(180);
      ALTER TABLE facilities
      ADD COLUMN IF NOT EXISTS location_status VARCHAR(40) NOT NULL DEFAULT 'mapped';

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE t.typname = 'enum_facilities_status'
        ) THEN
          BEGIN
            ALTER TYPE "enum_facilities_status" ADD VALUE IF NOT EXISTS 'location_pending';
          EXCEPTION WHEN duplicate_object THEN
            NULL;
          END;
        END IF;
      END $$;

      UPDATE facilities
      SET location_status = CASE
        WHEN latitude IS NOT NULL AND longitude IS NOT NULL THEN 'mapped'
        ELSE 'pending'
      END
      WHERE location_status IS NULL
         OR location_status NOT IN ('mapped', 'pending');

      CREATE TABLE IF NOT EXISTS facility_qr_codes (
        id UUID PRIMARY KEY,
        tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
        facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
        qr_token_hash VARCHAR(128) NOT NULL,
        schema_version VARCHAR(40) NOT NULL DEFAULT 'facility_qr_v1',
        qr_payload JSONB,
        status VARCHAR(20) NOT NULL DEFAULT 'active',
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        compromised_reason VARCHAR(600),
        last_scanned_at TIMESTAMP WITH TIME ZONE,
        created_by_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
        updated_by_user_id UUID REFERENCES platform_users(id) ON DELETE SET NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS facility_qr_codes_token_hash_uk
        ON facility_qr_codes(qr_token_hash);

      CREATE UNIQUE INDEX IF NOT EXISTS facility_qr_codes_primary_uk
        ON facility_qr_codes(facility_id)
        WHERE is_primary = TRUE;

      CREATE INDEX IF NOT EXISTS facility_qr_codes_facility_status_idx
        ON facility_qr_codes(facility_id, status, is_primary);
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS facility_qr_codes_facility_status_idx;
      DROP INDEX IF EXISTS facility_qr_codes_primary_uk;
      DROP INDEX IF EXISTS facility_qr_codes_token_hash_uk;
      DROP TABLE IF EXISTS facility_qr_codes;
      ALTER TABLE facilities DROP COLUMN IF EXISTS location_status;
      ALTER TABLE facilities DROP COLUMN IF EXISTS contact_email;
      ALTER TABLE facilities DROP COLUMN IF EXISTS contact_phone;
      ALTER TABLE facilities DROP COLUMN IF EXISTS contact_name;
      ALTER TABLE geographies DROP COLUMN IF EXISTS description;
    `);
  },
};
