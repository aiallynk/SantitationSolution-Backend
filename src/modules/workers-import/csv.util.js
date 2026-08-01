const quoteCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const splitCsvLine = (line = '') => {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (inQuotes) {
    throw new Error('Malformed CSV row: unclosed quote');
  }

  values.push(current);
  return values;
};

const parseCsvText = (input = '') => {
  const normalized = String(input || '').replace(/^\uFEFF/, '');
  const rows = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '""';
        index += 1;
      } else {
        inQuotes = !inQuotes;
        current += char;
      }
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') {
        index += 1;
      }
      if (current.trim().length > 0) {
        rows.push(splitCsvLine(current));
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    rows.push(splitCsvLine(current));
  }

  return rows;
};

const stringifyCsv = (rows = []) =>
  rows
    .map((row) => (Array.isArray(row) ? row : []).map((value) => quoteCsv(value)).join(','))
    .join('\n');

module.exports = {
  parseCsvText,
  stringifyCsv,
};
