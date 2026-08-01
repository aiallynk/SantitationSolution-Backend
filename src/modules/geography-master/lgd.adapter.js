'use strict';

const { streamDelimitedRows } = require('./delimited-stream');

const first = (row, names) => {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && String(value).trim()) return String(value).trim();
  }
  return null;
};

const namespacedCode = (entity, code) => `${entity}:${String(code || '').trim()}`;

const normalizeDelimiter = (delimiter) => {
  if (delimiter === '\\t' || String(delimiter).toLowerCase() === 'tab') return '\t';
  return delimiter || ',';
};

async function* streamLgdRecords(stream, { entity, delimiter = ',', sourceModifiedAt = null } = {}) {
  const normalizedEntity = String(entity || '').toLowerCase();
  const level = normalizedEntity === 'state'
    ? 'state'
    : normalizedEntity === 'district'
      ? 'district'
      : normalizedEntity === 'urban_local_body'
        ? 'city'
        : null;
  if (!level) throw new Error(`Unsupported LGD entity: ${entity}`);

  for await (const row of streamDelimitedRows(stream, { delimiter: normalizeDelimiter(delimiter) })) {
    const rawExternalCode = level === 'state'
      ? first(row, ['stateCode', 'State Code', 'State LGD Code', 'LGD State Code', 'LGD Code', 'lgdCode'])
      : level === 'district'
        ? first(row, ['districtCode', 'District Code', 'District LGD Code', 'LGD District Code', 'LGD Code', 'lgdCode'])
        : first(row, ['localBodyCode', 'Local Body Code', 'Urban Local Body Code', 'LGD Code', 'lgdCode']);
    const externalCode = level === 'state'
      ? namespacedCode('state', rawExternalCode)
      : level === 'district'
        ? namespacedCode('district', rawExternalCode)
        : namespacedCode('urban_local_body', rawExternalCode);
    const name = level === 'state'
      ? first(row, ['stateNameEnglish', 'State Name(In English)', 'State Name (In English)', 'State Name', 'name'])
      : level === 'district'
        ? first(row, ['districtNameEnglish', 'District Name(In English)', 'District Name (In English)', 'District Name', 'name'])
        : first(row, ['localBodyNameEnglish', 'Local Body Name(In English)', 'Local Body Name (In English)', 'name']);
    if (!rawExternalCode || !name) continue;
    const rawParentExternalCode = level === 'district'
      ? first(row, ['stateCode', 'State Code', 'State LGD Code', 'LGD State Code', 'parentCode'])
      : level === 'city'
        ? first(row, ['districtCode', 'District Code', 'District LGD Code', 'stateCode', 'State Code', 'parentCode'])
        : null;
    const parentExternalCode = level === 'district'
      ? namespacedCode('state', rawParentExternalCode)
      : level === 'city' && rawParentExternalCode
        ? namespacedCode('district', rawParentExternalCode)
        : null;
    const activeText = first(row, ['isActive', 'Is Active', 'active', 'Status']);
    yield {
      source: 'LGD',
      externalCode,
      parentExternalCode,
      name,
      normalizedLevel: level,
      rawLevel: normalizedEntity,
      administrativeType: level === 'city' ? 'municipality' : level,
      countryIso2: 'IN',
      countryIso3: 'IND',
      rawPayload: {
        entityType: normalizedEntity,
        lgdCode: rawExternalCode,
        parentLgdCode: rawParentExternalCode || null,
        census2001Code: first(row, ['Census 2001 Code', 'Census2001 Code']),
        census2011Code: first(row, ['Census2011 Code', 'Census 2011 Code']),
        localName: first(row, ['State Name (In Local language)', 'District Name (In Local language)', 'Local Body Name (In Local language)']),
        stateOrUt: first(row, ['State or UT']),
        isActive: activeText ? !['false', 'inactive', 'n', '0'].includes(activeText.toLowerCase()) : true,
        sourceModifiedAt,
        row,
      },
    };
  }
}

module.exports = { normalizeDelimiter, streamLgdRecords };
