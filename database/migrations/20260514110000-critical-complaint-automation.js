'use strict';

const { DataTypes, Sequelize } = require('sequelize');

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

const normalizeTableName = (value) =>
  typeof value === 'string'
    ? value
    : value?.tableName || value?.table_name || String(value || '');

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
};

const columnExists = async (queryInterface, tableName, columnName) => {
  if (!(await tableExists(queryInterface, tableName))) return false;
  const definition = await queryInterface.describeTable(tableName);
  return Boolean(definition?.[columnName]);
};

const addColumnIfMissing = async (queryInterface, tableName, columnName, columnDef) => {
  if (!(await columnExists(queryInterface, tableName, columnName))) {
    await queryInterface.addColumn(tableName, columnName, columnDef);
  }
};

const addIndexIfMissing = async (queryInterface, tableName, indexName, fields, options = {}) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (!indexes.some((index) => index.name === indexName)) {
    await queryInterface.addIndex(tableName, fields, { ...options, name: indexName });
  }
};

const addEnumValueIfMissing = async (queryInterface, typeName, value) => {
  if (queryInterface.sequelize.getDialect() !== 'postgres') return;
  if (!/^[a-zA-Z0-9_]+$/.test(String(typeName || '')) || !/^[a-zA-Z0-9_]+$/.test(String(value || ''))) {
    throw new Error(`Invalid enum identifiers: ${typeName} / ${value}`);
  }
  const safeType = String(typeName);
  const safeValue = String(value);
  try {
    await queryInterface.sequelize.query(
      `ALTER TYPE "${safeType}" ADD VALUE IF NOT EXISTS '${safeValue}'`,
    );
  } catch (error) {
    const message = String(error?.parent?.message || error?.message || '').toLowerCase();
    if (
      message.includes('already exists') ||
      message.includes('duplicate') ||
      message.includes('42710')
    ) {
      return;
    }
    throw error;
  }
};

module.exports = {
  async up(queryInterface) {
    await addEnumValueIfMissing(queryInterface, 'enum_inspection_tasks_status', 'unassigned');
    await addEnumValueIfMissing(queryInterface, 'enum_inspection_tasks_status', 'assigned');
    await addEnumValueIfMissing(queryInterface, 'enum_inspection_tasks_status', 'accepted');

    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'complaint_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'complaints', key: 'id' },
      onDelete: 'SET NULL',
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'assigned_by_user_id', {
      type: DataTypes.UUID,
      allowNull: true,
      references: { model: 'platform_users', key: 'id' },
      onDelete: 'SET NULL',
    });
    if (await columnExists(queryInterface, 'inspection_tasks', 'assigned_to_user_id')) {
      await queryInterface.changeColumn('inspection_tasks', 'assigned_to_user_id', {
        type: DataTypes.UUID,
        allowNull: true,
        references: { model: 'platform_users', key: 'id' },
        onDelete: 'SET NULL',
      });
    }
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'title', {
      type: DataTypes.STRING(220),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'description', {
      type: DataTypes.STRING(1200),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'priority', {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'medium',
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'latitude', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'longitude', {
      type: DataTypes.DECIMAL(10, 7),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'due_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'accepted_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'cancelled_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'assignment_source', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'assignment_reason', {
      type: DataTypes.STRING(600),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'distance_km', {
      type: DataTypes.DECIMAL(10, 3),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'worker_location_snapshot', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'critical_detected_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'reminder_state', {
      type: DataTypes.JSONB,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_tasks', 'metadata', {
      type: DataTypes.JSONB,
      allowNull: true,
    });

    await addIndexIfMissing(queryInterface, 'inspection_tasks', 'inspection_tasks_complaint_idx', ['complaint_id']);
    await addIndexIfMissing(queryInterface, 'inspection_tasks', 'inspection_tasks_worker_status_idx', ['assigned_to_user_id', 'status']);
    await addIndexIfMissing(queryInterface, 'inspection_tasks', 'inspection_tasks_status_due_idx', ['status', 'due_at']);
    await addIndexIfMissing(queryInterface, 'inspection_tasks', 'inspection_tasks_priority_status_idx', ['priority', 'status']);
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS inspection_tasks_critical_complaint_active_unique
        ON inspection_tasks (complaint_id, task_type)
        WHERE complaint_id IS NOT NULL
          AND task_type = 'critical_complaint'
          AND status IN ('unassigned', 'assigned', 'accepted', 'pending', 'in_progress', 'overdue')
      `);
    }

    if (!(await tableExists(queryInterface, 'worker_heartbeats'))) {
      await queryInterface.createTable('worker_heartbeats', {
        id: uuidPk,
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
        },
        worker_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'CASCADE',
        },
        latitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
        longitude: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
        accuracy: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        speed: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        heading: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
        mobile_battery_percentage: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
        is_charging: { type: DataTypes.BOOLEAN, allowNull: true },
        source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'mobile_app' },
        captured_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        metadata: { type: DataTypes.JSONB, allowNull: true },
        ...timestamps,
      });
    }
    await addIndexIfMissing(queryInterface, 'worker_heartbeats', 'worker_heartbeats_worker_captured_idx', ['worker_id', 'captured_at']);
    await addIndexIfMissing(queryInterface, 'worker_heartbeats', 'worker_heartbeats_tenant_captured_idx', ['tenant_id', 'captured_at']);
    await addIndexIfMissing(queryInterface, 'worker_heartbeats', 'worker_heartbeats_location_idx', ['latitude', 'longitude']);

    if (!(await tableExists(queryInterface, 'task_assignment_logs'))) {
      await queryInterface.createTable('task_assignment_logs', {
        id: uuidPk,
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
        },
        task_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'inspection_tasks', key: 'id' },
          onDelete: 'CASCADE',
        },
        complaint_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'complaints', key: 'id' },
          onDelete: 'SET NULL',
        },
        toilet_unit_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'toilet_units', key: 'id' },
          onDelete: 'SET NULL',
        },
        worker_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        supervisor_user_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        assigned_by_user_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        assignment_source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'automation' },
        reason: { type: DataTypes.STRING(800), allowNull: true },
        status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'created' },
        distance_km: { type: DataTypes.DECIMAL(10, 3), allowNull: true },
        worker_location_snapshot: { type: DataTypes.JSONB, allowNull: true },
        metadata: { type: DataTypes.JSONB, allowNull: true },
        ...timestamps,
      });
    }
    await addIndexIfMissing(queryInterface, 'task_assignment_logs', 'task_assignment_logs_task_idx', ['task_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'task_assignment_logs', 'task_assignment_logs_complaint_idx', ['complaint_id', 'created_at']);
    await addIndexIfMissing(queryInterface, 'task_assignment_logs', 'task_assignment_logs_worker_idx', ['worker_id', 'created_at']);

    if (!(await tableExists(queryInterface, 'task_reminder_logs'))) {
      await queryInterface.createTable('task_reminder_logs', {
        id: uuidPk,
        tenant_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
        },
        task_id: {
          type: DataTypes.UUID,
          allowNull: false,
          references: { model: 'inspection_tasks', key: 'id' },
          onDelete: 'CASCADE',
        },
        worker_id: {
          type: DataTypes.UUID,
          allowNull: true,
          references: { model: 'platform_users', key: 'id' },
          onDelete: 'SET NULL',
        },
        reminder_type: { type: DataTypes.STRING(60), allowNull: false },
        sent_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        },
        status: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'sent' },
        channel: { type: DataTypes.STRING(60), allowNull: false, defaultValue: 'in_app' },
        metadata: { type: DataTypes.JSONB, allowNull: true },
        ...timestamps,
      });
    }
    await addIndexIfMissing(queryInterface, 'task_reminder_logs', 'task_reminder_logs_task_type_idx', ['task_id', 'reminder_type']);
    await addIndexIfMissing(queryInterface, 'task_reminder_logs', 'task_reminder_logs_worker_sent_idx', ['worker_id', 'sent_at']);
  },

  async down(queryInterface) {
    if (queryInterface.sequelize.getDialect() === 'postgres') {
      await queryInterface.sequelize.query(
        'DROP INDEX IF EXISTS inspection_tasks_critical_complaint_active_unique'
      );
    }
    if (await tableExists(queryInterface, 'task_reminder_logs')) {
      await queryInterface.dropTable('task_reminder_logs');
    }
    if (await tableExists(queryInterface, 'task_assignment_logs')) {
      await queryInterface.dropTable('task_assignment_logs');
    }
    if (await tableExists(queryInterface, 'worker_heartbeats')) {
      await queryInterface.dropTable('worker_heartbeats');
    }

    const columns = [
      'metadata',
      'reminder_state',
      'critical_detected_at',
      'worker_location_snapshot',
      'distance_km',
      'assignment_reason',
      'assignment_source',
      'cancelled_at',
      'accepted_at',
      'due_at',
      'longitude',
      'latitude',
      'priority',
      'description',
      'title',
      'assigned_by_user_id',
      'complaint_id',
    ];
    for (const column of columns) {
      if (await columnExists(queryInterface, 'inspection_tasks', column)) {
        await queryInterface.removeColumn('inspection_tasks', column);
      }
    }
  },
};
