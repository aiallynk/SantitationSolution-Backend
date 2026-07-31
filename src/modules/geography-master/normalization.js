'use strict';

const APPROVED_PLACE_CODES = new Set(['PPL', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLA5', 'PPLC']);
const EXCLUDED_PLACE_CODES = new Set(['PPLH', 'PPLQ', 'PPLW', 'PPLX']);
const SOURCE_PRIORITY = Object.freeze({ MANUAL_VERIFIED: 100, LGD: 90, GEOBOUNDARIES: 70, GEONAMES: 60, GOOGLE: 40 });

const normalizeName = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const finiteCoordinate = (value, min, max) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
};

const normalizeCoordinates = (latitude, longitude) => {
  const lat = finiteCoordinate(latitude, -90, 90);
  const lng = finiteCoordinate(longitude, -180, 180);
  if ((lat === null) !== (lng === null)) return { latitude: null, longitude: null, error: 'Latitude and longitude must both be valid' };
  return { latitude: lat, longitude: lng, error: null };
};

const classifyGeoNamesFeature = ({ featureClass, featureCode, populatedPlaceMode = 'all' }) => {
  const code = String(featureCode || '').toUpperCase();
  const klass = String(featureClass || '').toUpperCase();
  if (klass === 'A' && ['PCLI', 'PCL', 'PCLD', 'PCLS'].includes(code)) return { level: 'country', administrativeType: 'country' };
  if (klass === 'A' && code === 'ADM1') return { level: 'state', administrativeType: 'other' };
  if (klass === 'A' && code === 'ADM2') return { level: 'district', administrativeType: 'other' };
  if (klass !== 'P' || EXCLUDED_PLACE_CODES.has(code) || !APPROVED_PLACE_CODES.has(code)) return null;
  if (populatedPlaceMode === 'administrative_seats' && !code.startsWith('PPLA') && code !== 'PPLC') return null;
  return {
    level: 'city',
    administrativeType: code === 'PPLC' || code.startsWith('PPLA') ? 'municipality' : 'populated_place',
  };
};

const shouldPreferSource = (currentSource, nextSource) =>
  (SOURCE_PRIORITY[String(nextSource || '').toUpperCase()] || 0) >=
  (SOURCE_PRIORITY[String(currentSource || '').toUpperCase()] || 0);

module.exports = {
  APPROVED_PLACE_CODES,
  SOURCE_PRIORITY,
  normalizeName,
  normalizeCoordinates,
  classifyGeoNamesFeature,
  shouldPreferSource,
};
