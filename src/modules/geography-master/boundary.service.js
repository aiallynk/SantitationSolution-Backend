'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const { sequelize, Geography, GlobalGeographySource, GlobalGeographyImportBatch } = require('../../models');
const { normalizeName } = require('./normalization');

const coordinatePairs = (coordinates, output = []) => {
  if (!Array.isArray(coordinates)) return output;
  if (coordinates.length >= 2 && Number.isFinite(Number(coordinates[0])) && Number.isFinite(Number(coordinates[1]))) {
    output.push([Number(coordinates[0]), Number(coordinates[1])]);
    return output;
  }
  coordinates.forEach((item) => coordinatePairs(item, output));
  return output;
};

const geometryMetrics = (geometry) => {
  if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) return null;
  const points = coordinatePairs(geometry.coordinates);
  if (points.length < 3) return null;
  const lngs = points.map(([lng]) => lng);
  const lats = points.map(([, lat]) => lat);
  const bounds = {
    north: Math.max(...lats),
    south: Math.min(...lats),
    east: Math.max(...lngs),
    west: Math.min(...lngs),
  };
  return {
    bounds,
    latitude: (bounds.north + bounds.south) / 2,
    longitude: (bounds.east + bounds.west) / 2,
  };
};

const simplifyRing = (ring, maxPoints) => {
  if (!Array.isArray(ring) || ring.length <= maxPoints) return ring;
  const step = Math.max(1, Math.ceil(ring.length / maxPoints));
  const simplified = ring.filter((_, index) => index % step === 0);
  if (simplified.length > 0 && JSON.stringify(simplified[0]) !== JSON.stringify(simplified.at(-1))) simplified.push(simplified[0]);
  return simplified;
};

const simplifyGeometry = (geometry, maxPointsPerRing = 300) => {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') {
    return { ...geometry, coordinates: geometry.coordinates.map((ring) => simplifyRing(ring, maxPointsPerRing)) };
  }
  if (geometry.type === 'MultiPolygon') {
    return {
      ...geometry,
      coordinates: geometry.coordinates.map((polygon) => polygon.map((ring) => simplifyRing(ring, maxPointsPerRing))),
    };
  }
  return null;
};

const importGeoBoundariesFeatureCollection = async ({
  featureCollection,
  metadata,
  countryIso3,
  level,
  batchId = null,
}) => {
  if (!featureCollection || featureCollection.type !== 'FeatureCollection') throw new Error('A GeoJSON FeatureCollection is required');
  const normalizedLevel = { ADM0: 'country', ADM1: 'state', ADM2: 'district', ADM3: 'district', ADM4: 'city' }[String(level).toUpperCase()];
  if (!normalizedLevel) throw new Error(`Unsupported boundary level: ${level}`);
  const summary = { total: featureCollection.features.length, updated: 0, ambiguous: 0, invalid: 0 };

  for (const feature of featureCollection.features) {
    const properties = feature.properties || {};
    const boundaryId = String(properties.shapeID || properties.boundaryID || properties.id || crypto.randomUUID());
    const boundaryName = properties.shapeName || properties.name || properties.NAME || null;
    const metrics = geometryMetrics(feature.geometry);
    if (!boundaryName || !metrics) {
      summary.invalid += 1;
      continue;
    }
    const candidates = await Geography.findAll({
      where: {
        tenant_id: null,
        level: normalizedLevel,
        is_active: true,
        country_iso3: String(countryIso3).toUpperCase(),
        normalized_name: normalizeName(boundaryName),
      },
      limit: 3,
    });
    if (candidates.length !== 1) {
      summary.ambiguous += 1;
      continue;
    }
    const geography = candidates[0];
    await sequelize.transaction(async (transaction) => {
      await geography.update({
        geojson: feature.geometry,
        simplified_geojson: simplifyGeometry(feature.geometry),
        geometry_type: feature.geometry.type,
        bounds: metrics.bounds,
        bounds_north: metrics.bounds.north,
        bounds_south: metrics.bounds.south,
        bounds_east: metrics.bounds.east,
        bounds_west: metrics.bounds.west,
        centroid_latitude: geography.centroid_latitude || metrics.latitude,
        centroid_longitude: geography.centroid_longitude || metrics.longitude,
        location_status: 'mapped',
        import_batch_id: batchId,
        updated_at: new Date(),
      }, { transaction });
      const existingSource = await GlobalGeographySource.findOne({
        where: { source: 'GEOBOUNDARIES', external_code: boundaryId },
        transaction,
      });
      await GlobalGeographySource.upsert({
        ...(existingSource ? { id: existingSource.id } : {}),
        global_geography_id: geography.id,
        source: 'GEOBOUNDARIES',
        external_code: boundaryId,
        source_name: boundaryName,
        source_level: String(level).toUpperCase(),
        source_payload: { properties, metadata },
        boundary_id: boundaryId,
        source_licence: metadata?.boundaryLicense || metadata?.license || null,
        source_attribution: metadata?.boundarySource || metadata?.attribution || 'geoBoundaries',
        source_reference: metadata?.boundarySourceURL || metadata?.sourceReference || null,
        source_modified_at: metadata?.sourceDataUpdateDate || metadata?.buildDate || null,
        is_preferred: false,
        updated_at: new Date(),
      }, { transaction });
    });
    summary.updated += 1;
  }
  if (batchId) {
    await GlobalGeographyImportBatch.update({
      updated_records: summary.updated,
      ambiguous_records: summary.ambiguous,
      failed_records: summary.invalid,
      updated_at: new Date(),
    }, { where: { id: batchId } });
  }
  return summary;
};

module.exports = { coordinatePairs, geometryMetrics, simplifyGeometry, importGeoBoundariesFeatureCollection };
