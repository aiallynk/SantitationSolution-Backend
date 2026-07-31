const test = require('node:test');
const assert = require('node:assert/strict');

const platformService = require('../src/modules/platform/platform.service');

const {
  assertGeographyGeometryInsideParent,
} = platformService.__private;

test('zone polygon outside parent polygon is rejected', () => {
  assert.throws(() => {
    assertGeographyGeometryInsideParent({
      level: 'zone',
      parent: {
        geometry_type: 'polygon',
        geojson: {
          type: 'Polygon',
          coordinates: [[
            [72.7, 21.0],
            [73.0, 21.0],
            [73.0, 21.3],
            [72.7, 21.3],
            [72.7, 21.0],
          ]],
        },
      },
      geometryPayload: {
        geometryType: 'polygon',
        geojson: {
          type: 'Polygon',
          coordinates: [[
            [72.8, 21.1],
            [73.05, 21.1],
            [72.9, 21.25],
            [72.8, 21.1],
          ]],
        },
      },
    });
  }, (error) => error?.code === 'GEOGRAPHY_OUTSIDE_PARENT_BOUNDARY');
});

test('ward circle that exceeds parent circle is rejected', () => {
  assert.throws(() => {
    assertGeographyGeometryInsideParent({
      level: 'ward',
      parent: {
        geometry_type: 'circle',
        boundary_center_latitude: 21.17,
        boundary_center_longitude: 72.83,
        boundary_radius_meters: 500,
      },
      geometryPayload: {
        geometryType: 'circle',
        boundaryCenterLatitude: 21.17,
        boundaryCenterLongitude: 72.83,
        boundaryRadiusMeters: 550,
      },
    });
  }, (error) => error?.code === 'GEOGRAPHY_OUTSIDE_PARENT_BOUNDARY');
});

test('circle inside parent polygon is allowed', () => {
  assert.doesNotThrow(() => {
    assertGeographyGeometryInsideParent({
      level: 'ward',
      parent: {
        geometry_type: 'polygon',
        geojson: {
          type: 'Polygon',
          coordinates: [[
            [72.8, 21.1],
            [72.9, 21.1],
            [72.9, 21.2],
            [72.8, 21.2],
            [72.8, 21.1],
          ]],
        },
      },
      geometryPayload: {
        geometryType: 'circle',
        boundaryCenterLatitude: 21.15,
        boundaryCenterLongitude: 72.85,
        boundaryRadiusMeters: 120,
      },
    });
  });
});
