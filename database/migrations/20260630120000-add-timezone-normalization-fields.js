'use strict';

const { DataTypes, Sequelize } = require('sequelize');

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
  const description = await queryInterface.describeTable(tableName);
  return Object.prototype.hasOwnProperty.call(description, columnName);
};

const addColumnIfMissing = async (queryInterface, tableName, columnName, definition) => {
  if (await columnExists(queryInterface, tableName, columnName)) return;
  await queryInterface.addColumn(tableName, columnName, definition);
};

const removeColumnIfExists = async (queryInterface, tableName, columnName) => {
  if (!(await columnExists(queryInterface, tableName, columnName))) return;
  await queryInterface.removeColumn(tableName, columnName);
};

module.exports = {
  async up(queryInterface) {
    await addColumnIfMissing(queryInterface, 'tenants', 'timezone', {
      type: DataTypes.STRING(64),
      allowNull: false,
      defaultValue: 'Asia/Kolkata',
    });

    await addColumnIfMissing(queryInterface, 'facilities', 'timezone', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'toilet_units', 'timezone', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'inspections', 'captured_at_utc', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'capture_timezone', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'capture_offset_minutes', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspections', 'capture_time_source', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'inspection_media', 'captured_at_utc', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'capture_timezone', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'capture_offset_minutes', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'inspection_media', 'capture_time_source', {
      type: DataTypes.STRING(40),
      allowNull: true,
    });

    await addColumnIfMissing(queryInterface, 'sensor_readings', 'recorded_at_utc', {
      type: DataTypes.DATE,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'sensor_readings', 'source_timezone', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'sensor_readings', 'source_offset_minutes', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE tenants
      SET timezone = COALESCE(NULLIF(timezone, ''), NULLIF(metadata->>'timezone', ''), 'Asia/Kolkata')
      WHERE timezone IS NULL OR timezone = ''
    `);
    await queryInterface.sequelize.query(`
      UPDATE inspections
      SET captured_at_utc = captured_at,
          capture_timezone = COALESCE(capture_timezone, 'Asia/Kolkata'),
          capture_offset_minutes = COALESCE(capture_offset_minutes, 330),
          capture_time_source = COALESCE(capture_time_source, 'legacy_captured_at')
      WHERE captured_at IS NOT NULL AND captured_at_utc IS NULL
    `);
    await queryInterface.sequelize.query(`
      UPDATE inspection_media
      SET captured_at_utc = captured_at,
          capture_timezone = COALESCE(capture_timezone, 'Asia/Kolkata'),
          capture_offset_minutes = COALESCE(capture_offset_minutes, 330),
          capture_time_source = COALESCE(capture_time_source, 'legacy_captured_at')
      WHERE captured_at IS NOT NULL AND captured_at_utc IS NULL
    `);
    await queryInterface.sequelize.query(`
      UPDATE sensor_readings
      SET recorded_at_utc = timestamp,
          source_timezone = COALESCE(source_timezone, 'Asia/Kolkata'),
          source_offset_minutes = COALESCE(source_offset_minutes, 330)
      WHERE timestamp IS NOT NULL AND recorded_at_utc IS NULL
    `);

    await queryInterface.addIndex('tenants', ['timezone'], {
      name: 'tenants_timezone_idx',
    }).catch(() => null);
    await queryInterface.addIndex('inspection_media', ['captured_at_utc'], {
      name: 'inspection_media_captured_at_utc_idx',
    }).catch(() => null);
    await queryInterface.addIndex('sensor_readings', ['recorded_at_utc'], {
      name: 'sensor_readings_recorded_at_utc_idx',
    }).catch(() => null);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('tenants', 'tenants_timezone_idx').catch(() => null);
    await queryInterface.removeIndex('inspection_media', 'inspection_media_captured_at_utc_idx').catch(() => null);
    await queryInterface.removeIndex('sensor_readings', 'sensor_readings_recorded_at_utc_idx').catch(() => null);

    await removeColumnIfExists(queryInterface, 'sensor_readings', 'source_offset_minutes');
    await removeColumnIfExists(queryInterface, 'sensor_readings', 'source_timezone');
    await removeColumnIfExists(queryInterface, 'sensor_readings', 'recorded_at_utc');

    await removeColumnIfExists(queryInterface, 'inspection_media', 'capture_time_source');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'capture_offset_minutes');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'capture_timezone');
    await removeColumnIfExists(queryInterface, 'inspection_media', 'captured_at_utc');

    await removeColumnIfExists(queryInterface, 'inspections', 'capture_time_source');
    await removeColumnIfExists(queryInterface, 'inspections', 'capture_offset_minutes');
    await removeColumnIfExists(queryInterface, 'inspections', 'capture_timezone');
    await removeColumnIfExists(queryInterface, 'inspections', 'captured_at_utc');

    await removeColumnIfExists(queryInterface, 'toilet_units', 'timezone');
    await removeColumnIfExists(queryInterface, 'facilities', 'timezone');
    await removeColumnIfExists(queryInterface, 'tenants', 'timezone');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_dummy_timezone_migration"', {
      type: Sequelize.QueryTypes.RAW,
    }).catch(() => null);
  },
};
