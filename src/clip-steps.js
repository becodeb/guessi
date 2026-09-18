// Pure clip-length ladder for the round's increment button. No DOM, no state —
// deterministic: the doubling rule and its ceiling live in one testable place.
//
// Rationale: the first seconds of a song are the most informative, so the first
// taps must be tiny (0,1 s); once those are not enough, taps should cover ground
// fast. Each tap therefore doubles the time it adds until the ceiling, and the
// ceiling repeats on every later tap.

/** Doubling ladder: 0,1 → 0,2 → 0,4 → 0,8 → 1,6 → 3,2 s (then 3,2 s forever). */
export const CLIP_STEPS_MS = [100, 200, 400, 800, 1600, 3200];

/** Increment a tap would add at `stepIndex` (clamped into the ladder). */
export function clipIncrement(stepIndex) {
  const i = Math.min(Math.max(stepIndex, 0), CLIP_STEPS_MS.length - 1);
  return CLIP_STEPS_MS[i];
}

/**
 * Apply one tap: the target grows by the ladder's current increment and the
 * step advances until the ceiling. The target never passes `maxMs` (the track
 * duration when known); non-finite or ≤0 values mean "no cap".
 * @returns {{ targetMs:number, stepIndex:number }}
 */
export function growClip(targetMs, stepIndex, maxMs = Infinity) {
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : Infinity;
  return {
    targetMs: Math.min(targetMs + clipIncrement(stepIndex), cap),
    stepIndex: Math.min(stepIndex + 1, CLIP_STEPS_MS.length - 1),
  };
}

// --- start-offset ladder -----------------------------------------------------
// Separate dimension from the clip LENGTH above: where the window starts.
//
// Why this ladder is coarser than CLIP_STEPS_MS: the clip ladder starts tiny
// because the first instants of a song are the most informative, so every
// 0,1 s is worth its own tap. The offset's job is the opposite — it exists to
// skip dead air before the first note, and there is nothing to learn inside
// silence, so its first tap already moves half a second and it reaches 4 s in
// four taps.

/** Start-offset ladder: 0,5 → 1 → 2 → 4 s (then 4 s forever). */
export const OFFSET_STEPS_MS = [500, 1000, 2000, 4000];

/** Jump a tap would add at `stepIndex` (clamped into the ladder). */
export function offsetIncrement(stepIndex) {
  const i = Math.min(Math.max(stepIndex, 0), OFFSET_STEPS_MS.length - 1);
  return OFFSET_STEPS_MS[i];
}

/**
 * Apply one tap on the start offset: same shape as growClip. The offset never
 * passes `maxMs` (callers pass the room left before the track ends, i.e.
 * duration − clip length); non-finite or ≤0 values mean "no cap".
 * @returns {{ fromMs:number, stepIndex:number }}
 */
export function growOffset(fromMs, stepIndex, maxMs = Infinity) {
  const cap = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : Infinity;
  return {
    fromMs: Math.min(fromMs + offsetIncrement(stepIndex), cap),
    stepIndex: Math.min(stepIndex + 1, OFFSET_STEPS_MS.length - 1),
  };
}
