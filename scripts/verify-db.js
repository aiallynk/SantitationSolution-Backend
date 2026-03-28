require('../src/config/env');
const { sequelize } = require('../src/models');

(async () => {
  try {
    await sequelize.authenticate();
    console.log('[DB VERIFY] Supabase PostgreSQL connection OK');

    const rows = await sequelize.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public';",
      { type: sequelize.QueryTypes.SELECT }
    );

    console.log('[DB VERIFY] public schema relations:');
    for (const row of rows) {
      const tableName = Array.isArray(row) ? row[0] : row.table_name;
      console.log(` - ${tableName}`);
    }

    const [summaryRows] = await sequelize.query(`
      SELECT
        (SELECT COUNT(*)::int FROM platform_users) AS users_count,
        (SELECT COUNT(*)::int FROM tenants) AS tenants_count,
        (SELECT COUNT(*)::int FROM facilities) AS facilities_count,
        (SELECT COUNT(*)::int FROM inspection_tasks) AS tasks_count
    `);

    const summary = summaryRows[0];
    console.log('[DB VERIFY] seed counts:');
    console.log(` - platform_users: ${summary.users_count}`);
    console.log(` - tenants: ${summary.tenants_count}`);
    console.log(` - facilities: ${summary.facilities_count}`);
    console.log(` - inspection_tasks: ${summary.tasks_count}`);
  } catch (error) {
    console.error('[DB VERIFY] failed:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
