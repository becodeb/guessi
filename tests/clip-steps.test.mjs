// No-framework unit harness for src/clip-steps.js.
// Run with: node tests/clip-steps.test.mjs  (exit code 0 = all pass, non-zero = failure)

import { CLIP_STEPS_MS, clipIncrement, growClip } from "../src/clip-steps.js";

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

// --- report ------------------------------------------------------------------
if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${f}`);
}
console.log(`clip-steps.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
