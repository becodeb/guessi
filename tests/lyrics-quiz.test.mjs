// No-framework unit harness for src/lyrics-quiz.js.
// Run with: node tests/lyrics-quiz.test.mjs  (exit code 0 = all pass, non-zero = failure)

import {
  splitStanzas, pickFragment, pickBlankIndices, buildFragment, createFragmentQuiz,
  findFragmentTiming, scoreFragment, FRAGMENT_TIMER_MS, MAX_LISTENS_PER_FRAGMENT,
} from "../src/lyrics-quiz.js";
import { tokenize } from "../src/lyrics-engine.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function checkTrue(name, value) {
  check(name, Boolean(value), true);
}

/** Deterministic rng: cycles through fixed values, then repeats the last one. */
function seq(...values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const SONG = [
  "Un verso de prueba para el harness",
  "Otra línea que nadie va a cantar",
  "Solo existe para llenar la letra",
  "",
  "Un verso de prueba para el harness",
  "Y comprobar que el juego puede andar",
  "Palabras huecas nada más que eso",
  "El harness no reproduce nada real",
  "",
  "Es solo texto para hacer un test",
].join("\n");

// --- splitStanzas --------------------------------------------------------------

{
  const stanzas = splitStanzas(SONG);
  check("splitStanzas: 3 stanzas", stanzas.length, 3);
  check("splitStanzas: first stanza has 3 lines", stanzas[0].lines.length, 3);
  check("splitStanzas: second stanza has 4 lines", stanzas[1].lines.length, 4);
  check("splitStanzas: third stanza has 1 line", stanzas[2].lines.length, 1);
  check("splitStanzas: startLine tracks blank lines", stanzas[1].startLine, 4);
  checkTrue("splitStanzas: trims lines", stanzas[0].lines[0] === "Un verso de prueba para el harness");
}

check("splitStanzas: empty text has no stanzas", splitStanzas("").length, 0);
check("splitStanzas: blank-only text has no stanzas", splitStanzas("\n\n\n").length, 0);

// --- pickFragment ----------------------------------------------------------------

{
  const picked = pickFragment(SONG, { rng: () => 0 });
  checkTrue("pickFragment: returns a fragment", Boolean(picked));
  checkTrue("pickFragment: 2-4 lines", picked.lines.length >= 2 && picked.lines.length <= 4);
}

{
  // rng() → 0 always lands on the very first candidate window generated.
  const first = pickFragment(SONG, { rng: () => 0 });
  check("pickFragment: rng=0 picks the first stanza's opening window", first.lines[0], "Un verso de prueba para el harness");
  check("pickFragment: rng=0 window has no context line (starts the stanza)", first.contextLine, null);
}

{
  // A window starting mid-stanza carries the line before it as context.
  const stanzas = splitStanzas(SONG);
  const midStart = pickFragment(stanzas[0].lines.join("\n"), { rng: () => 0.99 });
  checkTrue("pickFragment: a later window can carry a context line", midStart.contextLine !== null || midStart.lines[0] === stanzas[0].lines[0]);
}

check("pickFragment: too-short lyrics (every stanza is 1 line) → null", pickFragment("uno\n\ndos\n\ntres", { rng: () => 0 }), null);
check("pickFragment: empty text → null", pickFragment("", { rng: () => 0 }), null);

{
  // Chorus preference: a song where one line repeats across stanzas should be
  // chosen (as part of its window) noticeably more than 1-in-N chance over
  // many seeded draws — mirrors clip-steps.test.mjs's ~50%-over-4000 pattern.
  const chorusSong = [
    "Verso uno distinto",
    "Otro verso distinto",
    "",
    "Estribillo que se repite",
    "Otra vez el estribillo",
    "",
    "Verso dos distinto",
    "Algo más distinto",
    "",
    "Estribillo que se repite",
    "Otra vez el estribillo",
  ].join("\n");
  let seed = 42;
  function lcg() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 100000) / 100000;
  }
  let chorusHits = 0;
  const draws = 4000;
  for (let i = 0; i < draws; i++) {
    const picked = pickFragment(chorusSong, { rng: lcg });
    if (picked.lines.some((l) => l.toLowerCase().includes("estribillo"))) chorusHits++;
  }
  const ratio = chorusHits / draws;
  // 2 of 4 stanzas are the chorus, weighted 4x over the other two (weight 1
  // each) → expected ratio well above the unweighted 50%, safely below 100%.
  checkTrue(`pickFragment: chorus windows favored (ratio ${ratio.toFixed(2)} > 0.6)`, ratio > 0.6);
  checkTrue(`pickFragment: variety preserved (ratio ${ratio.toFixed(2)} < 0.97)`, ratio < 0.97);
}

// --- pickBlankIndices ------------------------------------------------------------

{
  const { words } = tokenize("Un verso de prueba para el harness");
  const chosen = pickBlankIndices(words, { rng: seq(0, 0, 0, 0, 0, 0, 0, 0) });
  checkTrue("pickBlankIndices: returns an array", Array.isArray(chosen));
  checkTrue("pickBlankIndices: 3-6 blanks", chosen.length >= 3 && chosen.length <= 6);
  const norms = chosen.map((i) => words[i].normalized);
  check("pickBlankIndices: no duplicate normalized answers", new Set(norms).size, norms.length);
  for (const i of chosen) {
    checkTrue(`pickBlankIndices: word "${words[i].text}" has ≥3 letters`, [...words[i].text].filter((c) => /[\p{L}\p{N}]/u.test(c)).length >= 3);
  }
}

{
  // "El" and "de" are too short (< 3 letters) to ever be picked.
  const { words } = tokenize("El de la ya no");
  check("pickBlankIndices: no eligible ≥3-letter distinct words → null", pickBlankIndices(words, { rng: () => 0 }), null);
}

{
  // One word repeated 3 times: only 1 distinct normalized candidate → null
  // (fewer than 3 distinct eligible words = too short to hide ≥3 words).
  const { words } = tokenize("amor amor amor");
  check("pickBlankIndices: only 1 distinct eligible word → null", pickBlankIndices(words, { rng: () => 0 }), null);
}

{
  // Exactly 3 distinct eligible words → usable at the floor (3), even though
  // the normal target is 4-6.
  const { words } = tokenize("amor dolor calor");
  const chosen = pickBlankIndices(words, { rng: () => 0.99 });
  check("pickBlankIndices: floor of 3 when only 3 distinct words exist", chosen.length, 3);
}

{
  // Spread: one blank per line when each line has an eligible candidate.
  const { words } = tokenize("primera linea larga\nsegunda linea larga\ntercera linea larga\ncuarta linea larga");
  const chosen = pickBlankIndices(words, { rng: seq(0.99, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7) });
  const lines = new Set(chosen.map((i) => words[i].line));
  checkTrue("pickBlankIndices: spreads across every line when possible", lines.size === 4);
}

// --- buildFragment -----------------------------------------------------------

{
  const built = buildFragment(SONG, { rng: () => 0 });
  checkTrue("buildFragment: builds a full spec", Boolean(built));
  checkTrue("buildFragment: exposes rawLines/words/blankIndices", Array.isArray(built.rawLines) && Array.isArray(built.words) && Array.isArray(built.blankIndices));
}

check("buildFragment: no usable lyrics → null (instrumental-shaped text)", buildFragment("", { rng: () => 0 }), null);
check("buildFragment: fragment too short to hide ≥3 words → null", buildFragment("la de\n\nel un", { rng: () => 0 }), null);

// --- createFragmentQuiz ------------------------------------------------------

{
  const built = buildFragment(SONG, { rng: () => 0 });
  const quiz = createFragmentQuiz(built);
  check("createFragmentQuiz: starts with nothing found", quiz.foundCount(), 0);
  checkTrue("createFragmentQuiz: not complete yet", !quiz.isComplete());

  const firstBlankWord = built.words[built.blankIndices[0]];
  const r1 = quiz.tryWord(firstBlankWord.text);
  checkTrue("createFragmentQuiz: exact word fills its blank", r1.ok);
  check("createFragmentQuiz: fills the right index", r1.index, built.blankIndices[0]);

  const upper = firstBlankWord.text.toUpperCase();
  const r1b = quiz.tryWord(upper); // already filled → no longer matches
  checkTrue("createFragmentQuiz: an already-filled blank cannot be refilled", !r1b.ok);

  const r2 = quiz.tryWord("xyznotaword");
  checkTrue("createFragmentQuiz: an unrelated word matches nothing", !r2.ok);
}

{
  const built = buildFragment("Café frío\ny nada más\n\nCafé frío\ny nada más", { rng: () => 0 });
  const quiz = createFragmentQuiz(built);
  const target = built.words[built.blankIndices[0]].text; // e.g. "Café" (accented)
  const deaccented = target.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const r = quiz.tryWord(deaccented);
  checkTrue("createFragmentQuiz: accent/case-insensitive match", r.ok);
}

{
  const built = buildFragment(SONG, { rng: () => 0 });
  const quiz = createFragmentQuiz(built);
  let calls = 0;
  let lastResult;
  while (!quiz.isComplete() && calls < 50) {
    lastResult = quiz.hint();
    calls++;
  }
  checkTrue("createFragmentQuiz: hint() alone can complete a fragment", quiz.isComplete());
  checkTrue("createFragmentQuiz: hintCalls() counts every use", quiz.hintCalls() > 0);
  checkTrue("createFragmentQuiz: final hint reports done", lastResult.done);
}

{
  const built = buildFragment(SONG, { rng: () => 0 });
  const quiz = createFragmentQuiz(built);
  quiz.revealAll();
  checkTrue("createFragmentQuiz: revealAll completes it", quiz.isComplete());
  check("createFragmentQuiz: revealAll costs no hint calls", quiz.hintCalls(), 0);
}

{
  const built = buildFragment(SONG, { rng: () => 0 });
  const quiz = createFragmentQuiz(built);
  const i = built.blankIndices[0];
  check("createFragmentQuiz: maskFor hides an unfilled blank", quiz.maskFor(i).includes("_"), true);
  quiz.hint();
  checkTrue("createFragmentQuiz: maskFor reveals more after a hint", quiz.maskFor(i) !== "_".repeat(quiz.maskFor(i).length));
}

// --- findFragmentTiming --------------------------------------------------------

const SYNCED = [
  { ms: 0, text: "Un verso de prueba para el harness" },
  { ms: 3000, text: "Otra línea que nadie va a cantar" },
  { ms: 6000, text: "Solo existe para llenar la letra" },
  { ms: 9500, text: "Segunda estrofa de relleno acá" },
];

{
  const t = findFragmentTiming(["Otra línea que nadie va a cantar", "Solo existe para llenar la letra"], SYNCED);
  checkTrue("findFragmentTiming: locates a matching run", Boolean(t));
  check("findFragmentTiming: startMs is the first matched line's ms", t.startMs, 3000);
  check("findFragmentTiming: duration runs to the next line (uncapped here)", t.durationMs, 6500);
}

check("findFragmentTiming: no synced lines → null", findFragmentTiming(["algo"], null), null);
check("findFragmentTiming: no match found → null", findFragmentTiming(["nunca dicho"], SYNCED), null);

{
  // Last synced line: no "next line" to bound it, falls back to the cap.
  const t = findFragmentTiming(["Segunda estrofa de relleno acá"], SYNCED, { capMs: 12000 });
  check("findFragmentTiming: last line falls back to the cap", t.durationMs, 12000);
}

{
  // A gap larger than the cap is clamped down to it.
  const gapSynced = [{ ms: 0, text: "una linea" }, { ms: 999999, text: "otra linea" }];
  const t = findFragmentTiming(["una linea"], gapSynced, { capMs: 12000 });
  check("findFragmentTiming: a huge gap is capped", t.durationMs, 12000);
}

// --- scoreFragment ---------------------------------------------------------------

{
  const s = scoreFragment({ totalBlanks: 5, foundCount: 5, hintCalls: 0, listenCalls: 0, remainingMs: FRAGMENT_TIMER_MS, timerMs: FRAGMENT_TIMER_MS });
  checkTrue("scoreFragment: full time left + no help + complete = perfect", s.perfect);
  checkTrue("scoreFragment: perfect implies completed", s.completed);
  check("scoreFragment: perfect score = 5*10 + 20 (full time bonus) + 15", s.points, 5 * 10 + 20 + 15);
}

{
  const s = scoreFragment({ totalBlanks: 5, foundCount: 5, hintCalls: 0, listenCalls: 0, remainingMs: 0, timerMs: FRAGMENT_TIMER_MS });
  checkTrue("scoreFragment: completed with no time left is still completed", s.completed);
  checkTrue("scoreFragment: no time left means no perfect time bonus, still perfect (no help used)", s.perfect);
  check("scoreFragment: zero time bonus", s.points, 5 * 10 + 0 + 15);
}

{
  const s = scoreFragment({ totalBlanks: 5, foundCount: 5, hintCalls: 1, listenCalls: 1, remainingMs: FRAGMENT_TIMER_MS, timerMs: FRAGMENT_TIMER_MS });
  checkTrue("scoreFragment: any help used is never perfect", !s.perfect);
  check("scoreFragment: help costs subtract", s.points, 5 * 10 + 20 - 4 - 6);
}

{
  const s = scoreFragment({ totalBlanks: 5, foundCount: 2, hintCalls: 0, listenCalls: 0, remainingMs: 0, timerMs: FRAGMENT_TIMER_MS });
  checkTrue("scoreFragment: a timeout with unfound blanks is not completed", !s.completed);
  check("scoreFragment: partial credit only for words found, no time bonus", s.points, 2 * 10);
}

{
  const s = scoreFragment({ totalBlanks: 3, foundCount: 0, hintCalls: 3, listenCalls: 3, remainingMs: 0, timerMs: FRAGMENT_TIMER_MS });
  check("scoreFragment: never goes negative", s.points, 0);
}

check("MAX_LISTENS_PER_FRAGMENT is a small bounded number", MAX_LISTENS_PER_FRAGMENT <= 3 && MAX_LISTENS_PER_FRAGMENT >= 1, true);

// --- summary -----------------------------------------------------------------

console.log(`lyrics-quiz.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
