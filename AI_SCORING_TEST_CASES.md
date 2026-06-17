# AI Scoring Manual Test Cases

## 1. Feces Inside Commode (Hard Fail)
- Before: visible feces/potty in bowl center.
- Expected:
  - `score_0_100 <= 25`
  - `hygiene_risk = severe`
  - `critical_findings.visible_feces_or_potty = true`
  - `star_rating_0_5 <= 1.3`

## 2. Stained Indian Pan + Dirty Rim
- Expected:
  - `critical_findings.dirty_commode_or_pan = true`
  - score capped (dirty commode cap applies)
  - status not `Clean`

## 3. Same Before/After Exact Image
- Use same uploaded file/hash for before and after.
- Expected:
  - suspicious flag set
  - `score_delta` near zero (<= 5 by post-processing rule)
  - `should_accept_improvement = false`

## 4. Clean Floor but Dirty Commode
- Expected:
  - commode penalty dominates
  - no high cleanliness score just because floor is clean

## 5. Blurry Toilet Image
- Expected:
  - `requires_retake = true`
  - `retake_reason` populated
  - no high-confidence outcome

## 6. Very Clean Toilet
- Clear commode/pan, dry floor, no visible waste/stains.
- Expected:
  - high score and star rating
  - `hygiene_risk = low`
  - no severe/retake flags

## 7. Waterlogged Floor
- Expected:
  - `critical_findings.waterlogging = true`
  - lower score and elevated risk

## 8. Overflowing Dustbin / Wet Waste
- Expected:
  - `critical_findings.trash_or_waste = true`
  - lower score and likely supervisor review flag

## 9. After Image Still Dirty
- Before dirty, after still has feces/stains.
- Expected:
  - low after score (caps still active)
  - `should_accept_improvement = false`
  - remaining critical issues listed

## 10. Real Improvement (Dirty -> Clean)
- Before heavily dirty, after clearly clean.
- Expected:
  - significant positive `score_delta`
  - `improvement_level = moderate|major`
  - `should_accept_improvement = true`

## API/Response Checks
- Verify `score_0_100` and `star_rating_0_5` are both present on image/inspection responses.
- Verify pairwise comparison payload fields:
  - `same_toilet_likely`
  - `image_angle_similarity`
  - `improvement_level`
  - `should_accept_improvement`
  - `suspicious_change_detected`
- Verify supervisor flags are emitted when required:
  - `AI_REVIEW_REQUIRED`
  - `RETAKE_REQUIRED`
  - `SUSPICIOUS_IMPROVEMENT`
  - `SEVERE_HYGIENE_ISSUE`
