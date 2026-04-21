'use strict';

const { DataTypes, Sequelize } = require('sequelize');

const tableExists = async (queryInterface, tableName) => {
  const all = await queryInterface.showAllTables();
  const normalized = all.map((value) =>
    typeof value === 'string'
      ? value
      : value?.tableName || value?.table_name || String(value || '')
  );
  return normalized.includes(tableName);
};

const columnExists = async (queryInterface, tableName, columnName) => {
  const definition = await queryInterface.describeTable(tableName);
  return Boolean(definition?.[columnName]);
};

const addColumnIfMissing = async (queryInterface, tableName, columnName, columnDef) => {
  if (!(await columnExists(queryInterface, tableName, columnName))) {
    await queryInterface.addColumn(tableName, columnName, columnDef);
  }
};

const addIndexIfMissing = async (queryInterface, tableName, indexName, fields, options = {}) => {
  const indexes = await queryInterface.showIndex(tableName);
  const exists = indexes.some((idx) => idx.name === indexName);
  if (!exists) {
    await queryInterface.addIndex(tableName, fields, {
      ...options,
      name: indexName,
    });
  }
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

const uuidPk = {
  type: DataTypes.UUID,
  allowNull: false,
  defaultValue: DataTypes.UUIDV4,
  primaryKey: true,
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    if (!(await tableExists(queryInterface, 'notification_events'))) {
      throw new Error('notification_events table is required before notification framework upgrade');
    }

    await addColumnIfMissing(queryInterface, 'notification_events', 'notification_type', {
      type: DataTypes.STRING(80),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'priority', {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'MEDIUM',
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'title', {
      type: DataTypes.STRING(200),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'body', {
      type: DataTypes.STRING(1200),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'short_body', {
      type: DataTypes.STRING(280),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'entity_type', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'entity_id', {
      type: DataTypes.STRING(120),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'route', {
      type: DataTypes.STRING(320),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'icon_key', {
      type: DataTypes.STRING(80),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'severity', {
      type: DataTypes.STRING(20),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'created_by_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'platform_users', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'geography_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'geographies', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'facility_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'facilities', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'audience_kind', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'delivery_state', {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'PENDING',
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'read_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'dismissed_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'dedupe_key', {
      type: DataTypes.STRING(220),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'notification_events', 'metadata', {
      type: DataTypes.JSONB,
      allowNull: true,
    });

    await addIndexIfMissing(
      queryInterface,
      'notification_events',
      'notification_events_user_created_idx',
      ['user_id', 'created_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_events',
      'notification_events_user_read_idx',
      ['user_id', 'read_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_events',
      'notification_events_user_dismissed_idx',
      ['user_id', 'dismissed_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_events',
      'notification_events_tenant_created_idx',
      ['tenant_id', 'created_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_events',
      'notification_events_type_priority_idx',
      ['notification_type', 'priority']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_events',
      'notification_events_dedupe_idx',
      ['user_id', 'dedupe_key']
    );

    if (!(await tableExists(queryInterface, 'notification_preferences'))) {
      await queryInterface.createTable('notification_preferences', {
        id: uuidPk,
        user_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'CASCADE',
        },
        notification_type: {
          type: DataTypes.STRING(80),
          allowNull: false,
        },
        in_app_web_enabled: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        in_app_mobile_enabled: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        push_mobile_enabled: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: true,
        },
        push_web_enabled: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        email_enabled: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        sms_enabled: {
          type: DataTypes.BOOLEAN,
          allowNull: false,
          defaultValue: false,
        },
        ...timestamps,
      });
    }

    await addIndexIfMissing(
      queryInterface,
      'notification_preferences',
      'notification_preferences_user_type_uk',
      ['user_id', 'notification_type'],
      { unique: true }
    );

    if (!(await tableExists(queryInterface, 'notification_device_tokens'))) {
      await queryInterface.createTable('notification_device_tokens', {
        id: uuidPk,
        user_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'CASCADE',
        },
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'SET NULL',
        },
        platform: {
          type: DataTypes.STRING(20),
          allowNull: false,
        },
        token: {
          type: DataTypes.STRING(600),
          allowNull: false,
        },
        device_id: {
          type: DataTypes.STRING(180),
          allowNull: true,
        },
        app_version: {
          type: DataTypes.STRING(80),
          allowNull: true,
        },
        locale: {
          type: DataTypes.STRING(32),
          allowNull: true,
        },
        metadata: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        last_active_at: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        disabled_at: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        ...timestamps,
      });
    }

    await addIndexIfMissing(
      queryInterface,
      'notification_device_tokens',
      'notification_device_tokens_token_uk',
      ['token'],
      { unique: true }
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_device_tokens',
      'notification_device_tokens_user_platform_idx',
      ['user_id', 'platform']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_device_tokens',
      'notification_device_tokens_tenant_idx',
      ['tenant_id']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_device_tokens',
      'notification_device_tokens_active_idx',
      ['user_id', 'disabled_at']
    );

    if (!(await tableExists(queryInterface, 'notification_delivery_logs'))) {
      await queryInterface.createTable('notification_delivery_logs', {
        id: uuidPk,
        notification_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'notification_events', key: 'id' },
          onDelete: 'CASCADE',
        },
        user_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        channel: {
          type: DataTypes.STRING(60),
          allowNull: false,
        },
        provider: {
          type: DataTypes.STRING(80),
          allowNull: true,
        },
        provider_message_id: {
          type: DataTypes.STRING(220),
          allowNull: true,
        },
        device_token_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'notification_device_tokens', key: 'id' },
          onDelete: 'SET NULL',
        },
        status: {
          type: DataTypes.STRING(20),
          allowNull: false,
          defaultValue: 'PENDING',
        },
        error_code: {
          type: DataTypes.STRING(120),
          allowNull: true,
        },
        error_message: {
          type: DataTypes.STRING(2000),
          allowNull: true,
        },
        attempted_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        delivered_at: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        metadata: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        ...timestamps,
      });
    }

    await addIndexIfMissing(
      queryInterface,
      'notification_delivery_logs',
      'notification_delivery_logs_notification_idx',
      ['notification_id', 'created_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_delivery_logs',
      'notification_delivery_logs_user_idx',
      ['user_id', 'created_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'notification_delivery_logs',
      'notification_delivery_logs_status_idx',
      ['status', 'created_at']
    );

  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'notification_delivery_logs')) {
      await queryInterface.dropTable('notification_delivery_logs');
    }
    if (await tableExists(queryInterface, 'notification_device_tokens')) {
      await queryInterface.dropTable('notification_device_tokens');
    }
    if (await tableExists(queryInterface, 'notification_preferences')) {
      await queryInterface.dropTable('notification_preferences');
    }

    if (!(await tableExists(queryInterface, 'notification_events'))) {
      return;
    }

    const removableColumns = [
      'notification_type',
      'priority',
      'title',
      'body',
      'short_body',
      'entity_type',
      'entity_id',
      'route',
      'icon_key',
      'severity',
      'created_by_user_id',
      'geography_id',
      'facility_id',
      'audience_kind',
      'delivery_state',
      'read_at',
      'dismissed_at',
      'dedupe_key',
      'metadata',
    ];

    // Best-effort rollback. Older databases may not have all of these columns.
    // eslint-disable-next-line no-restricted-syntax
    for (const columnName of removableColumns) {
      if (await columnExists(queryInterface, 'notification_events', columnName)) {
        await queryInterface.removeColumn('notification_events', columnName);
      }
    }
  },
};
