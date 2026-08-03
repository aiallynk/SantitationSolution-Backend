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

## PPM Odor-Tier Update (2026-08-03)

### Prior PPM Behaviour
- The live alert defaults for the wand's TGS gas channel were `null`, so PPM alerts were disabled unless an operator supplied environment overrides.
- Backend scoring used a retired legacy bracket: a PPM value only contributed a small `-2` risk signal when it exceeded the warning configuration, which fell back to `400 PPM`.
- The web sensor display independently treated only values above `150 PPM` as elevated.
- As a result, normal operational readings in the `41-120+ PPM` range did not consistently affect inspection scoring or operational status.

### Approved PPM Policy Now Enforced

| PPM range | Odor tier | Cleanliness rating | Applied score adjustment |
| --- | --- | --- | --- |
| `0-15` | Excellent / Fresh | Best | `+20` down to `+10` |
| `16-40` | Good / Normal | Clean | `+10` down to `+1` |
| `41-75` | Moderate / Noticeable | Acceptable / Fair | `-1` down to `-5` |
| `76-120` | Bad / Heavy Odor | Bad | `-5` down to `-10` |
| `>120` | Critical / Severe | Critical / Unusable | `-20` maximum penalty |

- Bounded tiers interpolate and round to an integer across their documented range. The unbounded `>120 PPM` tier uses the documented maximum penalty, keeping the PPM contribution capped rather than allowing it to drive an otherwise visual score to zero.
- PPM alert thresholds are now `warning: 76` and `critical: 121`. `121` is intentional because the critical tier is strictly greater than `120 PPM`.
- The alert engine therefore reports `76-120` as warning and `121+` as critical.

### Scoring and Data Integrity Controls
- PPM tiering is resolved in one backend policy (`ppmOdorTier.service.js`) and used by deterministic sensor fusion, live alert defaults, and threshold tests.
- The OpenAI prompt no longer asks the model to score PPM. The backend applies the approved tier after visual scoring, avoiding nondeterministic or double-counted gas penalties.
- The final strict result persists `sensor_impact`, `environmental_score`, and `ppm_odor_tier`; the final score and star rating are kept in sync after the sensor adjustment.
- A hash-cached image score is not reused when either inspection has a real PPM-tier result, preventing a prior inspection's environmental reading from being applied to a new inspection.
- Fallback analysis follows the same PPM policy, and synthetic sensor backfill ranges now align to the five approved bands.
- Web operational labels now show the same odor tiers instead of the retired `150 PPM` cutoff. The Flutter app displays the raw PPM reading and had no separate hard-coded PPM classification threshold.

### Rollout Notes
- No database migration or historical-score rewrite was performed. New analyses use scoring version `sanitation-rubric-v2-ppm-odor`; existing completed inspections retain their stored historical result until explicitly reprocessed.
- A deployment that explicitly sets `SENSOR_PPM_WARNING` or `SENSOR_PPM_CRITICAL` must set them to `76` and `121`, respectively, or remove them to use the backend defaults.
- Validated locally with the full backend test suite, dedicated PPM boundary/scoring tests, full web test suite, and production web build.

## Files Touched
- Backend
  - `src/modules/analysis/openaiAnalysis.service.js`
  - `src/modules/analysis/analysis.service.js`
  - `src/modules/sensors/ppmOdorTier.service.js` (new)
  - `src/modules/sensors/sensorThreshold.service.js`
  - `src/modules/sensors/syntheticSensorBackfill.generator.js`
  - `src/config/defaults.js`
  - `tests/ppm-odor-tier.test.js` (new)
  - `tests/analysis-ppm-odor-tier.test.js` (new)
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
  - `src/utils/ppmOdorTier.js` (new)
  - `src/components/ops/SensorSnapshotCard.jsx`
  - `src/services/live/sensorsService.js`
- Flutter
  - `lib/models/inspection_item.dart`
  - `lib/views/history_screen.dart`

## Risk Areas
- OpenAI output variance: strict parser now supports new/legacy formats, but malformed payloads still fall back.
- Existing historical media rows without `metadata.ai_scoring` use safe fallbacks in API mapping.
- Full backend test suite has unrelated QR resolver DB/environment failures; targeted scoring tests pass.
- No DB migration was added; strict fields are stored in existing JSON metadata to remain backward-compatible.
