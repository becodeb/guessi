// Pure, deterministic typing engine for the lyrics game. No DOM, no I/O.
//
// Input contract: the UI keeps a hidden <input> and calls
// `game.setBuffer(input.value)` on every `input` event, then writes
// `game.buffer()` back into the input when it differs. The engine only ever
// compares the new value with its own buffer, so characters it swallowed
// (the tail) never come back.
//
// Hint letters are a locked prefix of the word: they live outside the buffer,
// so they can't be erased, and what the player typed is always judged as
// hint + buffer. Retyping a hint letter confirms it instead of doubling it.
//
// While an on-screen keyboard is composing a word the field must not be
// written to: src/typing-input.js keeps an offset into the field's value and
// hands this engine only the part past it.

import {
  acceptsWord, fuzzyAccepts, holdsWord, isCutOfWhole, plain, mapHomoglyphs, swappedAccepts,
} from "./lyrics-parse.js";

/** Keep letters, digits and single spaces (accents stay for display). */
export function sanitizeTyped(value) {
  return mapHomoglyphs(String(value ?? ""))
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

const isSpace = (c) => c === " ";

export function createTypingGame(parsed) {
  const lines = parsed?.lines ?? [];
  const words = parsed?.words ?? [];
  const total = words.length;

  const revealed = new Array(total).fill(false);
  const how = new Array(total).fill(null); // typed|hint|line|repeat|giveup
  const hints = new Array(total).fill(0);
  const confirmed = new Array(total).fill(0); // hint letters the player retyped
  const lineWords = lines.map(() => []);
  words.forEach((w, i) => lineWords[w.line]?.push(i));

  const state = {
    cursor: 0,
    buffer: "",
    tail: null, // { index, typed, swallowed }
    streak: 0,
    bestStreak: 0,
    misses: 0,
    jumps: 0, // words typed ahead of the cursor
    doneEmitted: false,
  };

  const revealedCount = () => revealed.reduce((n, r) => n + (r ? 1 : 0), 0);
  const isDone = () => revealedCount() === total;

  function nextUnrevealed(from, step = 1, wrap = true) {
    if (total === 0) return -1;
    for (let k = 0; k < total; k++) {
      let i = from + step * k;
      if (!wrap && (i < 0 || i >= total)) return -1;
      i = ((i % total) + total) % total;
      if (!revealed[i]) return i;
    }
    return -1;
  }

  state.cursor = nextUnrevealed(0);

  function lineComplete(l) {
    return lineWords[l].every((i) => revealed[i]);
  }

  function setRevealed(i, mode) {
    revealed[i] = true;
    how[i] = mode;
    if (mode === "typed") {
      state.streak++;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
    } else if (mode !== "repeat") {
      state.streak = 0;
    }
  }

  // Chorus: a completed line fills every other line with the same signature.
  function propagate(l) {
    const sig = lines[l]?.signature;
    if (!sig || !lineComplete(l)) return [];
    const repeated = [];
    lines.forEach((line, m) => {
      if (m === l || line.signature !== sig || lineComplete(m)) return;
      for (const i of lineWords[m]) {
        if (!revealed[i]) {
          setRevealed(i, "repeat");
          repeated.push(i);
        }
      }
    });
    return repeated;
  }

  function settleCursor() {
    if (state.cursor >= 0 && revealed[state.cursor]) {
      state.cursor = nextUnrevealed(state.cursor + 1);
    }
  }

  // Reveals word `i`, advances the cursor and reports what happened.
  function reveal(i, mode, events) {
    setRevealed(i, mode);
    const repeated = propagate(words[i].line);
    settleCursor();
    const event = { type: "reveal", index: i, how: mode };
    if (repeated.length > 0) event.repeated = repeated;
    events.push(event);
    if (isDone() && !state.doneEmitted) {
      state.doneEmitted = true;
      events.push({ type: "done" });
    }
  }

  // --- hints ----------------------------------------------------------------

  const isLetter = (ch) => /[\p{L}\p{N}]/u.test(ch);

  /** The word as written, up to and including its `n`th letter. */
  function hintPrefix(i, n) {
    let out = "";
    let seen = 0;
    if (n <= 0) return out;
    for (const ch of words[i]?.text ?? "") {
      if (seen >= n) break;
      if (isLetter(ch)) seen++;
      out += ch;
    }
    return out;
  }

  // Everything the current word holds so far: locked hint letters + buffer.
  const fullTyped = (i, buffer) => hintPrefix(i, hints[i]) + buffer;
  const modeFor = (i) => (hints[i] > 0 ? "hint" : "typed");

  // --- typing ---------------------------------------------------------------

  function continuesTail(cand) {
    const w = words[state.tail.index];
    if (acceptsWord(w, cand)) return true;
    for (const f of w.forms) if (f.startsWith(cand)) return true;
    return false;
  }

  function growsIntoForm(w, p) {
    for (const f of w.forms) if (f.length > p.length && f.startsWith(p)) return true;
    return false;
  }

  // Would `buf` be a sensible start for word `i`?
  function plausibleStart(i, buf) {
    const w = words[i];
    if (!w || !buf) return false;
    return acceptsWord(w, buf) || growsIntoForm(w, plain(buf)) || w.forms.has(plain(buf));
  }

  // --- a word typed ahead -----------------------------------------------------
  // The player sometimes skips a word they didn't hear (an "y" before the line
  // they know). A word typed whole that belongs a little further on goes straight
  // there, and the skipped ones stay open. Only exact matches, only a few words
  // ahead, and never while the text could still be the current word: `lo` stays in
  // `logré` even when `lo` comes right after.
  const AHEAD = 3;

  function aheadIndices() {
    const out = [];
    for (let i = state.cursor + 1; i < total && out.length < AHEAD; i++) if (!revealed[i]) out.push(i);
    return out;
  }

  function couldBeCurrent(buf) {
    const i = state.cursor;
    return hints[i] > 0 || plausibleStart(i, buf) || holdsWord(words[i], buf);
  }

  /** First word ahead that takes `buf` exactly, or -1. */
  function aheadMatch(buf) {
    for (const j of aheadIndices()) {
      const w = words[j];
      if (!isCutOfWhole(w, buf) && acceptsWord(w, buf)) return j;
    }
    return -1;
  }

  function jumpTo(j, typed, events) {
    state.jumps++;
    state.buffer = "";
    state.cursor = j;
    reveal(j, "typed", events);
    state.tail = { index: j, typed, swallowed: "" };
  }

  function autoReveal(events) {
    if (isDone() || state.cursor < 0) return false;
    const w = words[state.cursor];
    const full = fullTyped(state.cursor, state.buffer);
    if (!acceptsWord(w, full)) {
      const p = plain(full);
      // Two neighboring letters swapped, once the word is as long as it should be.
      if (swappedAccepts(w, full) && !growsIntoForm(w, p)) {
        const index = state.cursor;
        state.buffer = "";
        reveal(index, modeFor(index), events);
        return true;
      }
      if (couldBeCurrent(state.buffer)) return false;
      const j = aheadMatch(state.buffer);
      // Wait while a longer word ahead could still be what's being typed.
      if (j < 0 || aheadIndices().some((k) => growsIntoForm(words[k], p))) return false;
      jumpTo(j, p, events);
      return true;
    }
    // A word whole in the lyric never takes a shortened version. A cut one takes its
    // short form at once: `to` reveals `to'`, and the `do` of `todo` goes to the tail.
    // A spelling match still growing waits (`par` shares its key with `pa'l`, but the
    // player is typing `para`).
    if (isCutOfWhole(w, full)) return false;
    const p = plain(full);
    if (!w.forms.has(p) && growsIntoForm(w, p)) return false;
    const index = state.cursor;
    const typed = p;
    state.buffer = "";
    reveal(index, modeFor(index), events);
    state.tail = { index, typed, swallowed: "" };
    return true;
  }

  function pushChar(c, events) {
    if (isDone()) return;
    if (isSpace(c)) {
      state.tail = null;
      if (state.buffer === "" || isSpace(state.buffer[state.buffer.length - 1])) return;
      events.push(...commitBuffer());
      return;
    }
    if (state.tail) {
      const cand = plain(state.tail.typed + state.tail.swallowed + c);
      if (continuesTail(cand)) {
        state.tail.swallowed += c;
        return;
      }
      // Swallowed characters may have been the start of the next word
      // (`to'` + `dame` typed without a space) or the end of the last one
      // (`ve'` + `yo` typed as `vezyo`): keep whichever fits the next word.
      let pending = state.tail.swallowed + c;
      if (state.tail.swallowed && !plausibleStart(state.cursor, pending)
        && plausibleStart(state.cursor, c)) pending = c;
      state.tail = null;
      for (const ch of pending) pushChar(ch, events);
      return;
    }
    // Retyping the next locked hint letter confirms it, so a player who types
    // the whole word from the start doesn't end up with the letter twice.
    const i = state.cursor;
    if (state.buffer === "" && i >= 0 && confirmed[i] < hints[i]) {
      const next = [...words[i].text].filter(isLetter)[confirmed[i]];
      if (next !== undefined && plain(next) === plain(c)) {
        confirmed[i]++;
        autoReveal(events);
        return;
      }
    }
    state.buffer += c;
    autoReveal(events);
  }

  function commitBuffer() {
    const events = [];
    const b = state.buffer.trim();
    if (!b || isDone() || state.cursor < 0) {
      state.buffer = "";
      return events;
    }
    const w = words[state.cursor];
    const index = state.cursor;
    const full = fullTyped(index, b);
    const cut = isCutOfWhole(w, full);
    if (!cut && acceptsWord(w, full)) {
      state.buffer = "";
      reveal(index, modeFor(index), events);
    } else if (holdsWord(w, full)) {
      // Before the fuzzy check: `para` is one slip away from `paral`.
      state.buffer = `${b} `;
      events.push({ type: "hold", index });
    } else if (!cut && (fuzzyAccepts(w, full) || swappedAccepts(w, full))) {
      state.buffer = "";
      reveal(index, modeFor(index), events);
    } else if (hints[index] === 0 && aheadMatch(b) >= 0) {
      jumpTo(aheadMatch(b), plain(b), events);
      state.tail = null;
    } else {
      state.buffer = "";
      confirmed[index] = 0;
      state.streak = 0;
      state.misses++;
      events.push({ type: "miss", index });
    }
    return events;
  }

  function emptySongDone() {
    if (total === 0 && !state.doneEmitted) {
      state.doneEmitted = true;
      return [{ type: "done" }];
    }
    return null;
  }

  const api = {
    /** Single entry for typed text; returns the events it caused. */
    setBuffer(value) {
      const early = emptySongDone();
      if (early) return early;
      if (isDone()) return [];
      const v = sanitizeTyped(value);
      if (v === state.buffer) return [];
      const events = [];
      if (v.startsWith(state.buffer)) {
        for (const c of v.slice(state.buffer.length)) pushChar(c, events);
      } else if (state.buffer.startsWith(v)) {
        state.buffer = v;
        state.tail = null;
      } else {
        state.buffer = "";
        state.tail = null;
        for (const c of v) pushChar(c, events);
      }
      if (events.length === 0) events.push({ type: "typing" });
      return events;
    },

    /** Test/measurement helper: types text one character at a time. */
    type(text) {
      const all = [];
      for (const c of String(text)) all.push(...api.setBuffer(state.buffer + c));
      return all;
    },

    commit() {
      const early = emptySongDone();
      if (early) return early;
      state.tail = null;
      return commitBuffer();
    },

    hint() {
      const early = emptySongDone();
      if (early) return early;
      if (isDone() || state.cursor < 0) return [];
      const i = state.cursor;
      state.tail = null;
      const len = [...plain(words[i].text)].length;
      // Letters typed correctly so far count as given; anything wrong is cleared.
      const typedSoFar = plain(state.buffer);
      if (typedSoFar && plain(words[i].text).startsWith(plain(fullTyped(i, state.buffer)))) {
        hints[i] += [...typedSoFar].length + 1;
        confirmed[i] = hints[i] - 1;
      } else {
        hints[i]++;
      }
      state.buffer = "";
      state.streak = 0;
      const events = [];
      if (hints[i] >= len) {
        state.buffer = "";
        reveal(i, "hint", events);
      } else {
        events.push({ type: "typing" });
      }
      return events;
    },

    revealLine() {
      const early = emptySongDone();
      if (early) return early;
      if (isDone() || state.cursor < 0) return [];
      const l = words[state.cursor].line;
      state.buffer = "";
      state.tail = null;
      const events = [];
      for (const i of lineWords[l]) {
        if (!revealed[i]) {
          state.cursor = i;
          reveal(i, "line", events);
        }
      }
      return events;
    },

    moveCursor(i) {
      if (!Number.isInteger(i) || i < 0 || i >= total || revealed[i]) return [];
      state.cursor = i;
      if (state.cursor >= 0) confirmed[state.cursor] = 0;
      state.buffer = "";
      state.tail = null;
      return [{ type: "typing" }];
    },

    nextWord() {
      if (isDone()) return [];
      state.cursor = nextUnrevealed(state.cursor + 1);
      if (state.cursor >= 0) confirmed[state.cursor] = 0;
      state.buffer = "";
      state.tail = null;
      return [{ type: "typing" }];
    },

    prevWord() {
      if (isDone()) return [];
      state.cursor = nextUnrevealed(state.cursor - 1, -1);
      if (state.cursor >= 0) confirmed[state.cursor] = 0;
      state.buffer = "";
      state.tail = null;
      return [{ type: "typing" }];
    },

    giveUp() {
      const early = emptySongDone();
      if (early) return early;
      const events = [];
      state.buffer = "";
      state.tail = null;
      for (let i = 0; i < total; i++) {
        if (!revealed[i]) {
          revealed[i] = true;
          how[i] = "giveup";
        }
      }
      state.streak = 0;
      state.cursor = -1;
      if (!state.doneEmitted) {
        state.doneEmitted = true;
        events.push({ type: "done" });
      }
      return events;
    },

    // --- save / restore --------------------------------------------------------
    // The progress worth keeping across a reload. The half-typed word and the
    // swallowed tail are left out on purpose: a restored song waits on a clean field.

    /** Plain data (JSON-safe) describing the progress so far. */
    snapshot() {
      const sparse = (arr) => {
        const out = {};
        arr.forEach((n, i) => { if (n > 0) out[i] = n; });
        return out;
      };
      return {
        how: how.slice(),
        hints: sparse(hints),
        confirmed: sparse(confirmed),
        cursor: state.cursor,
        streak: state.streak,
        bestStreak: state.bestStreak,
        misses: state.misses,
        jumps: state.jumps,
      };
    },

    /**
     * Puts a snapshot back. Returns false, leaving the game untouched, when it
     * does not fit these lyrics (another word count, an unknown way of revealing).
     */
    restore(snap) {
      if (!snap || !Array.isArray(snap.how) || snap.how.length !== total) return false;
      const modes = ["typed", "hint", "line", "repeat", "giveup"];
      if (!snap.how.every((m) => m === null || modes.includes(m))) return false;
      const count = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
      const lettersOf = (i) => [...plain(words[i].text)].length;
      snap.how.forEach((m, i) => {
        revealed[i] = m !== null;
        how[i] = m;
        hints[i] = 0;
        confirmed[i] = 0;
      });
      for (const [k, v] of Object.entries(snap.hints ?? {})) {
        const i = Number(k);
        if (!Number.isInteger(i) || i < 0 || i >= total) continue;
        const cap = revealed[i] ? lettersOf(i) : Math.max(0, lettersOf(i) - 1);
        hints[i] = Math.min(count(v), cap);
      }
      for (const [k, v] of Object.entries(snap.confirmed ?? {})) {
        const i = Number(k);
        if (!Number.isInteger(i) || i < 0 || i >= total) continue;
        confirmed[i] = Math.min(count(v), hints[i]);
      }
      state.streak = count(snap.streak);
      state.bestStreak = Math.max(count(snap.bestStreak), state.streak);
      state.misses = count(snap.misses);
      state.jumps = count(snap.jumps);
      state.buffer = "";
      state.tail = null;
      const c = snap.cursor;
      state.cursor = isDone() ? -1
        : Number.isInteger(c) && c >= 0 && c < total && !revealed[c] ? c : nextUnrevealed(0);
      state.doneEmitted = isDone();
      return true;
    },

    // --- getters ---------------------------------------------------------------

    stats() {
      let typed = 0;
      let helped = 0;
      let repeated = 0;
      const by = { hint: 0, line: 0, giveup: 0 };
      for (let i = 0; i < total; i++) {
        if (how[i] === "typed") typed++;
        else if (how[i] === "repeat") repeated++;
        else if (how[i]) {
          helped++;
          by[how[i]] = (by[how[i]] ?? 0) + 1;
        }
      }
      return {
        total,
        typed,
        helped,
        repeated,
        byHint: by.hint,
        byLine: by.line,
        givenUp: by.giveup,
        open: total - typed - helped - repeated,
        bestStreak: state.bestStreak,
        misses: state.misses,
        jumps: state.jumps,
        pct: total === 0 ? 0 : Math.round((100 * (typed + repeated)) / total),
      };
    },
    isRevealed: (i) => revealed[i] === true,
    howRevealed: (i) => how[i] ?? null,
    hintLevel: (i) => hints[i] ?? 0,
    /** First `hintLevel` letters of the word, as written. */
    hintText: (i) => hintPrefix(i, hints[i] ?? 0),
    /** The hint split for display: letters the player retyped, and the rest. */
    hintParts(i) {
      const text = hintPrefix(i, hints[i] ?? 0);
      const done = hintPrefix(i, confirmed[i] ?? 0);
      return { done, locked: text.slice(done.length) };
    },
    /** Index of the current word, or -1 when the song is complete. */
    cursor: () => state.cursor,
    buffer: () => state.buffer,
    /**
     * The player erased `n` characters that belong to the word just revealed
     * (an on-screen keyboard still holds them in its composing text). The
     * swallowed tail shrinks with them, so retyping them is swallowed again.
     */
    dropTail(n) {
      const t = state.tail;
      if (!t || !(n > 0)) return;
      const fromSwallowed = Math.min(n, t.swallowed.length);
      t.swallowed = t.swallowed.slice(0, t.swallowed.length - fromSwallowed);
      const rest = n - fromSwallowed;
      if (rest > 0) {
        t.typed = t.typed.slice(0, Math.max(0, t.typed.length - rest));
        if (!t.typed) state.tail = null;
      }
    },
    /** Characters swallowed after the last auto-reveal (for tests/debug). */
    tail: () => (state.tail ? state.tail.swallowed : ""),
    isDone: () => isDone(),
    lineOf: (i) => words[i]?.line ?? -1,
    streak: () => state.streak,

    isBackingVisible(lineIdx, tokenIdx) {
      const line = lines[lineIdx];
      if (!line) return false;
      let hasWordBefore = false;
      for (let t = 0; t < tokenIdx; t++) {
        const tok = line.tokens[t];
        if (tok.kind === "word") {
          hasWordBefore = true;
          if (!revealed[tok.wordIndex]) return false;
        }
      }
      if (hasWordBefore) return true;
      const cursorLine = state.cursor >= 0 ? words[state.cursor].line : Infinity;
      if (cursorLine >= lineIdx) return true;
      for (let l = 0; l < lineIdx; l++) if (!lineComplete(l)) return false;
      return true;
    },
  };
  return api;
}
