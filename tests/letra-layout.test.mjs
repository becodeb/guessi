// Unit harness for src/letra-layout.js and the lyric tint in src/letra-color.js.
// Run with: node tests/letra-layout.test.mjs

import {
  KEYBOARD_RATIO, isKeyboardOpen, createViewportTracker, scrollTarget, anchorFor, scrollPadding,
} from "../src/letra-layout.js";
import {
  floodFromRgb, fallbackFlood, fromHex, tintOf, tintContrast, TINT, MIN_CONTRAST, hslToRgb,
} from "../src/letra-color.js";

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- keyboard threshold -----------------------------------------------------------------
check("ratio is 75 %", KEYBOARD_RATIO, 0.75);
check("full height: closed", isKeyboardOpen(844, 844), false);
check("url bar collapsing is not a keyboard", isKeyboardOpen(790, 844), false);
check("just above the threshold", isKeyboardOpen(633, 844), false); // 844 * .75 = 633
check("just below the threshold", isKeyboardOpen(632, 844), true);
check("a keyboard", isKeyboardOpen(430, 844), true);
check("nothing seen yet", isKeyboardOpen(430, 0), false);

{
  const t = createViewportTracker();
  check("first measurement", t.update(390, 844), false);
  check("keyboard opens", t.update(390, 430), true);
  check("tallest is kept", t.tallest(), 844);
  check("keyboard closes", t.update(390, 844), false);
  check("loaded with the keyboard up: never open", createViewportTracker().update(390, 430), false);
  check("rotation resets the tallest", (() => { t.update(390, 430); t.update(844, 390); return t.update(844, 390); })(), false);
  check("rotated tallest", t.tallest(), 390);
  check("keyboard in landscape", t.update(844, 250), true);
}

// --- the composition: where the cursor line is held --------------------------------------------
check("anchor on a wide screen", anchorFor(false), 0.38);
check("anchor on a phone, with or without the keyboard", anchorFor(true), 0.3);
check("target centers the line at the anchor", scrollTarget({ lineTop: 800, lineHeight: 40, viewHeight: 600, anchor: 0.38 }), 592);
check("never negative", scrollTarget({ lineTop: 10, lineHeight: 40, viewHeight: 600, anchor: 0.38 }), 0);
check("never past the end", scrollTarget({ lineTop: 5000, lineHeight: 40, viewHeight: 600, anchor: 0.3, scrollHeight: 1200 }), 600);
check("shorter view, same anchor", scrollTarget({ lineTop: 800, lineHeight: 40, viewHeight: 300, anchor: 0.3 }), 730);
check("padding lets the ends reach the anchor", scrollPadding(300, 0.3), { top: 90, bottom: 210 });

// --- the pale tint -----------------------------------------------------------------------------------
check("tint is 62 % white", TINT, 0.62);
check("tint of black", tintOf([0, 0, 0]), [158, 158, 158]);
check("tint of white", tintOf([255, 255, 255]), [255, 255, 255]);
{
  const fallbacks = ["#5a0a14", "#0b3d2e", "#1a2a6c", "#4a1a6b", "#6b3a00", "#0a4a5a", "#12304a"];
  for (const hex of fallbacks) {
    check(`tint on ${hex} reads (>= ${MIN_CONTRAST})`, tintContrast(fromHex(hex)) >= MIN_CONTRAST, true);
  }
  // Whatever a cover gives, the flood keeps the tint legible.
  let worst = Infinity;
  for (let h = 0; h < 360; h += 10) {
    for (const [s, l] of [[1, 0.5], [0.8, 0.6], [0.5, 0.4]]) {
      const [r, g, b] = hslToRgb(h, s, l);
      worst = Math.min(worst, tintContrast(fromHex(floodFromRgb(r, g, b))));
    }
  }
  check("every sampled flood keeps the tint legible", worst >= MIN_CONTRAST, true);
  check("hashed fallback floods are the six palette colors", ["a", "bb", "ccc", "dddd", "e", "ff"].every((id) => fallbacks.includes(fallbackFlood(id))), true);
}

console.log(`letra-layout.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
