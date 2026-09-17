// Pure lyrics challenge engine: tokenizer + state machine. No DOM, no I/O, no
// module side effects — deterministic, so it is unit-testable with plain node.
//
// The UI layer must call these methods and must NOT re-implement the rules.
// All matching is case/accent/punctuation-insensitive via match.normalize, but
// word OCCURRENCES are tracked by their reading-order index, so a repeated
// chorus word resolves to exactly the spot the player meant.

import { normalize } from "./match.js";

const WORD_CHAR = /[\p{L}\p{N}]/u;

export function isWordChar(ch) {
  return WORD_CHAR.test(ch);
}

/**
 * Mask a word for display: the first `hintLevel` letters/digits stay visible,
 * the rest become "_". Punctuation and apostrophes are never masked, so the
 * player keeps structural anchors (e.g. "you're" at level 1 → "y__'_").
 */
export function maskWord(text, hintLevel = 0) {
  let shown = 0;
  let out = "";
  for (const ch of String(text ?? "")) {
    if (isWordChar(ch)) {
      if (shown < hintLevel) {
        out += ch;
        shown++;
      } else out += "_";
    } else out += ch;
  }
  return out;
}

/**
 * Split lyrics text into lines of tokens plus a flat word list.
 * @returns {{ lines: Array<Array<{text:string, isWord:boolean, wordIndex:number|undefined}>>,
 *             words: Array<{text:string, normalized:string, line:number, index:number}> }}
 *   - `lines`: one entry per source line (blank lines → []), tokens keep
 *     whitespace separation so punctuation can be rendered inline.
 *   - `words`: every word token in reading order; `index` is its global
 *     position and is also mirrored onto the matching line token as
 *     `wordIndex` (so the UI maps a line token straight to its word index).
 */
export function tokenize(text) {
  const rawLines = String(text ?? "").split("\n");
  const lines = [];
  const words = [];
  let gi = 0;
  rawLines.forEach((rawLine, lineNo) => {
    const parts = rawLine.split(/\s+/).filter((s) => s.length > 0);
    const lineTokens = [];
    for (const part of parts) {
      const isWord = isWordChar(part);
      if (isWord) {
        const idx = gi++;
        lineTokens.push({ text: part, isWord: true, wordIndex: idx });
        words.push({ text: part, normalized: normalize(part), line: lineNo, index: idx });
      } else {
        lineTokens.push({ text: part, isWord: false, wordIndex: undefined });
      }
    }
    lines.push(lineTokens);
  });
  return { lines, words };
}

/**
 * Create a fresh lyrics game for `text`.
 * Result objects are always `{ ok, reason, revealedIndex, cursor }`:
 *   reason: "ok" | "mismatch" | "not-found" | "no-known" | "done"
 */
export function createLyricsGame(text) {
  const { words } = tokenize(text);
  const revealed = new Set(); // word indices
  const hints = new Map(); // index -> count of revealed letter/digit chars
  const discovered = new Set(); // normalized strings the player has revealed
  let cursor = firstHidden();

  function letterDigitCount(i) {
    return [...words[i].text].filter(isWordChar).length;
  }

  function firstHidden() {
    for (let i = 0; i < words.length; i++) if (!revealed.has(i)) return i;
    return null;
  }

  // First hidden word at or after `from+1`, wrapping to the start; null if none.
  function nextHidden(from) {
    if (words.length === 0) return null;
    for (let step = 1; step <= words.length; step++) {
      const i = (from + step) % words.length;
      if (!revealed.has(i)) return i;
    }
    return null;
  }

  function reveal(i) {
    revealed.add(i);
    discovered.add(words[i].normalized);
  }

  function done() {
    return words.length > 0 && revealed.size === words.length;
  }

  function result(ok, reason, revealedIndex) {
    return { ok, reason, revealedIndex: revealedIndex ?? null, cursor };
  }

  function placeAtCursor(typed) {
    if (cursor == null) return result(false, "done", null);
    if (normalize(typed) === words[cursor].normalized) {
      const i = cursor;
      reveal(i);
      cursor = nextHidden(i);
      return result(true, done() ? "done" : "ok", i);
    }
    return result(false, "mismatch", null);
  }

  function revealKnownAtCursor() {
    if (cursor == null) return result(false, "done", null);
    if (discovered.has(words[cursor].normalized)) {
      const i = cursor;
      reveal(i);
      cursor = nextHidden(i);
      return result(true, done() ? "done" : "ok", i);
    }
    return result(false, "no-known", null);
  }

  function revealAnywhere(typed) {
    if (words.length === 0) return result(false, "not-found", null);
    const target = normalize(typed);
    const start = cursor ?? 0;
    for (let step = 0; step < words.length; step++) {
      const i = (start + step) % words.length;
      if (!revealed.has(i) && words[i].normalized === target) {
        reveal(i);
        cursor = nextHidden(i);
        return result(true, done() ? "done" : "ok", i);
      }
    }
    return result(false, "not-found", null);
  }

  function moveCursor(index) {
    if (index < 0 || index >= words.length) return false;
    if (revealed.has(index)) return false;
    cursor = index;
    return true;
  }

  function hint() {
    if (cursor == null) return result(false, "done", null);
    const i = cursor;
    const total = letterDigitCount(i);
    const cur = hints.get(i) ?? 0;
    if (cur >= total) return result(false, "no-known", null);
    const next = cur + 1;
    hints.set(i, next);
    if (next >= total) {
      reveal(i);
      cursor = nextHidden(i);
      return result(true, done() ? "done" : "ok", i);
    }
    return result(true, "ok", null);
  }

  function revealAll() {
    for (let i = 0; i < words.length; i++) reveal(i);
    cursor = null;
    return result(true, "done", null);
  }

  return {
    placeAtCursor,
    revealKnownAtCursor,
    revealAnywhere,
    moveCursor,
    hint,
    revealAll,
    isComplete: done,
    discoveredWords: () => [...discovered],
    isDiscovered: (norm) => discovered.has(norm),
    revealedCount: () => revealed.size,
    hintCount: () => [...hints.values()].reduce((a, b) => a + b, 0),
    cursor: () => cursor,
    isRevealed: (i) => revealed.has(i),
    hintLevel: (i) => hints.get(i) ?? 0,
    words,
    totalWords: () => words.length,
  };
}
