'use strict';

const { DataTypes, Sequelize } = require('sequelize');

const uuidPk = {
  type: DataTypes.UUID,
  defaultValue: DataTypes.UUIDV4,
  primaryKey: true,
  allowNull: false,
};

const timestamps = {
  created_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
  },
};

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
    await addColumnIfMissing(queryInterface, 'inspection_media', 'toilet_unit_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'toilet_units', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'worker_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'platform_users', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'assignment_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'worker_assignments', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'gps_lat', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'gps_lng', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'device_id', {
      type: DataTypes.STRING(160),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'ai_status', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'PENDING_UPLOAD',
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'image_quality_status', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'unknown',
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'overall_score', {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'confidence_score', {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'floor_score', {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'commode_score', {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'stain_score', {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'garbage_score', {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'water_score', {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'issue_tags', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'issue_summary', {
      type: DataTypes.STRING(1000),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'severity', {
      type: DataTypes.STRING(20),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'review_required', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'model_version', {
      type: DataTypes.STRING(80),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'ai_processed_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'ai_error', {
      type: DataTypes.STRING(2000),
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'inspections', 'assignment_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'worker_assignments', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'status', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'DRAFT',
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'before_image_count', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'after_image_count', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'avg_before_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'avg_after_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'improvement_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'confidence_avg', {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'inspection_result', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'before_issue_tags', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'after_issue_tags', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'resolved_issues', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'remaining_issues', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'last_scored_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'toilet_units', 'latest_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'latest_before_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'latest_after_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'avg_before_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'avg_after_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'avg_improvement_score', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'last_inspection_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'last_cleaned_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'total_inspections', {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'dirty_frequency', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: false,
      defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'toilet_units', 'low_performance_frequency', {
      type: DataTypes.DECIMAL(6, 2),
      allowNull: false,
      defaultValue: 0,
    });

    await addColumnIfMissing(queryInterface, 'ai_processing_jobs', 'image_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'inspection_media', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'ai_processing_jobs', 'job_type', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'AI_ANALYSIS',
    });

    await addColumnIfMissing(queryInterface, 'inspection_events', 'image_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'inspection_media', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'inspection_events', 'toilet_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'toilet_units', key: 'id' },
      onDelete: 'SET NULL',
    });

    await queryInterface.createTable('toilet_score_daily', {
      id: uuidPk,
      toilet_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'toilet_units', key: 'id' },
        onDelete: 'CASCADE',
      },
      date: { type: DataTypes.DATEONLY, allowNull: false },
      avg_before_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      avg_after_score: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      inspection_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      dirty_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      cleaned_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      avg_improvement: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
      ...timestamps,
    });

    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['toilet_unit_id', 'inspection_id', 'capture_stage', 'captured_at'],
      'inspection_media_toilet_inspection_stage_captured_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspection_media',
      ['ai_status', 'review_required'],
      'inspection_media_ai_status_review_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspections',
      ['toilet_unit_id', 'submitted_at', 'status'],
      'inspections_toilet_submitted_status_idx'
    );
    await addIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      ['image_id', 'status'],
      'ai_processing_jobs_image_status_idx'
    );
    await addIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      ['job_type', 'status'],
      'ai_processing_jobs_type_status_idx'
    );
    await addIndexSafe(
      queryInterface,
      'inspection_events',
      ['toilet_id', 'inspection_id', 'image_id', 'occurred_at'],
      'inspection_events_toilet_inspection_image_occurred_idx'
    );
    await addIndexSafe(
      queryInterface,
      'toilet_score_daily',
      ['toilet_id', 'date'],
      'toilet_score_daily_toilet_date_idx'
    );
    await queryInterface.addConstraint('toilet_score_daily', {
      type: 'unique',
      fields: ['toilet_id', 'date'],
      name: 'toilet_score_daily_toilet_date_uk',
    });
  },

  async down(queryInterface) {
    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_toilet_inspection_stage_captured_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspection_media',
      'inspection_media_ai_status_review_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspections',
      'inspections_toilet_submitted_status_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      'ai_processing_jobs_image_status_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'ai_processing_jobs',
      'ai_processing_jobs_type_status_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'inspection_events',
      'inspection_events_toilet_inspection_image_occurred_idx'
    );
    await removeIndexSafe(
      queryInterface,
      'toilet_score_daily',
      'toilet_score_daily_toilet_date_idx'
    );

    await removeIndexSafe(queryInterface, 'toilet_score_daily', 'toilet_score_daily_toilet_date_uk');
    await queryInterface.dropTable('toilet_score_daily');

    await removeColumnIfExists(queryInterface, 'inspection_events', 'toilet_id');
    await removeColumnIfExists(queryInterface, 'inspection_events', 'image_id');

    await removeColumnIfExists(queryInterface, 'ai_processing_jobs', 'job_type');
    await removeColumnIfExists(queryInterface, 'ai_processing_jobs', 'image_id');

    await removeColumnIfExists(queryInterface, 'toilet_units', 'low_performance_frequency');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'dirty_frequency');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'total_inspections');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'last_cleaned_at');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'last_inspection_at');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'avg_improvement_score');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'avg_after_score');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'avg_before_score');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'latest_after_score');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'latest_before_score');
    await removeColumnIfExists(queryInterface, 'toilet_units', 'latest_score');

    await removeColumnIfExists(queryInterface, 'inspections', 'last_scored_at');
    await removeColumnIfExists(queryInterface, 'inspections', 'remaining_issues');
    await removeColumnIfExists(queryInterface, 'inspections', 'resolved_issues');
    await removeColumnIfExists(queryInterface, 'inspections', 'after_issue_tags');
    await removeColumnIfExists(queryInterface, 'inspections', 'before_issue_tags');
    await removeColumnIfExists(queryInterface, 'inspections', 'inspection_result');
    await removeColumnIfExists(queryInterface, 'inspections', 'confidence_avg');
    await removeColumnIfExists(queryInterface, 'inspections', 'improvement_score');
    await removeColumnIfExists(queryInterface, 'inspections', 'avg_after_score');
    await removeColumnIfExists(queryInterface, 'inspections', 'avg_before_score');
    await removeColumnIfExists(queryInterface, 'inspections', 'after_image_count');
    await removeColumnIfExists(queryInterface, 'inspections', 'before_image_count');
    await removeColumnIfExists(queryInterface, 'inspections', 'status');
    await removeColumnIfExists(queryInterface, 'inspections', 'assignment_id');

    await removeColumnIfExists(queryInterface, 'inspection_media', 'ai_error');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'ai_processed_at');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'model_version');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'review_required');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'severity');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'issue_summary');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'issue_tags');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'water_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'garbage_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'stain_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'commode_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'floor_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'confidence_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'overall_score');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'image_quality_status');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'ai_status');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'device_id');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'gps_lng');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'gps_lat');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'assignment_id');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'worker_id');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'toilet_unit_id');
  },
};

