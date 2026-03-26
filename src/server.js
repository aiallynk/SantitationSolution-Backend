const app = require('./app');
const sequelize = require('./config/database');

require('./modules/users/user.model');
require('./modules/inspections/inspection.model');
require('./modules/alerts/alert.model');

const PORT = process.env.PORT || 5000;
const { seedDemoData } = require('./utils/seed');

sequelize.sync({ alter: true })
  .then(async () => {
    console.log('Database tables synchronized');

    const shouldSeed = String(process.env.SEED_DEMO_DATA || 'true').toLowerCase() !== 'false';
    if (shouldSeed) {
      await seedDemoData();
    }

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Database synchronization failed:', err);
  });
