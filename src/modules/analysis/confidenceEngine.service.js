const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const REVIEW_THRESHOLD = Number(process.env.ANALYSIS_REVIEW_CONFIDENCE_THRESHOLD || 0.6);
const REJECT_THRESHOLD = Number(process.env.ANALYSIS_REJECT_CONFIDENCE_THRESHOLD || 0.4);

const computeConfidence = ({
  aiConfidence = null,
  blurPenalty = 0,
  lightingPenalty = 0,
  visibilityScore = null,
}) => {
  const base =
    Number.isFinite(Number(aiConfidence)) ? Number(aiConfidence) : 0.65;
  const visibility =
    Number.isFinite(Number(visibilityScore)) ? Number(visibilityScore) : 0.75;
  const visibilityPenalty = clamp((0.75 - visibility) * 0.8, 0, 0.35);

  const finalConfidence = clamp(
    base - Number(blurPenalty || 0) - Number(lightingPenalty || 0) - visibilityPenalty,
    0,
    1
  );

  return {
    baseConfidence: Number(base.toFixed(4)),
    blurPenalty: Number(Number(blurPenalty || 0).toFixed(4)),
    lightingPenalty: Number(Number(lightingPenalty || 0).toFixed(4)),
    visibilityPenalty: Number(visibilityPenalty.toFixed(4)),
    finalConfidence: Number(finalConfidence.toFixed(4)),
    reviewRequired: finalConfidence < REVIEW_THRESHOLD,
    rejected: finalConfidence < REJECT_THRESHOLD,
    reviewThreshold: REVIEW_THRESHOLD,
    rejectThreshold: REJECT_THRESHOLD,
  };
};

module.exports = {
  computeConfidence,
  REVIEW_THRESHOLD,
  REJECT_THRESHOLD,
};
