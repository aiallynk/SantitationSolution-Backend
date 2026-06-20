const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const toDosDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { dosDate, dosTime };
};

const writeUInt32 = (buffer, value, offset) => {
  buffer.writeUInt32LE(Number(value) >>> 0, offset);
};

const ensureZipSize = (value, label) => {
  if (value > 0xffffffff) {
    throw new Error(`${label} exceeds ZIP32 size limit`);
  }
};

const normalizeEntryName = (name) =>
  String(name || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.(\/|$)/g, '')
    .trim();

const makeBuffer = (content) => {
  if (Buffer.isBuffer(content)) return content;
  if (content === undefined || content === null) return Buffer.alloc(0);
  return Buffer.from(String(content));
};

const createZipBuffer = (entries = []) => {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry.path || entry.name);
    if (!name) continue;

    const original = makeBuffer(entry.content);
    const compressedCandidate = zlib.deflateRawSync(original, { level: 6 });
    const useDeflate = compressedCandidate.length < original.length;
    const body = useDeflate ? compressedCandidate : original;
    const method = useDeflate ? 8 : 0;
    const nameBuffer = Buffer.from(name, 'utf8');
    const checksum = crc32(original);
    const { dosDate, dosTime } = toDosDateTime(entry.date);

    ensureZipSize(offset, 'ZIP offset');
    ensureZipSize(body.length, `${name} compressed size`);
    ensureZipSize(original.length, `${name} uncompressed size`);

    const localHeader = Buffer.alloc(30);
    writeUInt32(localHeader, 0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    writeUInt32(localHeader, checksum, 14);
    writeUInt32(localHeader, body.length, 18);
    writeUInt32(localHeader, original.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, body);

    const centralHeader = Buffer.alloc(46);
    writeUInt32(centralHeader, 0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    writeUInt32(centralHeader, checksum, 16);
    writeUInt32(centralHeader, body.length, 20);
    writeUInt32(centralHeader, original.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    writeUInt32(centralHeader, 0, 38);
    writeUInt32(centralHeader, offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralOffset = offset;
  const centralSize = centralDirectory.length;
  ensureZipSize(centralOffset, 'central directory offset');
  ensureZipSize(centralSize, 'central directory size');

  const eocd = Buffer.alloc(22);
  writeUInt32(eocd, 0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralParts.length / 2, 8);
  eocd.writeUInt16LE(centralParts.length / 2, 10);
  writeUInt32(eocd, centralSize, 12);
  writeUInt32(eocd, centralOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
};

module.exports = {
  createZipBuffer,
  crc32,
};
