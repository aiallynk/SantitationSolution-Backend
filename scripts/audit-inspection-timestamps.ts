#!/usr/bin/env node

require('dotenv').config();

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');

const OFFSET_TOLERANCE_MINUTES = 10;

async function main() {
  const suspiciousMediaRows = await sequelize.query(
    `
      SELECT
        im.id AS media_id,
        im.inspection_id,
        im.capture_stage,
        im.captured_at,
        im.captured_at_utc,
        im.capture_timezone,
        im.capture_time_source,
        im.created_at,
        ROUND(EXTRACT(EPOCH FROM (im.captured_at - im.created_at)) / 60.0, 2) AS capture_minus_created_minutes,
        i.submitted_at,
        pu.full_name AS worker_name,
        tu.id AS toilet_id,
        tu.code AS toilet_code
      FROM inspection_media im
      JOIN inspections i ON i.id = im.inspection_id
      LEFT JOIN platform_users pu ON pu.id = i.inspector_user_id
      LEFT JOIN toilet_units tu ON tu.id = i.toilet_unit_id
      WHERE im.captured_at IS NOT NULL
        AND im.created_at IS NOT NULL
        AND ABS(
          (EXTRACT(EPOCH FROM (im.captured_at - im.created_at)) / 60.0)
          - COALESCE(im.capture_offset_minutes, 330)
        ) <= :tolerance
      ORDER BY im.created_at DESC
      LIMIT 25
    `,
    {
      replacements: { tolerance: OFFSET_TOLERANCE_MINUTES },
      type: QueryTypes.SELECT,
    }
  );

  const [summary] = await sequelize.query(
    `
      SELECT
        COUNT(*) FILTER (
          WHERE im.captured_at IS NOT NULL
            AND im.created_at IS NOT NULL
            AND ABS(
              (EXTRACT(EPOCH FROM (im.captured_at - im.created_at)) / 60.0)
              - COALESCE(im.capture_offset_minutes, 330)
            ) <= :tolerance
        ) AS suspicious_local_as_utc_media,
        COUNT(*) FILTER (
          WHERE im.capture_timezone IS NULL OR im.capture_timezone = ''
        ) AS media_missing_capture_timezone,
        COUNT(*) FILTER (
          WHERE i.capture_timezone IS NULL OR i.capture_timezone = ''
        ) AS inspections_missing_capture_timezone,
        COUNT(DISTINCT i.id) AS inspections_with_media
      FROM inspection_media im
      JOIN inspections i ON i.id = im.inspection_id
    `,
    {
      replacements: { tolerance: OFFSET_TOLERANCE_MINUTES },
      type: QueryTypes.SELECT,
    }
  );

  const aggregateRows = await sequelize.query(
    `
      SELECT
        id AS toilet_id,
        code AS toilet_code,
        last_inspection_at,
        last_cleaned_at
      FROM toilet_units
      WHERE last_inspection_at IS NOT NULL
        AND last_cleaned_at IS NOT NULL
        AND last_inspection_at = last_cleaned_at
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 25
    `,
    { type: QueryTypes.SELECT }
  );

  const output = {
    readOnly: true,
    generatedAt: new Date().toISOString(),
    toleranceMinutes: OFFSET_TOLERANCE_MINUTES,
    summary,
    suspiciousMediaSamples: suspiciousMediaRows,
    duplicatedAggregateSamples: aggregateRows,
    notes: [
      'Rows are suspicious when captured_at minus created_at approximately equals the capture offset.',
      'This is consistent with local wall-clock time stored in a UTC timestamp column.',
      'The script does not update data.',
    ],
  };

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close().catch(() => null);
  });
