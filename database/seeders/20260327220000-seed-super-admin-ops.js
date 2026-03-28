'use strict';

const crypto = require('crypto');

const toJsonb = (value) => JSON.stringify(value ?? {});

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const now = new Date();

    const [tenant] = await queryInterface.sequelize.query(
      `SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1`,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );
    const [superAdmin] = await queryInterface.sequelize.query(
      `
      SELECT pu.id
      FROM platform_users pu
      JOIN user_roles ur ON ur.user_id = pu.id
      JOIN roles r ON r.id = ur.role_id
      WHERE r.code = 'super_admin'
      ORDER BY pu.created_at ASC
      LIMIT 1
    `,
      { type: queryInterface.sequelize.QueryTypes.SELECT }
    );

    if (!tenant || !superAdmin) {
      return;
    }

    await queryInterface.bulkInsert('super_admin_projects', [
      {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        name: 'City Smart Toilet Revamp',
        code: 'PRJ-CITY-REVAMP',
        category: 'deployment',
        status: 'active',
        starts_at: now,
        ends_at: null,
        geography_id: null,
        metadata: toJsonb({ owner: 'platform_ops', source: 'seed' }),
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('super_admin_approvals', [
      {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        requested_by_user_id: superAdmin.id,
        reviewed_by_user_id: null,
        category: 'tenant_onboarding',
        entity_type: 'tenant',
        entity_id: tenant.id,
        status: 'pending',
        notes: 'Initial tenant approval request',
        reviewed_at: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('super_admin_support_tickets', [
      {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        opened_by_user_id: superAdmin.id,
        assigned_to_user_id: superAdmin.id,
        subject: 'Sensor ingestion payload mismatch',
        description: 'Tenant reported non-standard payload keys from old firmware.',
        severity: 'high',
        status: 'open',
        resolved_at: null,
        metadata: toJsonb({ channel: 'portal' }),
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('super_admin_release_records', [
      {
        id: crypto.randomUUID(),
        version: '2026.03.27',
        environment: 'staging',
        status: 'success',
        deployed_by_user_id: superAdmin.id,
        deployed_at: now,
        notes: 'Staging rollout completed',
        metadata: toJsonb({ commit: 'seed-demo' }),
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('super_admin_backup_records', [
      {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        backup_type: 'database',
        storage_key: 'backups/demo/latest.dump',
        size_bytes: 1024 * 1024 * 12,
        status: 'completed',
        started_at: new Date(now.getTime() - 20 * 60 * 1000),
        completed_at: new Date(now.getTime() - 10 * 60 * 1000),
        retention_until: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
        metadata: toJsonb({ provider: 'supabase-storage' }),
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('super_admin_sync_failures', [
      {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        source_module: 'mobile-inspection-sync',
        reference_id: `draft-${Date.now()}`,
        severity: 'medium',
        reason: 'Temporary media upload timeout',
        payload: toJsonb({ retryable: true }),
        status: 'open',
        first_seen_at: now,
        last_seen_at: now,
        resolved_at: null,
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('super_admin_tenant_health', [
      {
        id: crypto.randomUUID(),
        tenant_id: tenant.id,
        snapshot_at: now,
        health_score: 86.5,
        open_alerts: 2,
        pending_tasks: 3,
        failed_syncs: 1,
        active_sensors: 4,
        total_sensors: 5,
        metadata: toJsonb({ source: 'seed_snapshot' }),
        created_at: now,
        updated_at: now,
      },
    ]);

    await queryInterface.bulkInsert('integration_configs', [
      {
        id: crypto.randomUUID(),
        tenant_id: null,
        name: 'global_scoring_thresholds',
        config_type: 'scoring_thresholds',
        config_json: toJsonb({ clean: 80, moderate: 60, poor: 40 }),
        enabled: true,
        created_at: now,
        updated_at: now,
      },
      {
        id: crypto.randomUUID(),
        tenant_id: null,
        name: 'global_escalation_policies',
        config_type: 'escalation_policies',
        config_json: toJsonb({
          criticalAlertAckMinutes: 10,
          unresolvedAlertEscalationMinutes: 30,
          sensorOfflineMinutes: 30,
        }),
        enabled: true,
        created_at: now,
        updated_at: now,
      },
      {
        id: crypto.randomUUID(),
        tenant_id: null,
        name: 'global_localization',
        config_type: 'localization',
        config_json: toJsonb({ defaultLanguage: 'en-IN', timezone: 'Asia/Kolkata' }),
        enabled: true,
        created_at: now,
        updated_at: now,
      },
      {
        id: crypto.randomUUID(),
        tenant_id: null,
        name: 'global_policy_docs',
        config_type: 'policy_document',
        config_json: toJsonb({
          revision: '2026-Q1',
          title: 'Platform Governance Baseline',
          url: 'https://intranet.example/policies/platform-governance',
        }),
        enabled: true,
        created_at: now,
        updated_at: now,
      },
    ]);
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete('super_admin_tenant_health', null, {});
    await queryInterface.bulkDelete('super_admin_sync_failures', null, {});
    await queryInterface.bulkDelete('super_admin_backup_records', null, {});
    await queryInterface.bulkDelete('super_admin_release_records', null, {});
    await queryInterface.bulkDelete('super_admin_support_tickets', null, {});
    await queryInterface.bulkDelete('super_admin_approvals', null, {});
    await queryInterface.bulkDelete('super_admin_projects', null, {});
    await queryInterface.bulkDelete('integration_configs', {
      config_type: ['scoring_thresholds', 'escalation_policies', 'localization', 'policy_document'],
    });
  },
};
