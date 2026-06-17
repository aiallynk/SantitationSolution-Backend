// AI provider pricing configuration.
// UPDATE these values whenever provider pricing changes.
// Source: https://openai.com/pricing (last verified: 2025-06)
//
// Cost formula:
//   inputCostUsd  = (inputTokens  / 1_000_000) * inputPerMillionUsd
//   outputCostUsd = (outputTokens / 1_000_000) * outputPerMillionUsd
//   totalCostUsd  = inputCostUsd + outputCostUsd

const AI_PRICING_CONFIG = {
  openai: {
    'gpt-4o-mini': {
      inputPerMillionUsd: 0.15,
      outputPerMillionUsd: 0.60,
    },
    'gpt-4o': {
      inputPerMillionUsd: 5.00,
      outputPerMillionUsd: 15.00,
    },
    'gpt-4.1-mini': {
      inputPerMillionUsd: 0.40,
      outputPerMillionUsd: 1.60,
    },
    'gpt-4.1': {
      inputPerMillionUsd: 2.00,
      outputPerMillionUsd: 8.00,
    },
    'gpt-4-turbo': {
      inputPerMillionUsd: 10.00,
      outputPerMillionUsd: 30.00,
    },
    default: {
      inputPerMillionUsd: 0.15,
      outputPerMillionUsd: 0.60,
    },
  },
};

const resolveUsdToInrRate = () => {
  const fromEnv = parseFloat(process.env.USD_TO_INR_RATE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return 84.0;
};

const getModelPricing = (provider, modelName) => {
  const providerConfig = AI_PRICING_CONFIG[String(provider || 'openai').toLowerCase()];
  if (!providerConfig) return AI_PRICING_CONFIG.openai.default;
  return providerConfig[String(modelName || '').toLowerCase()] || providerConfig.default || AI_PRICING_CONFIG.openai.default;
};

const calculateCostUsd = ({ provider, modelName, inputTokens, outputTokens }) => {
  const pricing = getModelPricing(provider, modelName);
  const input = (Number(inputTokens) || 0) / 1_000_000 * pricing.inputPerMillionUsd;
  const output = (Number(outputTokens) || 0) / 1_000_000 * pricing.outputPerMillionUsd;
  return Math.round((input + output) * 1e8) / 1e8;
};

const calculateCostInr = ({ costUsd, usdToInrRate }) => {
  const rate = Number(usdToInrRate) || resolveUsdToInrRate();
  return Math.round(Number(costUsd || 0) * rate * 1e4) / 1e4;
};

module.exports = {
  AI_PRICING_CONFIG,
  getModelPricing,
  calculateCostUsd,
  calculateCostInr,
  resolveUsdToInrRate,
};
