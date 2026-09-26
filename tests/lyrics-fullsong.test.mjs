// No-framework unit harness for src/lyrics-fullsong.js.
// Run with: node tests/lyrics-fullsong.test.mjs  (exit code 0 = all pass, non-zero = failure)

import {
  MIN_WHOLE_SONG_WORDS, isUsableWholeSong, progressPercent,
  firstIncompleteLineIndex, firstIncompleteLineText,
} from "../src/lyrics-fullsong.js";
import { tokenize, createLyricsGame } from "../src/lyrics-engine.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function checkTrue(name, value) {
  check(name, Boolean(value), true);
}

// --- isUsableWholeSong -----------------------------------------------------

check("MIN_WHOLE_SONG_WORDS is a sane floor", MIN_WHOLE_SONG_WORDS >= 10 && MIN_WHOLE_SONG_WORDS <= 40, true);

{
  const shortText = "muy pocas palabras acá nomás";
  checkTrue("isUsableWholeSong: rejects a too-short text", !isUsableWholeSong(shortText));
}

{
  const words = [];
  for (let i = 0; i < MIN_WHOLE_SONG_WORDS; i++) words.push(`palabra${i}`);
  const longText = words.join(" ");
  checkTrue("isUsableWholeSong: accepts a text right at the floor", isUsableWholeSong(longText));
}

checkTrue("isUsableWholeSong: empty text is never usable", !isUsableWholeSong(""));

// --- progressPercent ---------------------------------------------------------

check("progressPercent: 0 of 0 is 0 (never divides by zero)", progressPercent(0, 0), 0);
check("progressPercent: half", progressPercent(5, 10), 50);
check("progressPercent: rounds", progressPercent(1, 3), 33);
check("progressPercent: full", progressPercent(10, 10), 100);
check("progressPercent: negative found clamps to 0", progressPercent(-3, 10), 0);

// --- firstIncompleteLineIndex / firstIncompleteLineText -----------------------

const SONG = [
  "Primera linea de prueba",
  "Segunda linea de prueba",
  "",
  "Tercera linea de prueba",
].join("\n");

// Reveals the exact word at `i` regardless of duplicates elsewhere (this
// song repeats "linea", "de" and "prueba" across lines) — the same
// index-targeted technique lyrics-game.js uses for "Revelar línea", since
// revealAnywhere(text) would happily reveal a DIFFERENT line's occurrence.
function revealWordFully(engine, i) {
  if (engine.isRevealed(i)) return;
  engine.moveCursor(i);
  while (!engine.isRevealed(i)) engine.hint();
}

{
  const { lines } = tokenize(SONG);
  const engine = createLyricsGame(SONG);
  check("firstIncompleteLineIndex: nothing revealed yet -> line 0", firstIncompleteLineIndex(lines, engine), 0);
  check("firstIncompleteLineText: matches line 0's text", firstIncompleteLineText(lines, engine), "Primera linea de prueba");

  // Reveal every word of line 0.
  for (const tok of lines[0]) {
    if (tok.isWord) revealWordFully(engine, tok.wordIndex);
  }
  check("firstIncompleteLineIndex: advances past a fully revealed line", firstIncompleteLineIndex(lines, engine), 1);

  // Reveal line 1 too — line 2 (index 2) is blank, must be skipped.
  for (const tok of lines[1]) {
    if (tok.isWord) revealWordFully(engine, tok.wordIndex);
  }
  check("firstIncompleteLineIndex: skips a blank source line", firstIncompleteLineIndex(lines, engine), 3);

  engine.revealAll();
  check("firstIncompleteLineIndex: -1 once everything is revealed", firstIncompleteLineIndex(lines, engine), -1);
  check("firstIncompleteLineText: null once everything is revealed", firstIncompleteLineText(lines, engine), null);
}

{
  // A song with no lines at all (degenerate input).
  const engine = createLyricsGame("");
  check("firstIncompleteLineIndex: no lines -> -1", firstIncompleteLineIndex([], engine), -1);
}

// --- summary -----------------------------------------------------------------

console.log(`lyrics-fullsong.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
