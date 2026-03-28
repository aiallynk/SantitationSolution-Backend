/* eslint-disable no-console */
require('../src/config/env');

const API_BASE_URL = (process.env.SIM_API_BASE_URL || 'http://localhost:5000/api/v1').replace(/\/+$/, '');
const IDENTIFIER = process.env.SIM_USERNAME || 'superadmin@platform.gov';
const PASSWORD = process.env.SIM_PASSWORD || 'Password@123';
const INTERVAL_MS = Number(process.env.SIM_INTERVAL_MS || 5000);
const DEVICE_LIMIT = Number(process.env.SIM_DEVICE_LIMIT || 10);

let accessToken = null;

const randomBetween = (min, max) => Number((min + Math.random() * (max - min)).toFixed(2));

const api = async (path, { method = 'GET', body, token } = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payloadText = await response.text();
  let payload = null;
  try {
    payload = payloadText ? JSON.parse(payloadText) : null;
  } catch (error) {
    payload = { message: payloadText };
  }

  if (!response.ok) {
    const message = payload?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }

  return payload;
};

const login = async () => {
  const result = await api('/auth/login', {
    method: 'POST',
    body: { identifier: IDENTIFIER, password: PASSWORD },
  });
  accessToken = result?.data?.accessToken;
  if (!accessToken) {
    throw new Error('No accessToken returned from login');
  }
  console.log(`Simulator authenticated as ${IDENTIFIER}`);
};

const listDevices = async () => {
  const result = await api(`/sensors?limit=${DEVICE_LIMIT}`, { token: accessToken });
  const items = result?.data || [];
  return Array.isArray(items) ? items : [];
};

const createReadingPayload = (device) => {
  const spike = Math.random() > 0.9;
  const odorBase = spike ? randomBetween(72, 92) : randomBetween(15, 55);
  const ammoniaBase = spike ? randomBetween(38, 70) : randomBetween(5, 28);
  const h2sBase = spike ? randomBetween(11, 20) : randomBetween(1, 8);

  return {
    deviceId: device.id || device.deviceId,
    timestamp: new Date().toISOString(),
    odorPpm: odorBase,
    ammoniaPpm: ammoniaBase,
    h2sPpm: h2sBase,
    methanePpm: randomBetween(20, spike ? 98 : 65),
    humidity: randomBetween(42, 88),
    temperature: randomBetween(18, 37),
    occupancyCount: Math.round(randomBetween(0, 8)),
    footfallCount: Math.round(randomBetween(1, 40)),
    tankFillLevel: randomBetween(15, 95),
    batteryLevel: randomBetween(15, 100),
    signalStrength: randomBetween(40, 99),
    rawPayload: {
      simulated: true,
      profile: spike ? 'spike' : 'normal',
      generatedAt: new Date().toISOString(),
    },
  };
};

const runTick = async () => {
  const devices = await listDevices();
  if (devices.length === 0) {
    console.log('No sensor devices found. Seed devices first, then rerun simulator.');
    return;
  }

  await Promise.all(
    devices.map(async (device) => {
      try {
        const payload = createReadingPayload(device);
        await api('/sensor-ingestion/readings', {
          method: 'POST',
          token: accessToken,
          body: payload,
        });
      } catch (error) {
        console.error(`Failed to ingest reading for ${device.deviceId || device.id}: ${error.message}`);
      }
    })
  );

  console.log(`Ingested readings for ${devices.length} devices at ${new Date().toISOString()}`);
};

const main = async () => {
  await login();
  await runTick();
  setInterval(() => {
    runTick().catch((error) => {
      console.error(`Simulator tick failed: ${error.message}`);
    });
  }, INTERVAL_MS);
};

main().catch((error) => {
  console.error(`Sensor simulator failed: ${error.message}`);
  process.exit(1);
});
