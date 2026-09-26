// Pure helpers for "Canción entera" (task T4): the whole-song, untimed,
// recreational mode inside "Completa la letra". No DOM, no I/O — deterministic,
// unit-testable with plain node. lyrics-engine.js's rules are reused as-is
// (createLyricsGame, tokenize, maskWord) — this module never changes them,
// it only adds the bits that engine doesn't already provide: a minimum-length
// gate, "how far along are we", and "where's the next thing to help with".

import { tokenize } from "./lyrics-engine.js";

// A whole song needs real substance to be worth playing untimed — this is
// deliberately lower than a timed fragment's per-fragment floor (3 hideable
// words): here EVERY word is masked, so even a short-ish song still gives a
// real "type the whole thing" experience.
export const MIN_WHOLE_SONG_WORDS = 20;

/** Whether `text` has enough words to be worth a "Canción entera" run. */
export function isUsableWholeSong(text) {
  return tokenize(text).words.length >= MIN_WHOLE_SONG_WORDS;
}

/** Rounded completion percentage; 0 when there is nothing to complete. */
export function progressPercent(found, total) {
  if (!total || total <= 0) return 0;
  return Math.round((Math.max(0, found) / total) * 100);
}

/**
 * Index of the first source line (into lyrics-engine's `tokenize(text).lines`)
 * that still has an unrevealed word, per `isRevealed(wordIndex)`. Blank
 * (empty) source lines never block progress. `-1` when every word is
 * revealed (or there are no lines at all).
 * @param {Array<Array<{isWord:boolean, wordIndex?:number}>>} lines
 * @param {{isRevealed: (i:number) => boolean}} engine
 */
export function firstIncompleteLineIndex(lines, engine) {
  for (let i = 0; i < lines.length; i++) {
    const hasHidden = lines[i].some((tok) => tok.isWord && !engine.isRevealed(tok.wordIndex));
    if (hasHidden) return i;
  }
  return -1;
}

/** The raw text of the first incomplete line (tokens joined by a space), or null when complete. */
export function firstIncompleteLineText(lines, engine) {
  const idx = firstIncompleteLineIndex(lines, engine);
  if (idx === -1) return null;
  return lines[idx].map((tok) => tok.text).join(" ");
}
