'use strict';

const { QueryTypes } = require('sequelize');
const { sequelize } = require('../src/models');

const sql = `
WITH media_diffs AS (
  SELECT
    i.id AS inspection_id,
    i.captured_at AS inspection_captured_at,
    MIN(im.captured_at) AS first_media_captured_at,
    EXTRACT(EPOCH FROM (i.captured_at - MIN(im.captured_at))) / 60.0 AS diff_minutes
  FROM inspections i
  LEFT JOIN inspection_media im ON im.inspection_id = i.id AND im.captured_at IS NOT NULL
  WHERE i.captured_at IS NOT NULL
  GROUP BY i.id, i.captured_at
),
summary AS (
  SELECT
    COUNT(*) FILTER (WHERE first_media_captured_at IS NULL) AS inspections_without_media_timestamp,
    COUNT(*) FILTER (WHERE ABS(diff_minutes - 330) <= 2 OR ABS(diff_minutes + 330) <= 2) AS suspected_ist_double_or_reverse_shift,
    COUNT(*) FILTER (WHERE ABS(diff_minutes) <= 2) AS inspection_media_times_aligned,
    COUNT(*) FILTER (WHERE ABS(diff_minutes) > 2 AND ABS(diff_minutes - 330) > 2 AND ABS(diff_minutes + 330) > 2) AS other_timestamp_mismatches
  FROM media_diffs
)
SELECT * FROM summary;
`;

async function main() {
  const [summary] = await sequelize.query(sql, { type: QueryTypes.SELECT });
  const samples = await sequelize.query(
    `
    SELECT *
    FROM (
      SELECT
        i.id AS "inspectionId",
        i.captured_at AS "inspectionCapturedAt",
        MIN(im.captured_at) AS "firstMediaCapturedAt",
        ROUND((EXTRACT(EPOCH FROM (i.captured_at - MIN(im.captured_at))) / 60.0)::numeric, 2) AS "diffMinutes"
      FROM inspections i
      LEFT JOIN inspection_media im ON im.inspection_id = i.id AND im.captured_at IS NOT NULL
      WHERE i.captured_at IS NOT NULL
      GROUP BY i.id, i.captured_at
    ) rows
    WHERE ABS("diffMinutes") > 2
    ORDER BY ABS("diffMinutes") DESC
    LIMIT 25
    `,
    { type: QueryTypes.SELECT },
  );

  console.log(JSON.stringify({ summary, suspiciousSamples: samples }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close().catch(() => null);
  });
