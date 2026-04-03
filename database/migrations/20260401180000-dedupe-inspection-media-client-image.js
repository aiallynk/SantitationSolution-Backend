'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT
          id,
          inspection_id,
          client_image_id,
          ROW_NUMBER() OVER (
            PARTITION BY inspection_id, client_image_id
            ORDER BY
              CASE WHEN COALESCE(file_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN COALESCE(thumbnail_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN ai_status = 'AI_COMPLETED' THEN 1 ELSE 0 END DESC,
              CASE WHEN upload_status IN ('confirmed', 'uploaded') THEN 1 ELSE 0 END DESC,
              COALESCE(updated_at, created_at) DESC,
              created_at DESC,
              id DESC
          ) AS rn
        FROM inspection_media
        WHERE client_image_id IS NOT NULL
          AND BTRIM(client_image_id) <> ''
      ),
      duplicates AS (
        SELECT loser.id AS old_id, winner.id AS keep_id
        FROM ranked loser
        JOIN ranked winner
          ON winner.inspection_id = loser.inspection_id
         AND winner.client_image_id = loser.client_image_id
         AND winner.rn = 1
        WHERE loser.rn > 1
      )
      UPDATE image_sessions session
         SET media_id = duplicates.keep_id,
             updated_at = NOW()
        FROM duplicates
       WHERE session.media_id = duplicates.old_id;
    `);

    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT
          id,
          inspection_id,
          client_image_id,
          ROW_NUMBER() OVER (
            PARTITION BY inspection_id, client_image_id
            ORDER BY
              CASE WHEN COALESCE(file_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN COALESCE(thumbnail_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN ai_status = 'AI_COMPLETED' THEN 1 ELSE 0 END DESC,
              CASE WHEN upload_status IN ('confirmed', 'uploaded') THEN 1 ELSE 0 END DESC,
              COALESCE(updated_at, created_at) DESC,
              created_at DESC,
              id DESC
          ) AS rn
        FROM inspection_media
        WHERE client_image_id IS NOT NULL
          AND BTRIM(client_image_id) <> ''
      ),
      duplicates AS (
        SELECT loser.id AS old_id, winner.id AS keep_id
        FROM ranked loser
        JOIN ranked winner
          ON winner.inspection_id = loser.inspection_id
         AND winner.client_image_id = loser.client_image_id
         AND winner.rn = 1
        WHERE loser.rn > 1
      )
      UPDATE inspection_events event
         SET image_id = duplicates.keep_id,
             updated_at = NOW()
        FROM duplicates
       WHERE event.image_id = duplicates.old_id;
    `);

    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT
          id,
          inspection_id,
          client_image_id,
          ROW_NUMBER() OVER (
            PARTITION BY inspection_id, client_image_id
            ORDER BY
              CASE WHEN COALESCE(file_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN COALESCE(thumbnail_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN ai_status = 'AI_COMPLETED' THEN 1 ELSE 0 END DESC,
              CASE WHEN upload_status IN ('confirmed', 'uploaded') THEN 1 ELSE 0 END DESC,
              COALESCE(updated_at, created_at) DESC,
              created_at DESC,
              id DESC
          ) AS rn
        FROM inspection_media
        WHERE client_image_id IS NOT NULL
          AND BTRIM(client_image_id) <> ''
      ),
      duplicates AS (
        SELECT loser.id AS old_id, winner.id AS keep_id
        FROM ranked loser
        JOIN ranked winner
          ON winner.inspection_id = loser.inspection_id
         AND winner.client_image_id = loser.client_image_id
         AND winner.rn = 1
        WHERE loser.rn > 1
      )
      UPDATE ai_processing_jobs job
         SET image_id = duplicates.keep_id,
             updated_at = NOW()
        FROM duplicates
       WHERE job.image_id = duplicates.old_id;
    `);

    await queryInterface.sequelize.query(`
      WITH ranked AS (
        SELECT
          id,
          inspection_id,
          client_image_id,
          ROW_NUMBER() OVER (
            PARTITION BY inspection_id, client_image_id
            ORDER BY
              CASE WHEN COALESCE(file_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN COALESCE(thumbnail_url, '') <> '' THEN 1 ELSE 0 END DESC,
              CASE WHEN ai_status = 'AI_COMPLETED' THEN 1 ELSE 0 END DESC,
              CASE WHEN upload_status IN ('confirmed', 'uploaded') THEN 1 ELSE 0 END DESC,
              COALESCE(updated_at, created_at) DESC,
              created_at DESC,
              id DESC
          ) AS rn
        FROM inspection_media
        WHERE client_image_id IS NOT NULL
          AND BTRIM(client_image_id) <> ''
      ),
      duplicates AS (
        SELECT loser.id AS old_id
        FROM ranked loser
        WHERE loser.rn > 1
      )
      DELETE FROM inspection_media media
      USING duplicates
      WHERE media.id = duplicates.old_id;
    `);

    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS inspection_media_inspection_client_image_uk
      ON inspection_media (inspection_id, client_image_id)
      WHERE client_image_id IS NOT NULL
        AND BTRIM(client_image_id) <> '';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS inspection_media_inspection_client_image_uk;
    `);
  },
};

