// No-framework unit harness for src/lyrics-queue.js and src/letra-color.js.
// Run with: node tests/lyrics-queue.test.mjs  (exit code 0 = all pass)

import { createQueue } from "../src/lyrics-queue.js";
import {
  floodFromRgb, deepOf, fallbackFlood, fromHex, whiteContrast, rgbToHsl, hslToRgb,
  dominantRgb, MIN_CONTRAST,
} from "../src/letra-color.js";

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
const ids = (q) => q.tracks().map((t) => t.id).join(",");
// Deterministic rng: a fixed sequence in [0, 1).
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

// --- bounds -------------------------------------------------------------------
{
  const q = createQueue(mk(3));
  check("starts at the first", q.current().id, "t0");
  check("prev at the start is null", q.prev(), null);
  check("prev at the start keeps index", q.index(), 0);
  check("next moves", q.next().id, "t1");
  check("next again", q.next().id, "t2");
  check("next at the end is null", q.next(), null);
  check("next at the end keeps index", q.index(), 2);
  check("hasNext at the end", q.hasNext(), false);
  check("prev moves back", q.prev().id, "t1");
  check("hasPrev", q.hasPrev(), true);
}

// --- start index, dedupe, empty -------------------------------------------------
{
  check("startIndex", createQueue(mk(4), { startIndex: 2 }).current().id, "t2");
  check("startIndex clamps", createQueue(mk(2), { startIndex: 9 }).current().id, "t1");
  check("dedupes by id", createQueue([{ id: "a" }, { id: "a" }, { id: "b" }]).size(), 2);
  const e = createQueue([]);
  check("empty current", e.current(), null);
  check("empty next", e.next(), null);
  e.setShuffle(true);
  check("empty shuffle is off", e.isShuffled(), false);
}

// --- shuffle keeps the current song and the played ones ----------------------------
{
  const q = createQueue(mk(6), { startIndex: 2, rng: seq(0.9, 0.1, 0.5) });
  q.setShuffle(true);
  check("shuffle on", q.isShuffled(), true);
  check("current survives shuffle", q.current().id, "t2");
  check("played songs stay put", ids(q).startsWith("t0,t1,t2,"), true);
  check("same songs", q.tracks().map((t) => t.id).sort().join(","), "t0,t1,t2,t3,t4,t5");
  check("remaining part is reordered", ids(q) !== "t0,t1,t2,t3,t4,t5", true);
  q.next();
  q.next();
  const cur = q.current().id;
  q.setShuffle(false);
  check("unshuffle restores original order", ids(q), "t0,t1,t2,t3,t4,t5");
  check("unshuffle keeps the current song", q.current().id, cur);
  check("shuffle off", q.isShuffled(), false);
}
{
  const q = createQueue(mk(3));
  q.setShuffle(true);
  q.setShuffle(true);
  check("double shuffle on is harmless", q.size(), 3);
  q.setShuffle(false);
  q.setShuffle(false);
  check("double shuffle off is harmless", ids(q), "t0,t1,t2");
}
{
  const q = createQueue(mk(1));
  q.setShuffle(true);
  check("single song shuffle keeps it", q.current().id, "t0");
  check("single song has no next", q.hasNext(), false);
}

// --- drop ------------------------------------------------------------------------
{
  const q = createQueue(mk(4), { startIndex: 1 });
  check("drop current moves to the next", q.drop("t1").id, "t2");
  check("drop leaves the rest", ids(q), "t0,t2,t3");
  check("drop earlier shifts the index", (q.drop("t0"), q.current().id), "t2");
  q.next();
  check("drop last-current falls back to the previous", q.drop("t3").id, "t2");
  check("drop unknown id changes nothing", q.drop("zzz").id, "t2");
  check("drop the only song empties the queue", (q.drop("t2"), q.current()), null);
}
{
  const q = createQueue(mk(4), { startIndex: 1, rng: seq(0.3) });
  q.setShuffle(true);
  q.drop("t3");
  q.drop("t2");
  q.setShuffle(false);
  check("unshuffle forgets dropped songs", ids(q), "t0,t1");
}

// --- flood color -------------------------------------------------------------------
{
  let worst = Infinity;
  let sMin = 1;
  for (let h = 0; h < 360; h += 10) {
    for (const sat of [0.4, 0.7, 1]) {
      for (const light of [0.15, 0.5, 0.9]) {
        const [r, g, b] = hslToRgb(h, sat, light);
        const hex = floodFromRgb(r, g, b);
        const rgb = fromHex(hex);
        worst = Math.min(worst, whiteContrast(rgb, 0.78));
        sMin = Math.min(sMin, rgbToHsl(...rgb).s);
      }
    }
  }
  check("white text passes on every flood", worst >= MIN_CONTRAST - 0.05, true);
  check("flood stays saturated", sMin >= 0.4, true);
  const gray = fromHex(floodFromRgb(128, 128, 128));
  check("gray cover gets a floor of saturation", rgbToHsl(...gray).s >= 0.4, true);
  check("flood is dark", rgbToHsl(...fromHex(floodFromRgb(255, 255, 0))).l <= 0.3, true);
}
{
  check("deepOf is darker", fromHex(deepOf("#1a2a6c"))[2] < fromHex("#1a2a6c")[2], true);
  check("deepOf of garbage still answers", deepOf("nope"), "#0b1a28");
  check("fallback is stable", fallbackFlood("abc"), fallbackFlood("abc"));
  check("fallback is a palette color", /^#[0-9a-f]{6}$/.test(fallbackFlood("zzz")), true);
  check("fallback of nothing answers", /^#[0-9a-f]{6}$/.test(fallbackFlood(null)), true);
}
{
  // 2x2 image: three gray pixels and one saturated red one. The red must win.
  const data = new Uint8ClampedArray([
    120, 120, 120, 255, 130, 130, 130, 255, 125, 125, 125, 255, 200, 30, 30, 255,
  ]);
  const [r, g, b] = dominantRgb(data);
  check("saturated pixel wins over gray", r > g + 40 && r > b + 40, true);
  check("fully transparent image has no color", dominantRgb(new Uint8ClampedArray([0, 0, 0, 0])), null);
}

if (failures.length > 0) {
  console.error(`lyrics-queue.test.mjs: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`lyrics-queue.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
