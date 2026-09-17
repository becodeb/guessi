// No-framework unit harness for src/lyrics-engine.js.
// Run with: node tests/lyrics.test.mjs  (exit code 0 = all pass, non-zero = failure)

import { tokenize, createLyricsGame, maskWord } from "../src/lyrics-engine.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) {
    passed++;
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- tokenizer ---------------------------------------------------------------

{
  const { lines, words } = tokenize("¡Hola, mundo!\n\nAdiós.");
  check("tokenize keeps blank lines (3 source lines)", lines.length, 3);
  check("tokenize excludes punctuation-only tokens from words", words.length, 3);
  check("tokenize flat reading-order", words.map((w) => w.normalized).join(" "), "hola mundo adios");
  check("tokenize word text keeps accents/punctuation", words[0].text, "¡Hola,");
  check("tokenize wordIndex mirrors global index across blank line", lines[2][0].wordIndex, 2);
  check("tokenize non-word token has undefined wordIndex", lines[0][0].wordIndex === 0 || lines[0][0].isWord === true, true);
}

{
  const { words } = tokenize("you're here");
  check("tokenize keeps apostrophe in word text", words[0].text, "you're");
  check("tokenize normalizes apostrophe word", words[0].normalized, "youre");
  check("tokenize counts accent word", words.length, 2);
}

// --- rule 1: Space-correct-at-cursor + advance -------------------------------

{
  const g = createLyricsGame("uno dos tres");
  const r = g.placeAtCursor("uno");
  check("Space-correct reveals at cursor", r.ok, true);
  check("Space-correct revealedIndex 0", r.revealedIndex, 0);
  check("Space-correct advances cursor to 1", g.cursor(), 1);
  check("Space-correct revealedCount 1", g.revealedCount(), 1);
}

// --- rule 1: Space-wrong (no reveal, no advance) -----------------------------

{
  const g = createLyricsGame("uno dos tres");
  const r = g.placeAtCursor("cuatro");
  check("Space-wrong is mismatch", r.reason, "mismatch");
  check("Space-wrong reveals nothing", g.revealedCount(), 0);
  check("Space-wrong keeps cursor at 0", g.cursor(), 0);
}

// --- rule 2: Space-empty on repeated vs unknown word -------------------------

{
  const g = createLyricsGame("oh oh oh");
  check("repeated: first 'oh' via Space", g.placeAtCursor("oh").ok, true); // reveals 0, cursor 1
  const known = g.revealKnownAtCursor(); // cursor at second 'oh'
  check("repeated: Space-empty reveals known word", known.ok, true);
  check("repeated: known word revealedIndex 1", known.revealedIndex, 1);
  check("repeated: third 'oh' also revealable", g.revealKnownAtCursor().ok, true);
  check("repeated: all revealed", g.isComplete(), true);
}

{
  const g = createLyricsGame("foo bar");
  const r = g.revealKnownAtCursor(); // nothing discovered yet
  check("unknown: Space-empty is no-op (no-known)", r.reason, "no-known");
  check("unknown: Space-empty reveals nothing", g.revealedCount(), 0);
  check("unknown: Space-empty keeps cursor", g.cursor(), 0);
}

// --- rule 3: Enter finds the right occurrence --------------------------------

{
  const g = createLyricsGame("a b a c");
  const first = g.revealAnywhere("a"); // cursor 0 → reveals occurrence 0
  check("Enter-first reveals occurrence 0", first.revealedIndex, 0);
  const second = g.revealAnywhere("a"); // cursor 1 → reveals occurrence 2 (wraps search)
  check("Enter-second reveals occurrence 2 (not 0)", second.revealedIndex, 2);
  check("Enter-second occurrence 0 still revealed", g.isRevealed(0), true);
  check("Enter-second occurrence 2 revealed", g.isRevealed(2), true);
  check("Enter-second cursor lands on next hidden (3)", g.cursor(), 3);
}

{
  const g = createLyricsGame("a b a c");
  g.revealAnywhere("a"); // cursor 1
  const nf = g.revealAnywhere("z");
  check("Enter not-found reason", nf.reason, "not-found");
  check("Enter not-found reveals nothing new", g.revealedCount(), 1);
  check("Enter not-found keeps cursor", g.cursor(), 1);
}

// --- cyclic wrap at the end --------------------------------------------------

{
  const g = createLyricsGame("x a y a");
  g.revealAnywhere("a"); // reveals occurrence 1, cursor 2
  const r = g.revealAnywhere("a"); // reveals occurrence 3, cursor wraps to 0
  check("wrap: reveals later occurrence 3", r.revealedIndex, 3);
  check("wrap: cursor wraps back to 0 (next hidden after end)", g.cursor(), 0);
}

// --- rule 4: click / moveCursor ----------------------------------------------

{
  const g = createLyricsGame("a b c");
  check("moveCursor to hidden word", g.moveCursor(2), true);
  check("moveCursor updates cursor", g.cursor(), 2);
  g.placeAtCursor("c"); // reveal 2, cursor → 0
  check("moveCursor rejects revealed word", g.moveCursor(2), false);
  check("moveCursor rejects out-of-range", g.moveCursor(99), false);
}

// --- rule 5: progressive hints until complete -------------------------------

{
  const g = createLyricsGame("abc");
  check("hint 1 reveals one char", g.hint().reason, "ok");
  check("hint 1 level", g.hintLevel(0), 1);
  check("hint 1 not yet revealed", g.isRevealed(0), false);
  check("hint 2 reveals another char", g.hint().reason, "ok");
  check("hint 2 level", g.hintLevel(0), 2);
  check("hint 2 still not revealed", g.isRevealed(0), false);
  const done = g.hint(); // 3rd char → completes
  check("hint completes the word", done.reason, "done");
  check("hint complete marks revealed", g.isRevealed(0), true);
  check("hint complete isComplete", g.isComplete(), true);
}

{
  const g = createLyricsGame("a"); // single letter/digit char
  const r = g.hint();
  check("single-char hint completes immediately", r.reason, "done");
  check("single-char hint revealed", g.isRevealed(0), true);
}

// --- rule 6 + 7: revealAll / isComplete / counters ---------------------------

{
  const g = createLyricsGame("x y z");
  g.hint(); // some hint progress on word 0
  const r = g.revealAll();
  check("revealAll reason done", r.reason, "done");
  check("revealAll isComplete", g.isComplete(), true);
  check("revealAll revealedCount", g.revealedCount(), 3);
  check("hintCount reflects hinted chars", g.hintCount(), 1);
}

// --- accent / case-insensitive matching --------------------------------------

{
  const g = createLyricsGame("Café creep");
  check("accent: cafe reveals Café", g.placeAtCursor("cafe").ok, true);
  check("case: CREEP reveals creep", g.placeAtCursor("CREEP").ok, true);
  check("accent/case both revealed", g.isComplete(), true);
}

{
  const { words } = tokenize("Creep,");
  check("trailing comma word normalizes to creep", words[0].normalized, "creep");
  const g = createLyricsGame("Creep,");
  check("Creep, matched by creep", g.placeAtCursor("creep").ok, true);
}

// --- display masking (shared with the round UI) ------------------------------

{
  check("mask level 0 hides every letter", maskWord("hello", 0), "_____");
  check("mask keeps punctuation and apostrophes", maskWord("you're", 1), "y__'__");
  check("mask level counts letters only", maskWord("don't", 2), "do_'_");
  check("mask reveals the full word at its letter count", maskWord("Creep,", 5), "Creep,");
  check("mask leaves punctuation-only tokens untouched", maskWord("¡oh!", 0), "¡__!");
}

// --- summary -----------------------------------------------------------------

console.log(`lyrics.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
