const AppError = require('../errors/AppError');
const { ROLE_CODES, normalizeRoleCode } = require('./personaFamilies');

const LOCATION_FIELDS = [
  'countryName',
  'stateName',
  'districtName',
  'cityName',
];
const ALL_LOCATION_FIELDS = [...LOCATION_FIELDS, 'zoneName', 'wardName'];
const SCOPE_LEVELS = ['country', 'state', 'district', 'city'];
const ROLE_SCOPE_LEVEL = new Map([
  [ROLE_CODES.COUNTRY_ADMIN, 'country'],
  [ROLE_CODES.STATE_ADMIN, 'state'],
  [ROLE_CODES.DISTRICT_ADMIN, 'district'],
  [ROLE_CODES.CITY_ADMIN, 'city'],
]);

const normalizeLabel = (value) => String(value || '').trim();
const labelsMatch = (left, right) =>
  normalizeLabel(left).toLowerCase() === normalizeLabel(right).toLowerCase();

const getPersonaScopeLevel = (roleCodes = []) => {
  const levels = (Array.isArray(roleCodes) ? roleCodes : [])
    .map((roleCode) => ROLE_SCOPE_LEVEL.get(normalizeRoleCode(roleCode)))
    .filter(Boolean);
  return levels.sort(
    (left, right) => SCOPE_LEVELS.indexOf(left) - SCOPE_LEVELS.indexOf(right),
  )[0] || null;
};

const getRequiredLocationFields = (scopeLevel) => {
  const rank = SCOPE_LEVELS.indexOf(String(scopeLevel || '').toLowerCase());
  return rank < 0 ? [] : LOCATION_FIELDS.slice(0, rank + 1);
};

const normalizePersonaLocationNames = ({ roleCodes = [], locationNames = {} }) => {
  const targetScopeLevel = getPersonaScopeLevel(roleCodes);
  if (!targetScopeLevel) {
    return Object.fromEntries(
      ALL_LOCATION_FIELDS.map((field) => [field, normalizeLabel(locationNames[field]) || null]),
    );
  }
  const requiredFields = new Set(getRequiredLocationFields(targetScopeLevel));
  return Object.fromEntries(
    LOCATION_FIELDS.map((field) => [
      field,
      requiredFields.has(field) ? normalizeLabel(locationNames[field]) || null : null,
    ]),
  );
};

const collectPersonaLocationScopeErrors = ({
  actor = {},
  targetRoleCodes = [],
  locationNames = {},
  geographyLevel = null,
}) => {
  const targetScopeLevel = getPersonaScopeLevel(targetRoleCodes);
  if (!targetScopeLevel) return [];

  const errors = [];
  const requiredFields = getRequiredLocationFields(targetScopeLevel);
  for (const field of requiredFields) {
    if (!normalizeLabel(locationNames[field])) {
      errors.push(`${field} is required for ${targetScopeLevel} admin scope`);
    }
  }

  const normalizedGeographyLevel = String(geographyLevel || '').trim().toLowerCase();
  const allowedGeographyLevels = new Set([targetScopeLevel]);
  if (normalizedGeographyLevel && !allowedGeographyLevels.has(normalizedGeographyLevel)) {
    errors.push(
      `${targetScopeLevel} admin must be assigned to ${[...allowedGeographyLevels].join(' or ')} geography`,
    );
  }

  const actorScopeLevel = getPersonaScopeLevel(
    actor.roleCodes || actor.allRoleCodes || (actor.role ? [actor.role] : []),
  );
  if (!actorScopeLevel) return errors;

  const actorRank = SCOPE_LEVELS.indexOf(actorScopeLevel);
  const targetRank = SCOPE_LEVELS.indexOf(targetScopeLevel);
  if (targetRank < actorRank) {
    errors.push(`Cannot create ${targetScopeLevel} admin from ${actorScopeLevel} scope`);
    return errors;
  }

  for (const field of LOCATION_FIELDS.slice(0, actorRank + 1)) {
    const actorValue = normalizeLabel(actor[field]);
    if (!actorValue) continue;
    if (!labelsMatch(actorValue, locationNames[field])) {
      errors.push(`${field} must remain within the creator's ${actorScopeLevel} scope`);
    }
  }
  return errors;
};

const assertPersonaLocationScope = (input) => {
  const errors = collectPersonaLocationScopeErrors(input);
  if (errors.length > 0) {
    throw new AppError('Persona location scope validation failed', 403, {
      code: 'PERSONA_SCOPE_FORBIDDEN',
      details: { errors },
    });
  }
};

module.exports = {
  LOCATION_FIELDS,
  getPersonaScopeLevel,
  getRequiredLocationFields,
  normalizePersonaLocationNames,
  collectPersonaLocationScopeErrors,
  assertPersonaLocationScope,
};
