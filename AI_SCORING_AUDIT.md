# AI Scoring Audit

## Current Flow (Before This Change)
- Worker captures/uploads `before` and `after` images through inspection media/session APIs.
- Images are stored in `inspection_media` (`file_url`, `capture_stage`, `sha256`, `perceptual_hash`, `similarity_score`).
- AI scoring is triggered by queue worker in `analysis.service` via `analyzeInspectionWithOpenAI`.
- OpenAI vision model (`gpt-4o-mini` from runtime config) is called in `openaiAnalysis.service` with detection + scoring prompts.
- Parsed strict/legacy scores are normalized and persisted to `inspection_media` + inspection aggregate fields.
- Aggregates and comparison endpoints are built from `inspectionEvidence.service` and consumed by web/mobile.

## Key Weaknesses Found
- Scoring was still too appearance-weighted in edge cases (dirty commode/feces could score too high).
- Before/after improvement trust logic was weak for near-identical or suspicious pairs.
- Hard sanitation caps were not centrally enforced across all paths.
- Retake and supervisor-review signals were not standardized in one post-processing layer.
- UI response fields for star/risk/strict status were inconsistent.

## What Was Changed
- Added centralized deterministic sanitation post-processing helper:
  - `score_0_100` caps for feces/dirty commode/high-risk/severe-risk.
  - star mapping (`0-5`) and strict cleanliness bands.
  - retake decisions (low confidence/visibility/quality).
  - pairwise before/after evaluation (same-toilet likelihood, suspicious duplicate, improvement acceptance).
  - supervisor review flags.
- Upgraded OpenAI scoring prompt to strict sanitation-risk-first instructions.
- Added strict schema parsing support (`score_0_100`, `hygiene_risk`, `critical_findings`, etc.) while preserving legacy compatibility.
- Applied post-processing in worker scoring path before persistence (both normal and fallback scoring paths).
- Persisted strict fields in `inspection_media.metadata.ai_scoring` and exposed them in APIs.
- Enhanced inspection aggregate recomputation with pairwise comparison output and supervisor flags.
- Enhanced comparison endpoint + inspection mapping for score, stars, risk, status, retake/suspicious reasons.
- Minimal UI wiring in existing web/mobile screens (no redesign) for score/stars/risk/status + comparison insights.

## Files Touched
- Backend
  - `src/modules/analysis/openaiAnalysis.service.js`
  - `src/modules/analysis/analysis.service.js`
  - `src/modules/analysis/sanitationPostProcessing.helper.js` (new)
  - `src/modules/analysis/hygieneRubric.helper.js`
  - `src/modules/inspections/inspectionEvidence.service.js`
  - `src/modules/inspections/inspection.service.js`
  - `tests/openaiAnalysis.scoring.test.js`
  - `tests/openai-analysis-normalization.test.js`
  - `tests/sanitation-post-processing.test.js` (new)
- Web
  - `src/api/mappers.js`
  - `src/features/inspections/pages/InspectionDetail.jsx`
- Flutter
  - `lib/models/inspection_item.dart`
  - `lib/views/history_screen.dart`

## Risk Areas
- OpenAI output variance: strict parser now supports new/legacy formats, but malformed payloads still fall back.
- Existing historical media rows without `metadata.ai_scoring` use safe fallbacks in API mapping.
- Full backend test suite has unrelated QR resolver DB/environment failures; targeted scoring tests pass.
- No DB migration was added; strict fields are stored in existing JSON metadata to remain backward-compatible.
