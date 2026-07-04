#!/usr/bin/env node

const sequelize = require('../src/config/database');
const publicToiletService = require('../src/modules/publicApi/publicToilet.service');

const args = process.argv.slice(2);

const getArg = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1] || fallback;
  return fallback;
};

const main = async () => {
  const lat = getArg('lat');
  const lng = getArg('lng');
  if (!lat || !lng) {
    throw new Error('Usage: node scripts/diagnose-public-nearby-toilets.js --lat=20.0389977 --lng=73.8048501 [--radius=10000] [--api-key-id=...] [--key-prefix=...]');
  }

  const result = await publicToiletService.getDebugNearbyToilets({
    lat,
    lng,
    radius: getArg('radius', 10000),
    apiKeyId: getArg('api-key-id'),
    keyPrefix: getArg('key-prefix'),
    cleanlinessMin: getArg('cleanliness-min', 0),
    includeClosed: getArg('include-closed', false),
  });

  console.log(JSON.stringify(result, null, 2));
};

main()
  .catch((error) => {
    console.error(error.message);
    if (error.errors) console.error(JSON.stringify(error.errors, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close().catch(() => {});
  });
