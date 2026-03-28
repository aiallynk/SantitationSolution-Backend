const fs = require('fs');
const path = require('path');

require('../src/config/env');
const { sequelize } = require('../src/models');

const migrationsDir = path.resolve(__dirname, '../database/sql-migrations');

(async () => {
  try {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No SQL migration files found.');
      return;
    }

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      await sequelize.query(sql);
      console.log(`Applied SQL file: ${file}`);
    }

    console.log('All SQL migration files applied successfully.');
  } catch (error) {
    console.error('Failed to apply SQL migrations:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
})();
