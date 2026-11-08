// No-framework unit harness for src/lyrics-typing.js.
// Run with: node tests/lyrics-typing.test.mjs  (exit code 0 = all pass, non-zero = failure)
// Every lyric line below is invented; only single contraction tokens are real-world.

import { parseLyrics, addForms } from "../src/lyrics-parse.js";
import { createTypingGame, sanitizeTyped } from "../src/lyrics-typing.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const checkTrue = (name, value) => check(name, Boolean(value), true);
const checkFalse = (name, value) => check(name, Boolean(value), false);

const game = (text) => createTypingGame(parseLyrics({ text }));
const types = (events) => events.map((e) => e.type).join(",");
const count = (events, type) => events.filter((e) => e.type === type).length;
const revealedWords = (g, n) => Array.from({ length: n }, (_, i) => g.isRevealed(i)).join(",");

// --- the basics ------------------------------------------------------------

{
  const g = game("hola mundo");
  check("starts on the first word", g.cursor(), 0);
  const ev = g.type("hola");
  check("typing the exact word auto-reveals", g.isRevealed(0), true);
  check("reveal event carries the index", ev.find((e) => e.type === "reveal").index, 0);
  check("reveal how is typed", g.howRevealed(0), "typed");
  check("cursor advanced", g.cursor(), 1);
  check("buffer cleared", g.buffer(), "");
  check("partial typing is just typing", types(g.setBuffer("mun")), "typing");
  check("partial typing is visible", g.buffer(), "mun");
  const end = g.type("do");
  check("finishing the last word is done", types(end), "typing,reveal,done");
  checkTrue("isDone", g.isDone());
  check("cursor is -1 when done", g.cursor(), -1);
  check("done game ignores more input", g.setBuffer("x").length, 0);
}
{
  const g = game("hola mundo");
  g.type("hol");
  const back = g.setBuffer("ho");
  check("deleting is a typing event", types(back), "typing");
  check("deleting shrinks the buffer", g.buffer(), "ho");
}
{
  const g = game("hola mundo");
  const ev = g.setBuffer("hola ");
  check("a pasted string with a space still reveals once", count(ev, "reveal"), 1);
  check("space after reveal leaves the buffer empty", g.buffer(), "");
  check("accents and case in the word", createTypingGame(parseLyrics({ text: "Canción" })).type("CANCION").some((e) => e.type === "reveal"), true);
}
{
  check("sanitize keeps letters, digits and spaces", sanitizeTyped("¡ho-la 2!"), "hola 2");
  check("sanitize keeps accents", sanitizeTyped("canción"), "canción");
  check("sanitize collapses whitespace", sanitizeTyped("a \t b"), "a b");
  check("sanitize maps cyrillic", sanitizeTyped("еs"), "es");
}

// --- commit, miss, streak ----------------------------------------------------

{
  const g = game("amor azul cielo");
  g.type("amor");
  g.type("azu");
  const miss = g.setBuffer("azux ");
  check("a wrong word on space is a miss", types(miss), "miss");
  check("miss clears the buffer", g.buffer(), "");
  check("miss counts", g.stats().misses, 1);
  check("miss resets the streak", g.streak(), 0);
  check("miss keeps the same word", g.cursor(), 1);
  g.type("azul");
  check("streak restarts after the miss", g.streak(), 1);
  g.type("cielo");
  check("best streak", g.stats().bestStreak, 2);
}
{
  const g = game("amor azul");
  check("commit on an empty buffer is a no-op", g.commit().length, 0);
  check("commit on an empty buffer is not a miss", g.stats().misses, 0);
  g.setBuffer("amr");
  check("commit with a typo on a short word misses", types(g.commit()), "miss");
}
{
  const g = game("caminando despacio");
  const ev = g.setBuffer("camimando ");
  check("fuzzy accept on commit", types(ev), "reveal");
  check("fuzzy reveal counts as typed", g.howRevealed(0), "typed");
  const g2 = game("caminando despacio");
  check("two slips on a 9+ key still pass", types(g2.setBuffer("camimanda ")), "reveal");
  const g3 = game("casa verde");
  check("short words are never fuzzy", types(g3.setBuffer("caso ")), "miss");
}

// --- pa' / para / pa -----------------------------------------------------------

{
  const g = game("pa' ti");
  g.type("para");
  check("pa' typed para: revealed", g.isRevealed(0), true);
  check("pa' typed para: ra swallowed, no miss", g.stats().misses, 0);
  check("pa' typed para: cursor on the next word", g.cursor(), 1);
  check("pa' typed para: nothing leaks into the buffer", g.buffer(), "");
  check("pa' typed para: the swallowed tail", g.tail(), "ra");
  g.type(" ");
  g.type("ti");
  checkTrue("pa' typed para: song completes", g.isDone());
}
{
  const g = game("pa' ti");
  g.type("pa");
  check("pa' typed pa", g.isRevealed(0), true);
  check("pa' typed pa: no swallowed chars", g.tail(), "");
}
{
  const g = game("para ti");
  g.type("pa");
  check("written para: pa alone waits", g.isRevealed(0), false);
  g.type("ra");
  check("written para: finishing it reveals", g.isRevealed(0), true);
  check("written para: on word 2 with a clean buffer", [g.cursor(), g.buffer()].join(), "1,");
}
{
  const g = game("para ti");
  g.type("para");
  check("written para typed para", g.isRevealed(0), true);
  check("written para typed para: cursor", g.cursor(), 1);
}

// --- tail swallow / flush ----------------------------------------------------------

{
  const g = game("to' bien");
  g.type("to");
  check("to' revealed on to", g.isRevealed(0), true);
  g.type("do");
  check("do swallowed after to", g.tail(), "do");
  check("tail does not touch the next word", g.buffer(), "");
  g.type(" ");
  check("space clears the tail", g.tail(), "");
  g.type("bien");
  checkTrue("to' typed todo, then bien: done", g.isDone());
  check("no misses along the way", g.stats().misses, 0);
}
{
  const g = game("vamo' ya");
  g.type("vamos");
  check("vamo' typed vamos: s swallowed", g.tail(), "s");
  check("vamo' typed vamos: no miss", g.stats().misses, 0);
  g.type(" ya");
  checkTrue("vamo' vamos ya: done", g.isDone());
}
{
  const g = game("vamo' ya");
  g.type("vamo");
  g.type(" ya");
  checkTrue("vamo' typed vamo: done", g.isDone());
}
{
  const g = game("to' dame");
  g.type("todam");
  check("a char that breaks the tail flushes tail+char into the next word", g.buffer(), "dam");
  check("the tail is gone after the flush", g.tail(), "");
  check("to' still revealed", g.isRevealed(0), true);
  g.type("e");
  checkTrue("flushed text completes the next word", g.isDone());
  check("flush produced no miss", g.stats().misses, 0);
}
{
  const g = game("pa' mi");
  g.type("pam");
  check("pa' then m: m flushes into the next word", g.buffer(), "m");
  check("pa' then m: pa' revealed", g.isRevealed(0), true);
  g.type("i");
  checkTrue("pa' m i: done", g.isDone());
}
{
  const g = game("ve' yo ya");
  g.type("vez");
  check("ve' typed vez: z swallowed", g.tail(), "z");
  g.type("y");
  check("ve' then y: y goes to the next word", g.buffer(), "y");
  g.type("o");
  check("ve' y o: second word revealed", g.isRevealed(1), true);
}
{
  // Phonetic spelling reveals through the key, the tail follows the key too.
  const g = game("vamos ya");
  g.type("bamos");
  check("bamos reveals vamos", g.isRevealed(0), true);
  check("bamos: the closing s is swallowed", g.tail() === "s" || g.tail() === "", true);
  g.type(" ya");
  checkTrue("bamos ya: done", g.isDone());
  check("bamos ya: no misses", g.stats().misses, 0);
}
{
  const g = game("haces eso");
  g.type("ases");
  check("ases reveals haces", g.isRevealed(0), true);
  g.type(" eso");
  checkTrue("ases eso: done", g.isDone());
}

// --- two words behind one apostrophe --------------------------------------------------

{
  const typed = (text, keys) => { const g = game(text); g.type(keys); return g; };
  let g = typed("encima'e ti", "encima");
  check("encima alone fills its slot", g.isRevealed(0), true);
  check("encima: the cursor is on e", g.cursor(), 1);
  check("encima: clean buffer", g.buffer(), "");
  for (const rest of [" de ti", " e ti", "de ti", "e ti"]) {
    g = typed("encima'e ti", `encima${rest}`);
    check(`encima + ${JSON.stringify(rest)} finishes with no misses`, [g.isDone(), g.stats().misses].join(), "true,0");
  }
  for (const [text, keys] of [
    ["salgo'el club", "salgo del club"], ["salgo'el club", "salgo el club"], ["salgo'el club", "salgoel club"],
    ["vo'a ir", "voy a ir"], ["vo'a ir", "voa ir"], ["vo'a ir", "vo a ir"],
    ["pa'l club", "para el club"], ["pa'l club", "pal club"], ["pa'l club", "pa el club"],
    ["to'l club", "todo el club"], ["to'l club", "tol club"],
    ["pa'llá voy", "para alla voy"], ["pa'llá voy", "palla voy"],
    ["pa'lante voy", "para adelante voy"], ["pa'lante voy", "palante voy"],
  ]) {
    g = typed(text, keys);
    check(`${text} typed ${keys}`, [g.isDone(), g.stats().misses].join(), "true,0");
  }
  g = typed("encima'e ti", "encim");
  check("a part of the first word doesn't count", g.isRevealed(0), false);
  check("first word: a wrong second word misses", types(typed("encima'e ti", "encima").setBuffer("xx ")), "miss");
  g = typed("la'o ti", "lado ti");
  check("one word eaten inside stays one word", [g.isDone(), g.stats().misses, g.stats().total].join(), "true,0,2");
}

// --- multi-word forms, as the AI can suggest them: hold --------------------------------

{
  const parsed = parseLyrics({ text: "canso ti" });
  addForms(parsed.words[0], ["cansado de"]);
  const g = createTypingGame(parsed);
  g.type("cansado");
  check("first word of a phrase alone does not reveal", g.isRevealed(0), false);
  check("space holds", types(g.setBuffer("cansado ")), "hold");
  check("hold keeps the text", g.buffer(), "cansado ");
  check("hold is not a miss", g.stats().misses, 0);
  check("second word reveals", count(g.type("de"), "reveal"), 1);
}
{
  const parsed = parseLyrics({ text: "canso ti" });
  addForms(parsed.words[0], ["cansado de"]);
  const g = createTypingGame(parsed);
  g.type("cansado ");
  check("hold then a wrong continuation misses", count(g.type("perro "), "miss"), 1);
  check("the miss clears the held text", g.buffer(), "");
  check("the word stays open", g.isRevealed(0), false);
}

// --- other contractions ------------------------------------------------------------------

{
  const g = game("al la'o");
  g.type("al lado");
  checkTrue("la'o typed lado", g.isDone());
  const g2 = game("al la'o");
  g2.type("al lao");
  checkTrue("la'o typed lao", g2.isDone());
  const g3 = game("calla'o ya");
  g3.type("callado");
  check("calla'o typed callado", g3.isRevealed(0), true);
  const g4 = game("ve' ya");
  g4.type("vez");
  check("ve' typed vez", g4.isRevealed(0), true);
  const g5 = game("'toy bien");
  g5.type("estoy");
  check("'toy typed estoy", g5.isRevealed(0), true);
  check("'toy typed estoy: no miss", g5.stats().misses, 0);
}
{
  const g = game("due-e-e-elen");
  g.type("duelen");
  checkTrue("due-e-e-elen typed duelen", g.isDone());
  const g2 = game("A-a-ando");
  g2.type("ando");
  checkTrue("a-a-ando typed ando", g2.isDone());
}
{
  const g = game("a las 10:00");
  g.type("a las diez");
  checkTrue("10:00 typed diez", g.isDone());
  const g2 = game("somos 2");
  g2.type("somos dos");
  checkTrue("2 typed dos", g2.isDone());
  const g3 = game("my baby");
  g3.type("my beibi");
  checkTrue("baby typed beibi", g3.isDone());
}
{
  const g = game("еs tarde");
  g.type("es tarde");
  checkTrue("cyrillic word is typeable", g.isDone());
  const g2 = game("hola￼ mundo");
  g2.type("hola mundo");
  checkTrue("U+FFFC junk does not block", g2.isDone());
  const g3 = game("L a k e n o s h i");
  g3.type("lakenoshi");
  checkTrue("spaced letters typed joined", g3.isDone());
  const g4 = game("L a k e n o s h i");
  g4.type("l a k e n o s h i");
  checkTrue("spaced letters typed spaced", g4.isDone());
}

// --- dead-key accents ------------------------------------------------------------------------

{
  const g = game("está bien");
  g.type("est");
  const dead = g.setBuffer("est´");
  check("a dead-key mark alone changes nothing", g.buffer(), "est");
  check("a dead-key mark alone causes no event", dead.length, 0);
  const ev = g.setBuffer("está");
  check("the composed accent completes the word", g.isRevealed(0), true);
  check("the composed accent reveals", count(ev, "reveal"), 1);
  const g2 = game("canción");
  g2.setBuffer("canci´");
  g2.setBuffer("canció");
  g2.setBuffer("canción");
  checkTrue("an accent in the middle works", g2.isDone());
}

// --- fillers and backing never need typing ------------------------------------------------------

{
  const g = game("(eh-eh) hola eh-eh (mundo) yeah-yeah\nuy mira");
  check("only real words count", g.stats().total, 2);
  g.type("hola");
  check("hola revealed", g.isRevealed(0), true);
  check("cursor skips over the filler and backing to the next line", g.cursor(), 1);
  g.type("mira");
  checkTrue("song done without typing fillers or backing", g.isDone());
}
{
  const g = game("eh-eh yeah-yeah");
  checkTrue("a song of fillers only is done", g.isDone());
  check("fillers only: the first call says done", types(g.setBuffer("a")), "done");
  check("fillers only: done only once", g.setBuffer("b").length, 0);
}
{
  check("empty text: done", game("").isDone(), true);
  check("empty text: setBuffer reports done", types(game("").setBuffer("x")), "done");
  check("empty text: stats", game("").stats().total, 0);
  check("empty text: pct is 0", game("").stats().pct, 0);
  check("empty text: hint is done too", types(game("").hint()), "done");
}
{
  const g = game("la la la");
  check("a bare la is a word, not a filler", g.stats().total, 3);
  const g2 = game("a e");
  check("bare vowels are words", g2.stats().total, 2);
  const g3 = game("a e o");
  check("three single letters in a row are one spaced word", g3.stats().total, 1);
}

// --- parens: visibility of backing --------------------------------------------------------------------

{
  const g = game("Dale (Dale, guayame), dale");
  check("backing parts do not count as words", g.stats().total, 2);
  // tokens: 0 Dale, 1 (Dale, 2 guayame), 3 dale
  check("backing hidden before its preceding word is revealed", g.isBackingVisible(0, 1), false);
  g.type("dale");
  check("backing shows once the words before it are revealed", g.isBackingVisible(0, 1), true);
  check("the whole backing run shows", g.isBackingVisible(0, 2), true);
}
{
  const g = game("(Ahora) vamos\nsegunda linea\n(coro) final");
  check("leading backing of the cursor line is visible", g.isBackingVisible(0, 0), true);
  check("leading backing of a later line stays hidden", g.isBackingVisible(2, 0), false);
  g.type("vamos");
  g.type("segunda linea");
  check("leading backing shows when the cursor reaches its line", g.isBackingVisible(2, 0), true);
}
{
  const g = game("uno dos\n(eco) tres cuatro\nfinal");
  g.moveCursor(0);
  g.type("uno dos");
  g.moveCursor(4);
  check("backing before any word, cursor on a later line", g.isBackingVisible(1, 0), true);
  const h = game("uno dos\ntres (eco)\n(fin) cuatro\nquinto");
  check("earlier lines open: backing at the start of a later line hidden", h.isBackingVisible(2, 0), false);
  h.type("uno dos tres");
  check("one line left to go: still hidden", h.isBackingVisible(2, 0), true);
}
{
  const g = game("tres (eco) y mas");
  check("unbalanced paren still hides until the words before reveal", g.isBackingVisible(0, 1), false);
  const g2 = game("hola (que si no");
  check("unbalanced: words", g2.stats().total, 1);
  g2.type("hola");
  check("unbalanced: backing visible after the word", g2.isBackingVisible(0, 1), true);
  check("unbalanced: still done", g2.isDone(), true);
}

// --- chorus auto-fill -----------------------------------------------------------------------------------

{
  const g = game("uno dos tres\ncuatro cinco seis\nuno dos tres\nsiete ocho");
  g.type("uno dos ");
  const ev = g.type("tres");
  const rep = ev.find((e) => e.type === "reveal" && e.repeated);
  checkTrue("completing a line reports the repeated words", rep);
  check("repeated indexes", rep.repeated.join(","), "6,7,8");
  check("repeated words are marked repeat", g.howRevealed(6), "repeat");
  check("the cursor is on the next unrevealed word", g.cursor(), 3);
  g.type("cuatro cinco seis");
  check("cursor skips the already filled chorus", g.cursor(), 9);
  g.type("siete ocho");
  checkTrue("done", g.isDone());
  const st = g.stats();
  check("stats: typed", st.typed, 8);
  check("stats: repeated", st.repeated, 3);
  check("stats: pct counts typed and repeated", st.pct, 100);
}
{
  // The chorus is typed first at the bottom: earlier lines fill, cursor never goes back.
  const g = game("uno dos\ncuatro cinco\nuno dos\nsiete ocho");
  g.moveCursor(4);
  const ev = g.type("uno dos");
  const rep = ev.find((e) => e.repeated);
  check("earlier repeats fill backwards", rep.repeated.join(","), "0,1");
  check("cursor never moves backward after a repeat", g.cursor(), 6);
  check("earlier unrevealed lines remain reachable", g.isRevealed(2), false);
}
{
  const g = game("uno dos\nuno dos\nuno dos");
  g.type("uno dos");
  checkTrue("a thrice repeated line fills all of them", g.isDone());
  check("done after the chorus", g.stats().repeated, 4);
}
{
  const g = game("(eh)\n(eh)\nhola");
  g.type("hola");
  checkTrue("lines with no words never trigger the chorus", g.isDone());
}
{
  const g = game("vamo' ya\nvamos ya\nfin");
  g.type("vamos ya");
  check("urban spelling variants share a signature", g.isRevealed(2), true);
}

// --- the lyric decides: whole words stay whole, cut words accept the cut ------------
{
  const reveals = (text, typed) => { const g = game(text); g.type(typed); return g.isRevealed(0); };
  // Whole in the lyric: only the whole word.
  for (const [word, cut] of [["que", "q"], ["que", "qu"], ["todo", "to"], ["para", "pa"], ["nada", "na"], ["es", "e"], ["vez", "ve"], ["vamos", "vamo"], ["vamos", "bamo"], ["verdad", "verda"], ["pasado", "pasao"], ["los", "lo"]]) {
    check(`${word}: ${cut} does not reveal`, reveals(`${word} ahora`, cut), false);
    const g = game(`${word} ahora`);
    g.type(`${cut} `);
    check(`${word}: ${cut} + space is a miss`, [g.isRevealed(0), g.stats().misses].join(), "false,1");
    check(`${word}: the miss clears the slot`, g.buffer(), "");
  }
  for (const word of ["que", "todo", "para", "nada", "es", "vez", "vamos", "verdad", "pasado", "los"]) {
    check(`${word}: typing it whole reveals with no space`, reveals(`${word} ahora`, word), true);
  }
  check("haces: spelled by ear still counts", reveals("haces eso", "ases"), true);
  check("vamos: spelled by ear still counts", reveals("vamos ya", "bamos"), true);
  check("caminando: a typo on space still counts", (() => { const g = game("caminando ya"); g.type("camimando "); return g.isRevealed(0); })(), true);

  // Cut in the lyric: the short form, instantly, or the full word.
  for (const [word, short] of [["pa'", "pa"], ["to'", "to"], ["na'", "na"], ["vamo'", "vamo"], ["ve'", "ve"], ["la'o", "lao"]]) {
    check(`${word}: ${short} reveals with no space`, reveals(`${word} ahora`, short), true);
  }
  for (const [word, full] of [["pa'", "para"], ["to'", "todo"], ["na'", "nada"], ["vamo'", "vamos"], ["ve'", "vez"], ["la'o", "lado"]]) {
    const g = game(`${word} ahora`);
    g.type(`${full} ahora`);
    check(`${word}: typing ${full} lands clean`, [g.isDone(), g.stats().misses].join(), "true,0");
  }
  check("todo': to is shorter than the lyric, no reveal", reveals("todo' bien", "to"), false);
  check("todo': todo reveals", reveals("todo' bien", "todo"), true);
  check("todo': todos reveals", (() => { const g = game("todo' bien"); g.type("todos bien"); return [g.isDone(), g.stats().misses].join(); })(), "true,0");
  // Numbers aren't words the lyric could cut.
  check("10:00: 10 still reveals", reveals("10:00 ya", "10"), true);
  check("2: dos still reveals", reveals("2 veces", "dos"), true);
}

// --- a word typed ahead goes where it belongs ---------------------------------------
{
  let g = game("y pensé en ti");
  g.type("pensé");
  check("ahead: pensé lands on its slot", g.isRevealed(1), true);
  check("ahead: the skipped y stays open", g.isRevealed(0), false);
  check("ahead: the cursor goes on from there", g.cursor(), 2);
  check("ahead: no miss", g.stats().misses, 0);
  g.type(" en ti");
  check("ahead: the rest goes on normally", [g.isRevealed(2), g.isRevealed(3)].join(), "true,true");
  check("ahead: the skipped word can still be typed", (g.moveCursor(0), g.type("y"), g.isDone()), true);

  g = game("logré lo que quise");
  g.type("lo");
  check("ahead: lo stays in logré, it starts it", [g.isRevealed(0), g.isRevealed(1), g.buffer()].join(), "false,false,lo");
  g.type("gré");
  check("ahead: logré finishes in its own slot", [g.isRevealed(0), g.isRevealed(1)].join(), "true,false");

  g = game("y la luna sale hoy");
  g.type("sale");
  check("ahead: three words ahead is in range", g.isRevealed(3), true);
  g = game("y la luna sale hoy");
  g.type("hoy ");
  check("ahead: four words ahead is out of range", [g.isRevealed(4), g.stats().misses].join(), "false,1");

  g = game("y amigo a casa");
  g.type("a");
  check("ahead: waits while a longer word ahead could be typed", g.isRevealed(2), false);
  g.type("migo");
  check("ahead: amigo goes to its slot", [g.isRevealed(1), g.isRevealed(2)].join(), "true,false");

  g = game("y siempre te quiero");
  g.type("seimpre");
  check("ahead: only exact words jump, a slip does not", g.isRevealed(1), false);

  g = game("que pasa");
  g.type("q");
  check("ahead: hints and cuts still apply ahead too", g.isRevealed(0), false);

  g = game("ya la luna");
  g.hint();
  g.type("luna ");
  check("ahead: never with hint letters locked in", [g.isRevealed(2), g.stats().misses].join(), "false,1");

  g = game("cuando te vi");
  g.type("te ");
  check("ahead: a space also jumps", g.isRevealed(1), true);
}

// --- two neighboring letters swapped ------------------------------------------------
{
  const reveals = (text, typed) => { const g = game(text); g.type(typed); return g.isRevealed(0); };
  check("swap: siemper is siempre", reveals("siempre ya", "siemper"), true);
  check("swap: seimpre is siempre", reveals("siempre ya", "seimpre"), true);
  check("swap: counts as typed", (() => { const g = game("siempre ya"); g.type("siemper"); return g.howRevealed(0); })(), "typed");
  check("swap: two swaps are not a slip", reveals("siempre ya", "seimper "), false);
  check("swap: far apart letters are not a slip", reveals("siempre ya", "eiempra "), false);
  check("swap: short words never", reveals("el ya", "le "), false);
  check("swap: 4 letters work", reveals("pero ya", "preo"), true);
  check("swap: the first letters too", reveals("nunca ya", "unnca"), true);
}

// --- stats breakdown for the history ------------------------------------------------
{
  const g = game("y pensé en ti otra vez");
  g.type("pensé ");
  g.hint();
  g.hint();
  g.revealLine();
  const st = g.stats();
  check("stats: a jump is counted", st.jumps, 1);
  check("stats: hint, line and open are split", [st.byHint, st.byLine, st.givenUp, st.open].join(), "1,4,0,0");
  const g2 = game("hola mundo cruel");
  g2.type("hola ");
  g2.giveUp();
  check("stats: given up words are their own count", [g2.stats().givenUp, g2.stats().typed].join(), "2,1");
}

// --- locked hint letters --------------------------------------------------------------
{
  const pick = () => game("dale fuerte");
  let g = pick();
  g.hint();
  check("locked hint: typing the rest finishes the word", (g.type("ale"), g.isRevealed(0)), true);
  check("locked hint: a word finished with help is not typed", g.howRevealed(0), "hint");

  g = pick();
  g.hint();
  g.type("d");
  check("locked hint: retyping the letter doesn't double it", g.buffer(), "");
  check("locked hint: retyped letter is confirmed", g.hintParts(0).done, "d");
  g.type("ale");
  check("locked hint: the whole word typed from the start works", g.isRevealed(0), true);

  g = pick();
  g.hint();
  g.type("dx");
  check("locked hint: other letters go after it", g.buffer(), "x");
  g.setBuffer("");
  g.setBuffer("");
  check("locked hint: erasing never removes the letter", g.hintText(0), "d");
  check("locked hint: buffer is really empty", g.buffer(), "");
  g.type("ale");
  check("locked hint: still completes after erasing", g.isRevealed(0), true);

  g = pick();
  g.hint();
  g.type("zz");
  g.commit();
  check("locked hint: a miss keeps the hint", g.hintText(0), "d");
  g.type("dale");
  check("locked hint: full retype works after a miss", g.isRevealed(0), true);

  g = pick();
  g.type("da");
  g.hint();
  check("hint after correct letters extends them", g.hintText(0), "dal");
  check("hint after correct letters clears the buffer", g.buffer(), "");

  g = pick();
  g.type("xx");
  g.hint();
  check("hint after wrong letters clears them", g.buffer(), "");
  check("hint after wrong letters gives the first letter", g.hintText(0), "d");
}

// --- hints, line reveal, navigation, give up --------------------------------------------------------------

{
  const g = game("hola mundo");
  check("hint level starts at 0", g.hintLevel(0), 0);
  g.hint();
  check("hint raises the level", g.hintLevel(0), 1);
  check("hint text shows the first letter", g.hintText(0), "h");
  g.hint();
  check("hint text grows", g.hintText(0), "ho");
  g.hint();
  g.hint();
  check("the full length hint reveals", g.isRevealed(0), true);
  check("revealed by hint", g.howRevealed(0), "hint");
  check("hint: cursor advanced", g.cursor(), 1);
  check("hint does not count as typed", g.stats().helped, 1);
}
{
  const g = game("a ti");
  const ev = g.hint();
  check("a one letter word is revealed by the first hint", types(ev), "reveal");
}
{
  const g = game("uno dos tres cuatro\ncinco seis");
  g.type("uno");
  check("streak before help", g.streak(), 1);
  g.hint();
  g.hint();
  g.hint();
  g.hint();
  g.hint();
  check("a hint reveal resets the streak", g.streak(), 0);
  check("streak only counts typed", g.stats().bestStreak, 1);
  const ev = g.revealLine();
  check("revealLine reveals the rest of the current line", revealedWords(g, 4), "true,true,true,true");
  check("revealLine events", count(ev, "reveal"), 2);
  check("revealLine how", g.howRevealed(3), "line");
  check("revealLine moves the cursor to the next line", g.cursor(), 4);
  check("revealLine does not count as typed", g.stats().helped, 3);
}
{
  const g = game("uno dos tres");
  check("nextWord moves forward", g.nextWord().length, 1);
  check("nextWord cursor", g.cursor(), 1);
  g.nextWord();
  g.nextWord();
  check("nextWord wraps", g.cursor(), 0);
  g.prevWord();
  check("prevWord wraps backwards", g.cursor(), 2);
  g.type("tres");
  g.prevWord();
  check("prevWord skips revealed words", g.cursor(), 1);
  g.type("d");
  check("typing is in the current word (buffer kept until Tab)", g.buffer(), "d");
  g.nextWord();
  check("moving the cursor clears the buffer", g.buffer(), "");
  check("moveCursor on a revealed word is ignored", g.moveCursor(2).length, 0);
  check("moveCursor on an open word", g.moveCursor(0).length, 1);
  check("moveCursor lands", g.cursor(), 0);
  check("moveCursor out of range is ignored", g.moveCursor(99).length, 0);
}
{
  const g = game("uno dos tres cuatro");
  g.type("uno");
  const ev = g.giveUp();
  check("giveUp reveals everything", g.isDone(), true);
  check("giveUp ends with done", types(ev), "done");
  check("giveUp marks the words", g.howRevealed(3), "giveup");
  check("giveUp keeps typed ones typed", g.howRevealed(0), "typed");
  const st = g.stats();
  check("giveUp stats: typed", st.typed, 1);
  check("giveUp stats: helped", st.helped, 3);
  check("giveUp stats: pct", st.pct, 25);
  check("giveUp: cursor", g.cursor(), -1);
}

// --- stats ------------------------------------------------------------------------------------------------------

{
  const g = game("uno dos tres");
  g.type("uno");
  g.setBuffer("xx ");
  g.type("dos");
  const st = g.stats();
  check("stats: total", st.total, 3);
  check("stats: typed", st.typed, 2);
  check("stats: misses", st.misses, 1);
  check("stats: bestStreak", st.bestStreak, 1);
  check("stats: pct", st.pct, 67);
}

// --- summary --------------------------------------------------------------------------------------------------------

console.log(`lyrics-typing.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
