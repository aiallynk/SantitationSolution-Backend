const { sequelize, ToiletUnit } = require('../src/models');
const { ensureQrImagesForToilets } = require('../src/modules/platform/toiletQr.service');

const run = async () => {
  try {
    await sequelize.authenticate();
    const units = await ToiletUnit.findAll({
      attributes: ['id', 'code', 'qr_code'],
    });
    const result = await ensureQrImagesForToilets(units, {
      forceRegenerate:
        String(process.env.QR_FORCE_REGENERATE || 'false').toLowerCase() === 'true',
    });
    // eslint-disable-next-line no-console
    console.log(
      `QR backfill done: total=${result.total} generated=${result.generated} skipped=${result.skipped} failed=${result.failed}`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('QR backfill failed:', error.message);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
};

run();
