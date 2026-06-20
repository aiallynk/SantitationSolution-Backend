'use strict';

const normalizeTableName = (value) =>
  typeof value === 'string'
    ? value
    : value?.tableName || value?.table_name || String(value || '');

const tableExists = async (queryInterface, tableName) => {
  const tables = await queryInterface.showAllTables();
  return tables.map(normalizeTableName).includes(tableName);
};

const addIndexIfMissing = async (queryInterface, tableName, indexName, fields, options = {}) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (!indexes.some((idx) => idx.name === indexName)) {
    await queryInterface.addIndex(tableName, fields, { ...options, name: indexName });
  }
};

const removeIndexIfPresent = async (queryInterface, tableName, indexName) => {
  if (!(await tableExists(queryInterface, tableName))) return;
  const indexes = await queryInterface.showIndex(tableName);
  if (indexes.some((idx) => idx.name === indexName)) {
    await queryInterface.removeIndex(tableName, indexName);
  }
};

module.exports = {
  async up(queryInterface) {
    await addIndexIfMissing(
      queryInterface,
      'sensor_readings',
      'sensor_readings_timestamp_idx',
      ['timestamp']
    );
    await addIndexIfMissing(
      queryInterface,
      'sensor_readings',
      'sensor_readings_device_timestamp_analytics_idx',
      ['device_id', 'timestamp']
    );
    await addIndexIfMissing(
      queryInterface,
      'sensor_devices',
      'sensor_devices_tenant_toilet_status_idx',
      ['tenant_id', 'toilet_unit_id', 'status']
    );
    await addIndexIfMissing(
      queryInterface,
      'sensor_devices',
      'sensor_devices_tenant_last_seen_idx',
      ['tenant_id', 'last_seen_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'inspection_media',
      'inspection_media_inspection_captured_idx',
      ['inspection_id', 'captured_at']
    );
    await addIndexIfMissing(
      queryInterface,
      'alerts',
      'alerts_tenant_status_created_idx',
      ['tenant_id', 'status', 'created_at']
    );

    if (await tableExists(queryInterface, 'inspections')) {
      await queryInterface.sequelize.query(`
        CREATE INDEX IF NOT EXISTS inspections_sensor_snapshot_toilet_captured_idx
        ON inspections (tenant_id, toilet_unit_id, captured_at)
        WHERE sensor_snapshot IS NOT NULL;
      `);
    }
  },

  async down(queryInterface) {
    if (await tableExists(queryInterface, 'inspections')) {
      await queryInterface.sequelize.query('DROP INDEX IF EXISTS inspections_sensor_snapshot_toilet_captured_idx;');
    }
    await removeIndexIfPresent(queryInterface, 'alerts', 'alerts_tenant_status_created_idx');
    await removeIndexIfPresent(queryInterface, 'inspection_media', 'inspection_media_inspection_captured_idx');
    await removeIndexIfPresent(queryInterface, 'sensor_devices', 'sensor_devices_tenant_last_seen_idx');
    await removeIndexIfPresent(queryInterface, 'sensor_devices', 'sensor_devices_tenant_toilet_status_idx');
    await removeIndexIfPresent(queryInterface, 'sensor_readings', 'sensor_readings_device_timestamp_analytics_idx');
    await removeIndexIfPresent(queryInterface, 'sensor_readings', 'sensor_readings_timestamp_idx');
  },
};
