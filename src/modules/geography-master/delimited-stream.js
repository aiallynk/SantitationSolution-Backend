'use strict';

const readline = require('readline');

const parseDelimitedLine = (line, delimiter = ',') => {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
};

async function* streamDelimitedRows(stream, { delimiter = ',', headers = null, skipComments = true } = {}) {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let fieldNames = headers;
  for await (const rawLine of lines) {
    if (!rawLine || (skipComments && rawLine.startsWith('#'))) continue;
    const values = parseDelimitedLine(rawLine, delimiter);
    if (!fieldNames) {
      fieldNames = values.map((value) => value.trim());
      continue;
    }
    yield Object.fromEntries(fieldNames.map((name, index) => [name, String(values[index] ?? '').trim()]));
  }
}

module.exports = { parseDelimitedLine, streamDelimitedRows };
