const test = require('node:test');
const assert = require('node:assert/strict');

const platformService = require('../src/modules/platform/platform.service');

test('deriveGeometryPayload generates polygon endpoints for circle geographies', () => {
  const payload = platformService.__private.deriveGeometryPayload({
    geometryType: 'circle',
    boundaryCenterLatitude: 21.1702,
    boundaryCenterLongitude: 72.8311,
    boundaryRadiusMeters: 500,
  });

  assert.equal(payload.geometryType, 'circle');
  assert.equal(payload.boundaryCenterLatitude, 21.1702);
  assert.equal(payload.boundaryCenterLongitude, 72.8311);
  assert.equal(payload.boundaryRadiusMeters, 500);
  assert.equal(payload.geojson?.type, 'Polygon');
  assert.equal(Array.isArray(payload.geojson?.coordinates?.[0]), true);
  assert.equal(payload.geojson.coordinates[0].length > 12, true);

  const firstPoint = payload.geojson.coordinates[0][0];
  const lastPoint = payload.geojson.coordinates[0][payload.geojson.coordinates[0].length - 1];
  assert.deepEqual(lastPoint, firstPoint);

  assert.equal(payload.bounds.north > payload.bounds.south, true);
  assert.equal(payload.bounds.east > payload.bounds.west, true);
});
