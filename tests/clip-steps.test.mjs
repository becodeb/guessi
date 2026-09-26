// No-framework unit harness for src/clip-steps.js.
// Run with: node tests/clip-steps.test.mjs  (exit code 0 = all pass, non-zero = failure)

import { CLIP_STEPS_MS, clipIncrement, growClip, LISTEN_MORE_MS, pickClipStart } from "../src/clip-steps.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed++;
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function checkDeep(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- ladder shape ------------------------------------------------------------
checkDeep("ladder doubles from 0,1 s", CLIP_STEPS_MS, [100, 200, 400, 800, 1600, 3200]);

// --- clipIncrement -----------------------------------------------------------
check("first tap adds 0,1 s", clipIncrement(0), 100);
check("second tap adds 0,2 s", clipIncrement(1), 200);
check("third tap adds 0,4 s", clipIncrement(2), 400);
check("ceiling repeats", clipIncrement(CLIP_STEPS_MS.length), 3200);
check("ceiling repeats far past the ladder", clipIncrement(99), 3200);
check("negative index clamps to the first step", clipIncrement(-3), 100);

// --- growClip: the target walks the ladder -----------------------------------
// 0,1 → 0,2 → 0,4 → 0,8 → 1,6 → 3,2 → 6,4 → 9,6 …
let state = { targetMs: CLIP_STEPS_MS[0], stepIndex: 0 };
const walk = [state.targetMs];
for (let i = 0; i < 7; i++) {
  state = growClip(state.targetMs, state.stepIndex, Infinity);
  walk.push(state.targetMs);
}
checkDeep("target accumulates doubled jumps", walk, [100, 200, 400, 800, 1600, 3200, 6400, 9600]);
check("step index caps at the ceiling", state.stepIndex, CLIP_STEPS_MS.length - 1);
check("next jump past the ceiling is 3,2 s", clipIncrement(state.stepIndex), 3200);

// --- growClip: track-duration cap --------------------------------------------
const capped = growClip(1500, 3, 2000);
check("target never passes the track duration", capped.targetMs, 2000);
const noCap = growClip(1500, 3, 0);
check("duration 0 means no cap", noCap.targetMs, 2300);
const nanCap = growClip(1500, 3, Number.NaN);
check("NaN cap means no cap", nanCap.targetMs, 2300);
const missingCap = growClip(1500, 3);
check("omitted cap means no cap", missingCap.targetMs, 2300);

// --- pickClipStart: the "random start" decision for task T2 ------------------

// A tiny deterministic rng: returns each value from the array in order, and
// throws if the code under test asks for more than were queued — that would
// mean pickClipStart made an extra, unaccounted-for random draw.
function seq(...values) {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error("rng exhausted: unexpected extra call");
    return values[i++];
  };
}

// Same constants pickClipStart itself uses, recomputed here so the tests do
// not just restate whatever number the implementation happens to produce.
const MAX_CLIP_MS = CLIP_STEPS_MS[CLIP_STEPS_MS.length - 1];
const ROOM_NEEDED_MS = Math.max(MAX_CLIP_MS, LISTEN_MORE_MS);
function earliestStartFor(durationMs) {
  return Math.min(durationMs * 0.1, 15000);
}
function latestStartFor(durationMs) {
  return durationMs - ROOM_NEEDED_MS;
}

check("rng < 0,5 always starts at 0:00", pickClipStart(200000, seq(0.49)), 0);
check("rng < 0,5 short-circuits before reading duration", pickClipStart(undefined, seq(0)), 0);

{
  const duration = 200000;
  const earliest = earliestStartFor(duration); // 15000 (fraction would be 20000, floor wins)
  const latest = latestStartFor(duration); // 185000
  check("random branch: midpoint draw lands at the midpoint of the window",
    pickClipStart(duration, seq(0.9, 0.5)), Math.round(earliest + 0.5 * (latest - earliest)));
  check("random branch: rng()=0 for the position lands exactly on the earliest allowed start",
    pickClipStart(duration, seq(0.9, 0)), earliest);
  check("random branch: rng() near 1 lands at (not past) the latest allowed start",
    pickClipStart(duration, seq(0.99, 0.999)), earliest + Math.round(0.999 * (latest - earliest)));
}

check("unknown duration (undefined) falls back to 0 even on the random branch",
  pickClipStart(undefined, seq(0.9)), 0);
check("unknown duration (NaN) falls back to 0",
  pickClipStart(Number.NaN, seq(0.9)), 0);
check("unknown duration (0) falls back to 0",
  pickClipStart(0, seq(0.9)), 0);
check("negative duration falls back to 0",
  pickClipStart(-1000, seq(0.9)), 0);

// A 10 s track cannot fit the longest clip (3,2 s) *and* the 15 s "listen
// more" tail anywhere past its own first seconds — there is no room for a
// meaningful random point, so it must fall back to 0 even though the rng
// picked the random branch.
check("track too short for a meaningful random window falls back to 0",
  pickClipStart(10000, seq(0.9)), 0);

// Result is always a whole number of ms, never a fraction of the rng draw.
{
  const duration = 123456;
  const result = pickClipStart(duration, seq(0.75, 0.333333));
  check("result is rounded to a whole ms", Number.isInteger(result), true);
  const earliest = earliestStartFor(duration);
  const latest = latestStartFor(duration);
  check("rounded result still respects the earliest bound", result >= Math.round(earliest), true);
  check("rounded result still respects the latest bound", result <= Math.round(latest), true);
}

// Statistical sanity: over many seeded draws, about half should be exactly
// 0, and every non-zero draw must leave room for the longest clip and the
// "listen more" tail before the track ends.
{
  // mulberry32: tiny seeded PRNG, deterministic across runs/platforms.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const duration = 240000; // 4 minutes
  const earliest = earliestStartFor(duration);
  const latest = latestStartFor(duration);
  const rng = mulberry32(20260926);
  const N = 4000;
  let zeros = 0;
  let outOfBounds = 0;
  for (let i = 0; i < N; i++) {
    const start = pickClipStart(duration, rng);
    if (start === 0) zeros++;
    else if (start < earliest - 1 || start > latest + 1) outOfBounds++; // ±1 for rounding
  }
  const zeroRatio = zeros / N;
  check("about half of many draws start at 0:00 (within tolerance)",
    zeroRatio > 0.45 && zeroRatio < 0.55, true);
  check("every non-zero draw stays within the allowed window", outOfBounds, 0);
}

// A song's start never changes between calls with the same fixed rng branch
// (documents the caller contract: draw pickClipStart() once per song, not
// once per step — the round then reuses that stored value).
{
  const fixedRng = () => 0.7;
  const a = pickClipStart(200000, fixedRng);
  const b = pickClipStart(200000, fixedRng);
  check("same duration and rng always agree on the same start", a, b);
}

// --- report ------------------------------------------------------------------
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
}
console.log(`clip-steps.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
