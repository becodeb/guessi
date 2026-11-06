// Unit harness for src/typing-input.js: the hidden field while an on-screen
// keyboard composes a word. Run with: node tests/typing-input.test.mjs
// Every lyric line is invented.

import { parseLyrics } from "../src/lyrics-parse.js";
import { createTypingGame } from "../src/lyrics-typing.js";
import { createInputFeed, feedInput, offsetFor } from "../src/typing-input.js";

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (Object.is(actual, expected)) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** A field + feed + game, driven the way the game drives them. */
function rig(text) {
  const game = createTypingGame(parseLyrics({ text }));
  const field = { value: "", writes: 0 };
  const feed = createInputFeed();
  let composing = false;
  const api = {
    game, field, feed,
    start() { composing = true; feed.settle(field.value, game.buffer()); },
    // The keyboard replaces the composing text; the page must not write.
    compose(value) {
      field.value = value;
      const out = feedInput(field, feed, game, composing);
      if (out.write) { field.writes++; field.value = game.buffer(); }
      return out.events;
    },
    end() {
      composing = false;
      field.value = game.buffer();
      field.writes++;
      feed.reset();
    },
    writes: () => field.writes,
  };
  return api;
}

// --- offsetFor -----------------------------------------------------------------

check("offset: whole value is the buffer", offsetFor("hola", "hola"), 0);
check("offset: swallowed tail leaves nothing", offsetFor("todo", ""), 4);
check("offset: after a space", offsetFor("todo sol", "sol"), 5);
check("offset: keeps a trailing space of a held word", offsetFor("voy ", "voy "), 0);
check("offset: punctuation does not count", offsetFor("ho,la", "hola"), 0);
check("offset: nothing matches falls back to the length", offsetFor("abc", "zz"), 1);

// --- a composition grows one letter at a time ---------------------------------

{
  const r = rig("hola mundo cruel");
  r.start();
  r.compose("h");
  r.compose("ho");
  r.compose("hol");
  check("growing: buffer follows", r.game.buffer(), "hol");
  check("growing: not revealed yet", r.game.isRevealed(0), false);
  r.compose("hola");
  check("growing: revealed on the last letter", r.game.isRevealed(0), true);
  check("growing: cursor advanced", r.game.cursor(), 1);
  check("growing: buffer empty", r.game.buffer(), "");
  check("growing: never wrote into the field", r.writes(), 0);
  check("growing: field still holds the composing text", r.field.value, "hola");
  r.end();
  check("end: field mirrors the buffer", r.field.value, "");
  check("end: offset reset", r.feed.offset(), 0);
  r.start();
  r.compose("m");
  r.compose("mu");
  check("next word after the composition ended", r.game.buffer(), "mu");
}

// --- the same composition carries on into the next word -----------------------

{
  const r = rig("hola mundo tal");
  r.start();
  r.compose("hola");
  r.compose("hola ");
  r.compose("hola m");
  r.compose("hola mun");
  check("same composition: second word buffered", r.game.buffer(), "mun");
  check("same composition: first revealed", r.game.isRevealed(0), true);
  r.compose("hola mundo");
  check("same composition: second revealed", r.game.isRevealed(1), true);
  check("same composition: cursor on the third", r.game.cursor(), 2);
  check("same composition: no writes", r.writes(), 0);
}

// --- a swallowed tail ----------------------------------------------------------

{
  // Spelled by ear, `bamo` already sounds like `vamos`; the final s is the tail.
  const r = rig("mira vamos se va");
  r.start();
  for (const v of ["m", "mi", "mir", "mira", "mira ", "mira b", "mira ba", "mira bam", "mira bamo"]) r.compose(v);
  check("tail: `bamo` reveals vamos", r.game.isRevealed(1), true);
  r.compose("mira bamos");
  check("tail: bamos does not leak into the next word", r.game.buffer(), "");
  check("tail: swallowed", r.game.tail(), "s");
  check("tail: cursor still on the next word", r.game.cursor(), 2);
  r.compose("mira bamos ");
  r.compose("mira bamos s");
  check("tail: next word starts clean", r.game.buffer(), "s");
}

// --- deleting -------------------------------------------------------------------

{
  const r = rig("hola mundo cruel");
  r.start();
  r.compose("hol");
  r.compose("ho");
  check("delete: buffer shrinks", r.game.buffer(), "ho");
  r.compose("h");
  r.compose("");
  check("delete: all the way", r.game.buffer(), "");
  r.compose("hol");
  r.compose("hola");
  check("delete: retyping works", r.game.isRevealed(0), true);
}

{
  const r = rig("mira vamos se va");
  r.start();
  for (const v of ["mira", "mira ", "mira bamo", "mira bamos"]) r.compose(v);
  check("delete into tail: swallowed before", r.game.tail(), "s");
  r.compose("mira bamo");
  check("delete into tail: tail shrinks", r.game.tail(), "");
  check("delete into tail: nothing leaks", r.game.buffer(), "");
  r.compose("mira bamos");
  check("delete into tail: retyping is swallowed again", r.game.tail(), "s");
  check("delete into tail: buffer still empty", r.game.buffer(), "");
}

{
  // Erasing into the revealed word itself, then going on.
  const r = rig("hola mundo cruel");
  r.start();
  r.compose("hola");
  r.compose("hol");
  check("delete into the word: it stays revealed", r.game.isRevealed(0), true);
  check("delete into the word: no buffer", r.game.buffer(), "");
  r.compose("hola");
  check("delete into the word: retyping the letter is swallowed", r.game.buffer(), "");
}

// --- outside a composition it is the old contract ------------------------------

{
  const r = rig("hola mundo");
  r.compose("ho");
  check("plain: buffer", r.game.buffer(), "ho");
  check("plain: written back", r.writes(), 1);
  r.compose("hola");
  check("plain: revealed", r.game.isRevealed(0), true);
  check("plain: field emptied", r.field.value, "");
}

// --- an action in the middle of a composition ---------------------------------

{
  const r = rig("hola mundo cruel");
  r.start();
  r.compose("hxl");
  r.game.hint(); // the pista button: the buffer is cleared behind the keyboard's back
  r.feed.settle(r.field.value, r.game.buffer());
  check("action: field untouched", r.field.value, "hxl");
  r.compose("hxla");
  check("action: only what came after is typed", r.game.buffer(), "a");
  check("action: the hint stays", r.game.hintLevel(0), 1);
}

console.log(`typing-input.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
