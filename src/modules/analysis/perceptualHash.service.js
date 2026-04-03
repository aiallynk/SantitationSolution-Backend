const sharp = require('sharp');
const { resolveMediaBuffer } = require('./analysisMediaResolver.service');

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const generateDHashFromPixels = (pixels = []) => {
  if (!Array.isArray(pixels) || pixels.length < HASH_WIDTH * HASH_HEIGHT) {
    return null;
  }

  const bits = [];
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      const left = pixels[y * HASH_WIDTH + x];
      const right = pixels[y * HASH_WIDTH + x + 1];
      bits.push(left > right ? 1 : 0);
    }
  }

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    const nibble =
      (bits[i] << 3) |
      (bits[i + 1] << 2) |
      (bits[i + 2] << 1) |
      bits[i + 3];
    hex += nibble.toString(16);
  }
  return hex;
};

const computePerceptualHash = async (mediaRow) => {
  const source = await resolveMediaBuffer(mediaRow);
  if (!source || !source.buffer) {
    return null;
  }

  const { data } = await sharp(source.buffer, { failOn: 'none' })
    .rotate()
    .resize(HASH_WIDTH, HASH_HEIGHT, {
      fit: 'fill',
      withoutEnlargement: false,
    })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return generateDHashFromPixels(Array.from(data || []));
};

const hammingDistance = (leftHash, rightHash) => {
  const left = String(leftHash || '').trim().toLowerCase();
  const right = String(rightHash || '').trim().toLowerCase();
  if (!left || !right || left.length !== right.length) return null;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    const leftNibble = parseInt(left[i], 16);
    const rightNibble = parseInt(right[i], 16);
    if (Number.isNaN(leftNibble) || Number.isNaN(rightNibble)) {
      return null;
    }
    const xor = leftNibble ^ rightNibble;
    diff += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return diff;
};

const perceptualSimilarity = (leftHash, rightHash) => {
  const distance = hammingDistance(leftHash, rightHash);
  if (distance === null) return null;
  const hashBits = String(leftHash || '').length * 4;
  if (hashBits <= 0) return null;
  return clamp(1 - distance / hashBits, 0, 1);
};

module.exports = {
  computePerceptualHash,
  perceptualSimilarity,
};
