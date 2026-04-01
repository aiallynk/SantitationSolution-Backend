'use strict';

const { DataTypes } = require('sequelize');

const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const description = await queryInterface.describeTable(table);
  if (!description[column]) {
    await queryInterface.addColumn(table, column, spec);
  }
};

const removeColumnIfExists = async (queryInterface, table, column) => {
  const description = await queryInterface.describeTable(table);
  if (description[column]) {
    await queryInterface.removeColumn(table, column);
  }
};

const addIndexSafe = async (queryInterface, table, fields, name) => {
  try {
    await queryInterface.addIndex(table, fields, { name });
  } catch (_) {
    // no-op when index already exists
  }
};

const removeIndexSafe = async (queryInterface, table, name) => {
  try {
    await queryInterface.removeIndex(table, name);
  } catch (_) {
    // no-op when index does not exist
  }
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'inspection_media', 'image_quality_score', {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'toilet_detected', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'validation_status', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'PENDING',
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'validation_reason', {
      type: DataTypes.STRING(500),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'visibility_score', {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'perceptual_hash', {
      type: DataTypes.STRING(128),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'similarity_score', {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'prompt_version', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'scoring_version', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'scoring_rejected', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'explanation_summary', {
      type: DataTypes.STRING(2000),
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'inspections', 'suspicious_flag', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'suspicious_reasons', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'validation_failed_count', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'rejected_image_count', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['inspection_id', 'capture_stage', 'ai_status'],
      'inspection_media_inspection_stage_ai_status_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['validation_status', 'review_required'],
      'inspection_media_validation_review_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['perceptual_hash'],
      'inspection_media_perceptual_hash_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspections',
      ['toilet_unit_id', 'suspicious_flag', 'submitted_at'],
      'inspections_toilet_suspicious_submitted_idx'
    );

    await queryInterface.sequelize.query(
      `
      UPDATE inspection_media
      SET
        validation_status = CASE
          WHEN ai_status = 'AI_COMPLETED' AND validation_status IN ('PENDING', '') THEN 'LEGACY_UNVERIFIED'
          ELSE validation_status
        END,
        prompt_version = COALESCE(prompt_version, CASE WHEN ai_status = 'AI_COMPLETED' THEN 'legacy' ELSE prompt_version END),
        scoring_version = COALESCE(scoring_version, CASE WHEN ai_status = 'AI_COMPLETED' THEN 'legacy' ELSE scoring_version END),
        review_required = CASE
          WHEN ai_status = 'AI_COMPLETED' THEN true
          ELSE review_required
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE ai_status = 'AI_COMPLETED'
      `
    );

    await queryInterface.sequelize.query(
      `
      UPDATE inspections
      SET
        suspicious_flag = COALESCE(suspicious_flag, false),
        validation_failed_count = COALESCE(validation_failed_count, 0),
        rejected_image_count = COALESCE(rejected_image_count, 0),
        updated_at = CURRENT_TIMESTAMP
      WHERE id IS NOT NULL
      `
    );
  },

  async down(queryInterface) {
    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_inspection_stage_ai_status_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_validation_review_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_perceptual_hash_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspections',
      'inspections_toilet_suspicious_submitted_idx'
    );

    await removeColumnIfExists(queryInterface, 'inspections', 'rejected_image_count');
    await removeColumnIfExists(queryInterface, 'inspections', 'validation_failed_count');
    await removeColumnIfExists(queryInterface, 'inspections', 'suspicious_reasons');
    await removeColumnIfExists(queryInterface, 'inspections', 'suspicious_flag');

    await removeColumnIfExists(queryInterface, 'inspection_media', 'explanation_summary');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'scoring_rejected');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'scoring_version');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'prompt_version');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'similarity_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'perceptual_hash');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'visibility_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'validation_reason');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'validation_status');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'toilet_detected');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'image_quality_score');
  },
};
