const sharp = require('sharp');
const { resolveMediaBuffer } = require('./analysisMediaResolver.service');

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const BLUR_VARIANCE_MIN = Number(process.env.ANALYSIS_BLUR_VARIANCE_MIN || 120);
const BRIGHTNESS_MIN = Number(process.env.ANALYSIS_BRIGHTNESS_MIN || 35);
const BRIGHTNESS_MAX = Number(process.env.ANALYSIS_BRIGHTNESS_MAX || 220);
const MAX_DIMENSION = Number(process.env.ANALYSIS_VALIDATION_MAX_DIMENSION || 768);

const variance = (values = []) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sq = values.map((value) => (value - avg) ** 2);
  return sq.reduce((sum, value) => sum + value, 0) / sq.length;
};

const computeLaplacianVariance = ({ pixels, width, height }) => {
  if (!pixels || !width || !height || width < 3 || height < 3) return 0;
  const laplacianResponses = [];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const idx = y * width + x;
      const center = pixels[idx];
      const top = pixels[idx - width];
      const bottom = pixels[idx + width];
      const left = pixels[idx - 1];
      const right = pixels[idx + 1];
      const response = 4 * center - top - bottom - left - right;
      laplacianResponses.push(response);
    }
  }

  return variance(laplacianResponses);
};

const normalizeBrightnessPenalty = (brightness) => {
  if (!Number.isFinite(brightness)) return 0.15;
  if (brightness < BRIGHTNESS_MIN) {
    return clamp((BRIGHTNESS_MIN - brightness) / BRIGHTNESS_MIN, 0, 0.35);
  }
  if (brightness > BRIGHTNESS_MAX) {
    return clamp((brightness - BRIGHTNESS_MAX) / (255 - BRIGHTNESS_MAX || 1), 0, 0.35);
  }
  return 0;
};

const normalizeBlurPenalty = (laplacianVariance) => {
  if (!Number.isFinite(laplacianVariance) || laplacianVariance <= 0) return 0.25;
  if (laplacianVariance >= BLUR_VARIANCE_MIN) return 0;
  return clamp((BLUR_VARIANCE_MIN - laplacianVariance) / BLUR_VARIANCE_MIN, 0, 0.4);
};

const validateInspectionMediaQuality = async (mediaRow) => {
  const source = await resolveMediaBuffer(mediaRow);
  if (!source || !source.buffer) {
    return {
      validationStatus: 'FAILED_SOURCE',
      imageQualityStatus: 'missing_image',
      imageQualityScore: 0,
      laplacianVariance: 0,
      brightnessMean: 0,
      blurPenalty: 0.3,
      lightingPenalty: 0.3,
      validationReason: 'Image source is unavailable',
      localPath: null,
    };
  }

  const resized = sharp(source.buffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: MAX_DIMENSION,
      height: MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .grayscale();

  const { data, info } = await resized
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = Array.from(data || []);
  const width = Number(info?.width || 0);
  const height = Number(info?.height || 0);

  if (!width || !height || pixels.length === 0) {
    return {
      validationStatus: 'FAILED_SOURCE',
      imageQualityStatus: 'missing_image',
      imageQualityScore: 0,
      laplacianVariance: 0,
      brightnessMean: 0,
      blurPenalty: 0.3,
      lightingPenalty: 0.3,
      validationReason: 'Unable to decode image bytes',
      localPath: source.localPath || null,
    };
  }

  const brightnessMean = pixels.reduce((sum, pixel) => sum + pixel, 0) / pixels.length;
  const laplacianVariance = computeLaplacianVariance({ pixels, width, height });
  const blurPenalty = normalizeBlurPenalty(laplacianVariance);
  const lightingPenalty = normalizeBrightnessPenalty(brightnessMean);

  let validationStatus = 'VALID';
  let imageQualityStatus = 'ok';
  let validationReason = null;

  if (laplacianVariance < BLUR_VARIANCE_MIN) {
    validationStatus = 'FAILED_BLUR';
    imageQualityStatus = 'blurry';
    validationReason = `Image appears blurry (laplacian variance ${laplacianVariance.toFixed(2)})`;
  } else if (brightnessMean < BRIGHTNESS_MIN || brightnessMean > BRIGHTNESS_MAX) {
    validationStatus = 'FAILED_BRIGHTNESS';
    imageQualityStatus = 'lighting_invalid';
    validationReason = `Image brightness ${brightnessMean.toFixed(2)} is outside allowed range`;
  }

  const qualityScore = Math.round(
    clamp(
      100 - blurPenalty * 100 - lightingPenalty * 100,
      0,
      100
    )
  );

  return {
    validationStatus,
    imageQualityStatus,
    imageQualityScore: Number((qualityScore / 100).toFixed(4)),
    laplacianVariance: Number(laplacianVariance.toFixed(4)),
    brightnessMean: Number(brightnessMean.toFixed(4)),
    blurPenalty: Number(blurPenalty.toFixed(4)),
    lightingPenalty: Number(lightingPenalty.toFixed(4)),
    validationReason,
    localPath: source.localPath || null,
  };
};

module.exports = {
  validateInspectionMediaQuality,
  BLUR_VARIANCE_MIN,
  BRIGHTNESS_MIN,
  BRIGHTNESS_MAX,
};
