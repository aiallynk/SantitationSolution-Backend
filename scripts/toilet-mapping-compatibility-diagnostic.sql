-- Read-only diagnostic for legacy/new toilet mapping compatibility.
-- Run only against the intended environment, in a read-only transaction:
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$DATABASE_URL" \
--     -v ON_ERROR_STOP=1 -f scripts/toilet-mapping-compatibility-diagnostic.sql
--
-- This script intentionally returns counts and masked identifiers only. It makes
-- no DDL or DML changes and is safe to use before considering any repair.

BEGIN TRANSACTION READ ONLY;

SELECT
  current_setting('server_version') AS postgres_version,
  current_setting('transaction_read_only') AS transaction_read_only,
  COUNT(*) FILTER (WHERE name = '20260716130000-add-geography-assignments-and-compatibility.js') AS legacy_compatibility_migration_recorded,
  COUNT(*) FILTER (WHERE name = '20260716140000-add-global-geography-import-pipeline.js') AS global_geography_migration_recorded
FROM sequelize_meta;

WITH toilet_context AS (
  SELECT
    tu.id,
    tu.deleted_at,
    tu.deactivated_at,
    tu.status AS toilet_status,
    f.id AS facility_id,
    f.tenant_id,
    f.geography_id,
    f.zone_geography_id,
    f.ward_geography_id,
    g.tenant_id AS geography_tenant_id,
    g.global_geography_id,
    g.master_geography_id,
    g.is_active AS geography_active,
    tb.id AS toilet_block_id
  FROM toilet_units tu
  LEFT JOIN facilities f ON f.id = tu.facility_id
  LEFT JOIN geographies g ON g.id = f.geography_id
  LEFT JOIN toilet_blocks tb ON tb.id = tu.toilet_block_id
), classified AS (
  SELECT *,
    CASE
      WHEN facility_id IS NULL THEN 'orphaned_facility_reference'
      WHEN geography_id IS NULL THEN 'legacy_no_geography'
      WHEN geography_tenant_id IS NULL THEN 'new_global_geography_reference'
      WHEN geography_tenant_id = tenant_id
        AND (global_geography_id IS NOT NULL OR master_geography_id IS NOT NULL)
        THEN 'tenant_geography_linked_to_global'
      WHEN geography_tenant_id = tenant_id THEN 'legacy_tenant_geography'
      ELSE 'invalid_cross_tenant_geography'
    END AS mapping_observation
  FROM toilet_context
)
SELECT
  mapping_observation,
  COUNT(*) AS toilets,
  COUNT(*) FILTER (WHERE deleted_at IS NULL) AS not_soft_deleted,
  COUNT(*) FILTER (WHERE deleted_at IS NULL AND deactivated_at IS NULL AND toilet_status <> 'out_of_service') AS active,
  COUNT(*) FILTER (WHERE toilet_block_id IS NULL) AS missing_block_reference,
  COUNT(*) FILTER (WHERE geography_active IS FALSE) AS inactive_geography_reference
FROM classified
GROUP BY mapping_observation
ORDER BY mapping_observation;

WITH toilet_context AS (
  SELECT
    tu.id,
    f.tenant_id,
    f.geography_id,
    g.tenant_id AS geography_tenant_id,
    g.global_geography_id,
    g.master_geography_id
  FROM toilet_units tu
  JOIN facilities f ON f.id = tu.facility_id
  LEFT JOIN geographies g ON g.id = f.geography_id
  WHERE tu.deleted_at IS NULL
)
SELECT
  substr(md5(COALESCE(tenant_id::text, 'none')), 1, 12) AS tenant_mask,
  CASE
    WHEN geography_id IS NULL THEN 'legacy_no_geography'
    WHEN geography_tenant_id IS NULL THEN 'new_global_geography_reference'
    WHEN geography_tenant_id = tenant_id
      AND (global_geography_id IS NOT NULL OR master_geography_id IS NOT NULL)
      THEN 'tenant_geography_linked_to_global'
    WHEN geography_tenant_id = tenant_id THEN 'legacy_tenant_geography'
    ELSE 'invalid_cross_tenant_geography'
  END AS mapping_observation,
  COUNT(*) AS toilets
FROM toilet_context
GROUP BY tenant_mask, mapping_observation
ORDER BY tenant_mask, mapping_observation;

-- Representative rows are deliberately masked. Use only for relationship shape,
-- not as a data export.
WITH representative_rows AS (
  SELECT
    tu.id,
    tu.facility_id,
    tu.toilet_block_id,
    tu.deleted_at,
    f.tenant_id,
    f.geography_id,
    g.tenant_id AS geography_tenant_id,
    g.global_geography_id,
    g.master_geography_id,
    ROW_NUMBER() OVER (
      PARTITION BY
        CASE
          WHEN f.geography_id IS NULL THEN 'legacy_no_geography'
          WHEN g.tenant_id IS NULL THEN 'new_global_geography_reference'
          WHEN g.tenant_id = f.tenant_id
            AND (g.global_geography_id IS NOT NULL OR g.master_geography_id IS NOT NULL)
            THEN 'tenant_geography_linked_to_global'
          WHEN g.tenant_id = f.tenant_id THEN 'legacy_tenant_geography'
          ELSE 'invalid_cross_tenant_geography'
        END
      ORDER BY tu.created_at ASC
    ) AS sample_number,
    CASE
      WHEN f.geography_id IS NULL THEN 'legacy_no_geography'
      WHEN g.tenant_id IS NULL THEN 'new_global_geography_reference'
      WHEN g.tenant_id = f.tenant_id
        AND (g.global_geography_id IS NOT NULL OR g.master_geography_id IS NOT NULL)
        THEN 'tenant_geography_linked_to_global'
      WHEN g.tenant_id = f.tenant_id THEN 'legacy_tenant_geography'
      ELSE 'invalid_cross_tenant_geography'
    END AS mapping_observation
  FROM toilet_units tu
  JOIN facilities f ON f.id = tu.facility_id
  LEFT JOIN geographies g ON g.id = f.geography_id
)
SELECT
  mapping_observation,
  sample_number,
  substr(md5(id::text), 1, 12) AS toilet_mask,
  substr(md5(facility_id::text), 1, 12) AS facility_mask,
  substr(md5(tenant_id::text), 1, 12) AS tenant_mask,
  CASE WHEN toilet_block_id IS NULL THEN 'missing' ELSE 'present' END AS toilet_block,
  CASE WHEN geography_id IS NULL THEN 'missing' ELSE 'present' END AS geography,
  CASE WHEN global_geography_id IS NULL THEN 'missing' ELSE 'present' END AS global_link,
  CASE WHEN master_geography_id IS NULL THEN 'missing' ELSE 'present' END AS master_link,
  CASE WHEN deleted_at IS NULL THEN 'not_deleted' ELSE 'soft_deleted' END AS lifecycle
FROM representative_rows
WHERE sample_number <= 3
ORDER BY mapping_observation, sample_number;

ROLLBACK;
