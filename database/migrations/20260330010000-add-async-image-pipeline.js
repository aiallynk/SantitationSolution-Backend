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

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.createTable('image_sessions', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      inspection_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'inspections', key: 'id' },
        onDelete: 'CASCADE',
      },
      media_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'inspection_media', key: 'id' },
        onDelete: 'SET NULL',
      },
      client_submission_id: { type: DataTypes.STRING(120), allowNull: true },
      client_image_id: { type: DataTypes.STRING(120), allowNull: false },
      capture_stage: { type: DataTypes.STRING(40), allowNull: false },
      ordinal: { type: DataTypes.INTEGER, allowNull: true },
      object_key: { type: DataTypes.STRING(500), allowNull: true },
      upload_method: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PUT' },
      content_type: { type: DataTypes.STRING(120), allowNull: false, defaultValue: 'image/jpeg' },
      expected_size: { type: DataTypes.BIGINT, allowNull: true },
      expected_sha256: { type: DataTypes.STRING(128), allowNull: true },
      status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'created' },
      upload_url_expires_at: { type: DataTypes.DATE, allowNull: true },
      uploaded_at: { type: DataTypes.DATE, allowNull: true },
      confirmed_at: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('image_sessions', ['inspection_id', 'status']);
    await queryInterface.addIndex('image_sessions', ['tenant_id', 'created_at']);
    await queryInterface.addConstraint('image_sessions', {
      type: 'unique',
      fields: ['inspection_id', 'client_image_id'],
      name: 'image_sessions_inspection_client_image_uk',
    });

    await queryInterface.createTable('inspection_submissions', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      inspection_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'inspections', key: 'id' },
        onDelete: 'CASCADE',
      },
      client_submission_id: { type: DataTypes.STRING(120), allowNull: true },
      idempotency_key: { type: DataTypes.STRING(200), allowNull: true },
      status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'queued_for_ai' },
      submitted_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      acknowledged_at: { type: DataTypes.DATE, allowNull: true },
      metadata: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('inspection_submissions', ['inspection_id', 'submitted_at']);
    await queryInterface.addIndex('inspection_submissions', ['tenant_id', 'status']);
    await queryInterface.addConstraint('inspection_submissions', {
      type: 'unique',
      fields: ['inspection_id', 'client_submission_id'],
      name: 'inspection_submissions_inspection_client_submission_uk',
    });

    await queryInterface.createTable('ai_processing_jobs', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      inspection_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'inspections', key: 'id' },
        onDelete: 'CASCADE',
      },
      submission_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'inspection_submissions', key: 'id' },
        onDelete: 'SET NULL',
      },
      queue_name: { type: DataTypes.STRING(120), allowNull: false },
      queue_job_id: { type: DataTypes.STRING(180), allowNull: true },
      status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'queued' },
      attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
      max_attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 3 },
      last_error: { type: DataTypes.STRING(2000), allowNull: true },
      dead_lettered_at: { type: DataTypes.DATE, allowNull: true },
      queued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      started_at: { type: DataTypes.DATE, allowNull: true },
      completed_at: { type: DataTypes.DATE, allowNull: true },
      duration_ms: { type: DataTypes.INTEGER, allowNull: true },
      payload: { type: DataTypes.JSONB, allowNull: true },
      result: { type: DataTypes.JSONB, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addIndex('ai_processing_jobs', ['inspection_id', 'queued_at']);
    await queryInterface.addIndex('ai_processing_jobs', ['queue_name', 'status']);
    await queryInterface.addIndex('ai_processing_jobs', ['tenant_id', 'status']);
    await queryInterface.addConstraint('ai_processing_jobs', {
      type: 'unique',
      fields: ['queue_name', 'queue_job_id'],
      name: 'ai_processing_jobs_queue_job_uk',
    });

    await queryInterface.createTable('inspection_events', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      inspection_id: {
        type: DataTypes.UUID,
        allowNull: false,
        references: { model: 'inspections', key: 'id' },
        onDelete: 'CASCADE',
      },
      event_type: { type: DataTypes.STRING(120), allowNull: false },
      event_status: { type: DataTypes.STRING(60), allowNull: true },
      source: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'system' },
      actor_user_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      },
      payload: { type: DataTypes.JSONB, allowNull: true },
      occurred_at: { type: DataTypes.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      ...timestamps,
    });
    await queryInterface.addIndex('inspection_events', ['inspection_id', 'occurred_at']);
    await queryInterface.addIndex('inspection_events', ['tenant_id', 'event_type']);

    await queryInterface.createTable('idempotency_keys', {
      id: uuidPk,
      tenant_id: {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'SET NULL',
      },
      scope: { type: DataTypes.STRING(140), allowNull: false },
      idempotency_key: { type: DataTypes.STRING(220), allowNull: false },
      request_hash: { type: DataTypes.STRING(200), allowNull: true },
      response_code: { type: DataTypes.INTEGER, allowNull: true },
      response_body: { type: DataTypes.JSONB, allowNull: true },
      locked_until: { type: DataTypes.DATE, allowNull: true },
      expires_at: { type: DataTypes.DATE, allowNull: true },
      ...timestamps,
    });
    await queryInterface.addConstraint('idempotency_keys', {
      type: 'unique',
      fields: ['scope', 'idempotency_key'],
      name: 'idempotency_keys_scope_key_uk',
    });
    await queryInterface.addIndex('idempotency_keys', ['tenant_id', 'scope']);
    await queryInterface.addIndex('idempotency_keys', ['expires_at']);

    await queryInterface.addColumn('inspections', 'pipeline_status', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'draft',
    });
    await queryInterface.addColumn('inspections', 'review_required', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('inspections', 'last_processing_error', {
      type: DataTypes.STRING(2000),
      allowNull: true,
    });
    await queryInterface.addIndex('inspections', ['pipeline_status']);

    await queryInterface.addColumn('inspection_media', 'client_image_id', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'upload_status', {
      type: DataTypes.STRING(40),
      allowNull: false,
      defaultValue: 'pending',
    });
    await queryInterface.addColumn('inspection_media', 'etag', {
      type: DataTypes.STRING(160),
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'sha256', {
      type: DataTypes.STRING(128),
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'content_length', {
      type: DataTypes.BIGINT,
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'width', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'height', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'watermark_meta', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'captured_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'confirmed_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'ordinal', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('inspection_media', 'upload_duration_ms', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await queryInterface.addIndex('inspection_media', ['inspection_id', 'upload_status']);
    await queryInterface.addIndex('inspection_media', ['client_image_id']);

    await queryInterface.addColumn('ai_analysis_results', 'confidence_score', {
      type: DataTypes.DECIMAL(6, 4),
      allowNull: true,
    });
    await queryInterface.addColumn('ai_analysis_results', 'review_required', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
    await queryInterface.addColumn('ai_analysis_results', 'sub_scores', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn('ai_analysis_results', 'issue_tags', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn('ai_analysis_results', 'severity_label', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await queryInterface.addColumn('ai_analysis_results', 'explanation_text', {
      type: DataTypes.STRING(2000),
      allowNull: true,
    });
    await queryInterface.addColumn('ai_analysis_results', 'processing_ms', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await queryInterface.addColumn('ai_analysis_results', 'schema_version', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await queryInterface.addColumn('ai_analysis_results', 'provider', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('ai_analysis_results', 'provider');
    await queryInterface.removeColumn('ai_analysis_results', 'schema_version');
    await queryInterface.removeColumn('ai_analysis_results', 'processing_ms');
    await queryInterface.removeColumn('ai_analysis_results', 'explanation_text');
    await queryInterface.removeColumn('ai_analysis_results', 'severity_label');
    await queryInterface.removeColumn('ai_analysis_results', 'issue_tags');
    await queryInterface.removeColumn('ai_analysis_results', 'sub_scores');
    await queryInterface.removeColumn('ai_analysis_results', 'review_required');
    await queryInterface.removeColumn('ai_analysis_results', 'confidence_score');

    await queryInterface.removeIndex('inspection_media', ['client_image_id']);
    await queryInterface.removeIndex('inspection_media', ['inspection_id', 'upload_status']);
    await queryInterface.removeColumn('inspection_media', 'upload_duration_ms');
    await queryInterface.removeColumn('inspection_media', 'ordinal');
    await queryInterface.removeColumn('inspection_media', 'confirmed_at');
    await queryInterface.removeColumn('inspection_media', 'captured_at');
    await queryInterface.removeColumn('inspection_media', 'watermark_meta');
    await queryInterface.removeColumn('inspection_media', 'height');
    await queryInterface.removeColumn('inspection_media', 'width');
    await queryInterface.removeColumn('inspection_media', 'content_length');
    await queryInterface.removeColumn('inspection_media', 'sha256');
    await queryInterface.removeColumn('inspection_media', 'etag');
    await queryInterface.removeColumn('inspection_media', 'upload_status');
    await queryInterface.removeColumn('inspection_media', 'client_image_id');

    await queryInterface.removeIndex('inspections', ['pipeline_status']);
    await queryInterface.removeColumn('inspections', 'last_processing_error');
    await queryInterface.removeColumn('inspections', 'review_required');
    await queryInterface.removeColumn('inspections', 'pipeline_status');

    await queryInterface.dropTable('idempotency_keys');
    await queryInterface.dropTable('inspection_events');
    await queryInterface.dropTable('ai_processing_jobs');
    await queryInterface.dropTable('inspection_submissions');
    await queryInterface.dropTable('image_sessions');
  },
};

