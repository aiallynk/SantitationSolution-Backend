const fs = require('fs');
const path = require('path');
const { getObjectDataUrlFromS3 } = require('../media/s3.service');

const ANALYSIS_STATUSES = new Set(['clean', 'moderate', 'poor', 'critical']);
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const deriveStatus = (score) => {
  if (score >= 80) return 'clean';
  if (score >= 60) return 'moderate';
  if (score >= 40) return 'poor';
  return 'critical';
};

const buildComposite = ({ cleanlinessScore, hygieneScore, wetnessScore, stainScore, litterScore, odorRiskScore }) => {
  const composite = Math.round(
    cleanlinessScore * 0.35 +
      hygieneScore * 0.2 +
      wetnessScore * 0.15 +
      stainScore * 0.1 +
      litterScore * 0.1 +
      (100 - odorRiskScore) * 0.1
  );
  return clamp(composite, 0, 100);
};

const getMimeType = (filePath) => {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
};

const toDataUrlFromLocalFile = async (filePath) => {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) return null;
  const imageBytes = await fs.promises.readFile(filePath);
  if (!imageBytes || imageBytes.length === 0) return null;
  const mimeType = getMimeType(filePath);
  return `data:${mimeType};base64,${imageBytes.toString('base64')}`;
};

const resolveLocalCandidates = ({ fileUrl, storageKey }) => {
  const candidates = new Set();
  const add = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized) return;
    candidates.add(path.normalize(normalized));
  };

  const normalizedFileUrl = String(fileUrl || '').trim().replace(/\\/g, '/');
  if (normalizedFileUrl.startsWith('/static/')) {
    const relativePath = normalizedFileUrl.replace(/^\/static\/+/, '');
    add(path.join(process.cwd(), 'uploads', relativePath));
  }

  const normalizedStorageKey = String(storageKey || '').trim().replace(/\\/g, '/');
  if (normalizedStorageKey) {
    if (path.isAbsolute(normalizedStorageKey)) {
      add(normalizedStorageKey);
    }
    add(path.resolve(process.cwd(), normalizedStorageKey));
    add(path.resolve(process.cwd(), 'uploads', normalizedStorageKey));
  }

  return [...candidates];
};

const resolveMediaUrl = async (media) => {
  const fileUrl = String(media?.file_url || '').trim();
  if (!fileUrl) return null;

  if (/^https?:\/\//i.test(fileUrl)) {
    return fileUrl;
  }

  const storageKey = String(media?.storage_key || '').trim();
  if (!storageKey) return null;

  const s3DataUrl = await getObjectDataUrlFromS3(storageKey);
  if (s3DataUrl) {
    return s3DataUrl;
  }

  const localCandidates = resolveLocalCandidates({ fileUrl, storageKey });
  for (const candidate of localCandidates) {
    const dataUrl = await toDataUrlFromLocalFile(candidate);
    if (dataUrl) {
      return dataUrl;
    }
  }
  return null;
};

const normalizeMessageContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return String(part.text || '');
      return '';
    })
    .join('\n')
    .trim();
};

const tryParseJson = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch (error) {
    // no-op
  }

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const snippet = value.slice(start, end + 1);
  try {
    return JSON.parse(snippet);
  } catch (error) {
    return null;
  }
};

const toScore = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(Math.round(parsed), 0, 100);
};

const toConfidence = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clamp(Number(parsed.toFixed(3)), 0, 1);
};

const isOpenAiAnalysisEnabled = () => {
  const provider = String(process.env.ANALYSIS_PROVIDER || '').toLowerCase();
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  return hasKey && provider === 'openai';
};

const analyzeInspectionWithOpenAI = async ({ inspection, mediaRows }) => {
  if (!isOpenAiAnalysisEnabled()) {
    return null;
  }

  const maxImages = Math.min(Number(process.env.OPENAI_ANALYSIS_MAX_IMAGES || 4), 8);
  const selectedMedia = (Array.isArray(mediaRows) ? mediaRows : [])
    .filter((row) => row?.file_url)
    .slice(0, maxImages);
  if (selectedMedia.length === 0) {
    return null;
  }

  const imageUrls = [];
  for (const media of selectedMedia) {
    const resolvedUrl = await resolveMediaUrl(media);
    if (!resolvedUrl) continue;
    imageUrls.push({
      captureStage: media.capture_stage || 'evidence',
      imageUrl: resolvedUrl,
    });
  }

  if (imageUrls.length === 0) {
    return null;
  }

  const content = [
    {
      type: 'text',
      text:
        'Analyze sanitation inspection images. Return ONLY JSON with keys: cleanlinessScore, hygieneScore, odorRiskScore, wetnessScore, stainScore, litterScore, overallStatus, anomalyFlags, summary, confidence. Treat litterScore as dirt/litter cleanliness signal. Scores are 0-100. Higher is better except odorRiskScore (higher means worse). overallStatus must be one of clean, moderate, poor, critical.',
    },
    {
      type: 'text',
      text: `Inspection context: id=${inspection.id}, inspectionType=${inspection.inspection_type}, facilityId=${inspection.facility_id}.`,
    },
  ];

  imageUrls.forEach((item, index) => {
    content.push({
      type: 'text',
      text: `Image ${index + 1} (${item.captureStage})`,
    });
    content.push({
      type: 'image_url',
      image_url: {
        url: item.imageUrl,
        detail: 'auto',
      },
    });
  });

  const model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-4o-mini';
  const baseUrl = String(process.env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Math.max(Number(process.env.OPENAI_ANALYSIS_TIMEOUT_MS || 45000), 5000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let payload;
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a sanitation image quality analyst. Output strict JSON only. Be conservative and evidence-based.',
          },
          {
            role: 'user',
            content,
          },
        ],
      }),
      signal: controller.signal,
    });

    payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `OpenAI analysis request failed (${response.status})`;
      throw new Error(message);
    }
  } finally {
    clearTimeout(timer);
  }

  const rawContent = normalizeMessageContent(payload?.choices?.[0]?.message?.content);
  const parsed = tryParseJson(rawContent);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAI response did not contain valid JSON analysis');
  }

  const result = {
    modelName: model,
    modelVersion: 'openai-chat-completions',
    cleanlinessScore: toScore(parsed.cleanlinessScore, 0),
    hygieneScore: toScore(parsed.hygieneScore, 0),
    odorRiskScore: toScore(parsed.odorRiskScore, 0),
    wetnessScore: toScore(parsed.wetnessScore, 0),
    stainScore: toScore(parsed.stainScore, 0),
    litterScore: toScore(parsed.litterScore ?? parsed.dirtScore, 0),
    overallStatus: String(parsed.overallStatus || '').toLowerCase(),
    anomalyFlags:
      parsed.anomalyFlags && typeof parsed.anomalyFlags === 'object' && !Array.isArray(parsed.anomalyFlags)
        ? parsed.anomalyFlags
        : null,
    confidence: toConfidence(parsed.confidence),
    summary: parsed.summary ? String(parsed.summary).slice(0, 1200) : null,
    rawModelOutput: parsed,
  };

  if (!ANALYSIS_STATUSES.has(result.overallStatus)) {
    const composite = buildComposite(result);
    result.overallStatus = deriveStatus(composite);
  }

  if (!result.anomalyFlags) {
    result.anomalyFlags = {
      low_cleanliness: result.cleanlinessScore < 45,
      high_odor_risk: result.odorRiskScore > 70,
      wetness_concern: result.wetnessScore < 45,
      stain_concern: result.stainScore < 45,
      litter_concern: result.litterScore < 45,
    };
  }

  return {
    modelName: result.modelName,
    modelVersion: result.modelVersion,
    cleanlinessScore: result.cleanlinessScore,
    hygieneScore: result.hygieneScore,
    odorRiskScore: result.odorRiskScore,
    wetnessScore: result.wetnessScore,
    stainScore: result.stainScore,
    litterScore: result.litterScore,
    overallStatus: result.overallStatus,
    anomalyFlags: result.anomalyFlags,
    rawResult: {
      provider: 'openai',
      summary: result.summary,
      confidence: result.confidence,
      responseId: payload?.id || null,
      usage: payload?.usage || null,
      generatedAt: new Date().toISOString(),
      output: result.rawModelOutput,
      mediaCount: imageUrls.length,
    },
  };
};

module.exports = {
  isOpenAiAnalysisEnabled,
  analyzeInspectionWithOpenAI,
};
