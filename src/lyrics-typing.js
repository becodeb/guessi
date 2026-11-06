// Pure, deterministic typing engine for the lyrics game. No DOM, no I/O.
//
// Input contract: the UI keeps a hidden <input> and calls
// `game.setBuffer(input.value)` on every `input` event, then writes
// `game.buffer()` back into the input when it differs. The engine only ever
// compares the new value with its own buffer, so characters it swallowed
// (the tail) never come back.

import {
  acceptsWord, fuzzyAccepts, holdsWord, plain, mapHomoglyphs,
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
  const lineWords = lines.map(() => []);
  words.forEach((w, i) => lineWords[w.line]?.push(i));

  const state = {
    cursor: 0,
    buffer: "",
    tail: null, // { index, typed, swallowed }
    streak: 0,
    bestStreak: 0,
    misses: 0,
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

  function autoReveal(events) {
    if (isDone() || state.cursor < 0) return false;
    const w = words[state.cursor];
    if (!acceptsWord(w, state.buffer)) return false;
    // A phonetic-only match that is still growing into a longer form waits
    // (`par` collides with the key of `pa'l`, but the player is typing `para`).
    const p = plain(state.buffer);
    if (!w.forms.has(p) && growsIntoForm(w, p)) return false;
    const index = state.cursor;
    const typed = plain(state.buffer);
    state.buffer = "";
    reveal(index, "typed", events);
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
      const cand = state.tail.typed + state.tail.swallowed + c;
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
    if (acceptsWord(w, b)) {
      state.buffer = "";
      reveal(index, "typed", events);
    } else if (holdsWord(w, b)) {
      // Before the fuzzy check: `para` is one slip away from `paral`.
      state.buffer = `${b} `;
      events.push({ type: "hold", index });
    } else if (fuzzyAccepts(w, b)) {
      state.buffer = "";
      reveal(index, "typed", events);
    } else {
      state.buffer = "";
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
      hints[i]++;
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
      state.buffer = "";
      state.tail = null;
      return [{ type: "typing" }];
    },

    nextWord() {
      if (isDone()) return [];
      state.cursor = nextUnrevealed(state.cursor + 1);
      state.buffer = "";
      state.tail = null;
      return [{ type: "typing" }];
    },

    prevWord() {
      if (isDone()) return [];
      state.cursor = nextUnrevealed(state.cursor - 1, -1);
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

    // --- getters ---------------------------------------------------------------

    stats() {
      let typed = 0;
      let helped = 0;
      let repeated = 0;
      for (let i = 0; i < total; i++) {
        if (how[i] === "typed") typed++;
        else if (how[i] === "repeat") repeated++;
        else if (how[i]) helped++;
      }
      return {
        total,
        typed,
        helped,
        repeated,
        bestStreak: state.bestStreak,
        misses: state.misses,
        pct: total === 0 ? 0 : Math.round((100 * (typed + repeated)) / total),
      };
    },
    isRevealed: (i) => revealed[i] === true,
    howRevealed: (i) => how[i] ?? null,
    hintLevel: (i) => hints[i] ?? 0,
    /** First `hintLevel` letters of the word, as written. */
    hintText(i) {
      const n = hints[i] ?? 0;
      let out = "";
      let seen = 0;
      for (const ch of words[i]?.text ?? "") {
        if (seen >= n) break;
        if (/[\p{L}\p{N}]/u.test(ch)) seen++;
        out += ch;
      }
      return out;
    },
    /** Index of the current word, or -1 when the song is complete. */
    cursor: () => state.cursor,
    buffer: () => state.buffer,
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
