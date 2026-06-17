const { AiUsageLog } = require('../../models');
const { calculateCostUsd, calculateCostInr, resolveUsdToInrRate } = require('../../config/aiPricing');

const isTrackingEnabled = () => {
  const val = String(process.env.AI_USAGE_TRACKING_ENABLED || 'true').trim().toLowerCase();
  return val !== 'false' && val !== '0';
};

const safeStr = (value, max = 120) =>
  value !== null && value !== undefined ? String(value).slice(0, max) : null;

const logUsage = async ({
  tenantId = null,
  userId = null,
  workerId = null,
  inspectionId = null,
  toiletId = null,
  userRole = null,
  featureKey,
  featureName,
  provider = 'openai',
  modelName,
  inputTokens = 0,
  outputTokens = 0,
  totalTokens = null,
  imageCount = 0,
  videoFrameCount = 0,
  status = 'success',
  latencyMs = null,
  errorMessage = null,
  providerRequestId = null,
  isEstimated = false,
  metadata = null,
} = {}) => {
  if (!isTrackingEnabled()) return null;

  try {
    const usdToInrRate = resolveUsdToInrRate();
    const resolvedTotal = totalTokens !== null ? Number(totalTokens) : (Number(inputTokens) + Number(outputTokens));
    const costUsd = calculateCostUsd({ provider, modelName, inputTokens, outputTokens });
    const costInr = calculateCostInr({ costUsd, usdToInrRate });

    const record = await AiUsageLog.create({
      tenant_id: tenantId || null,
      user_id: userId || null,
      worker_id: workerId || null,
      inspection_id: inspectionId || null,
      toilet_id: toiletId || null,
      user_role: safeStr(userRole, 80),
      feature_key: safeStr(featureKey, 120),
      feature_name: safeStr(featureName, 200),
      ai_provider: safeStr(provider, 60) || 'openai',
      model_name: safeStr(modelName, 120),
      input_tokens: Math.max(Number(inputTokens) || 0, 0),
      output_tokens: Math.max(Number(outputTokens) || 0, 0),
      total_tokens: Math.max(resolvedTotal, 0),
      image_count: Math.max(Number(imageCount) || 0, 0),
      video_frame_count: Math.max(Number(videoFrameCount) || 0, 0),
      cost_usd: costUsd,
      cost_inr: costInr,
      usd_to_inr_rate: usdToInrRate,
      is_estimated: Boolean(isEstimated),
      status: ['success', 'failed', 'partial'].includes(status) ? status : 'success',
      latency_ms: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
      error_message: errorMessage ? String(errorMessage).slice(0, 2000) : null,
      provider_request_id: safeStr(providerRequestId, 200),
      metadata: metadata && typeof metadata === 'object' ? metadata : null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    return record;
  } catch (err) {
    // Never let usage logging break the main flow
    console.error('[AiUsageLogger] Failed to log usage:', err.message);
    return null;
  }
};

module.exports = { logUsage };
