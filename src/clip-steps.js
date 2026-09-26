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

// --- random clip start (task T2) ---------------------------------------------
// "La primera décima" no longer always starts at 0:00. Each song decides once,
// when it is drawn, whether its clip starts at the beginning or at a random
// point later in the track — see pickClipStart() below.

/** Longest clip the game ever plays (the ladder's ceiling). */
const MAX_CLIP_MS = CLIP_STEPS_MS[CLIP_STEPS_MS.length - 1];

/** "Escuchar más" tail length (kept in sync with games/clip-game.js). */
export const LISTEN_MORE_MS = 15000;

// A random start still has to read as "some other moment in the song", not
// merely "not exactly zero": it must clear at least this fraction of the
// track, or this many ms, whichever is smaller — so a short track is not
// forced past its own middle, but a long one still skips a meaningful chunk
// of its intro.
const MIN_START_FRACTION = 0.1;
const MIN_START_FLOOR_MS = 15000;

/**
 * Decide once per song where its clip starts. With probability 1/2 (checked
 * via `rng()`, injectable for tests) the song starts at 0:00. Otherwise it
 * starts at a random point that still leaves room for the longest clip step
 * AND the full "listen more" tail before the track ends, and that clears the
 * very first seconds so it reads as an actual random moment instead of
 * "still basically the intro".
 *
 * Falls back to 0 when the duration is unknown or too short to fit a
 * meaningful random window.
 * @param {number} durationMs  track duration in ms (e.g. `track.duration_ms`)
 * @param {() => number} [rng]  returns a float in [0, 1); defaults to Math.random
 * @returns {number}  start position in ms, rounded to a whole ms
 */
export function pickClipStart(durationMs, rng = Math.random) {
  if (rng() < 0.5) return 0;

  const duration = Number(durationMs);
  if (!Number.isFinite(duration) || duration <= 0) return 0;

  const roomNeeded = Math.max(MAX_CLIP_MS, LISTEN_MORE_MS);
  const latestStart = duration - roomNeeded;
  const earliestStart = Math.min(duration * MIN_START_FRACTION, MIN_START_FLOOR_MS);
  if (latestStart <= earliestStart) return 0;

  return Math.round(earliestStart + rng() * (latestStart - earliestStart));
}
