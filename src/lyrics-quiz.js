// Pure logic for "Completa la letra" (task T3): fragment selection, blank
// picking, answer matching against blanks, timing lookup, and scoring. No
// DOM, no I/O — deterministic given an injectable `rng`, so this module is
// unit-testable with plain node (tests/lyrics-quiz.test.mjs).
//
// The UI layer (src/games/lyrics-game.js) must call these functions and must
// NOT re-implement the rules, same contract as lyrics-engine.js.

import { normalize } from "./match.js";
import { tokenize, maskWord, isWordChar } from "./lyrics-engine.js";

// --- tunables (scoring + pacing) ---------------------------------------------

export const FRAGMENT_TIMER_MS = 45000;
export const LISTEN_CAP_MS = 12000;
export const MAX_LISTENS_PER_FRAGMENT = 2;
export const SONGS_PER_RUN = 5;

const POINTS_PER_WORD = 10;
const HINT_COST = 4;
const LISTEN_COST = 6;
const TIME_BONUS_MAX = 20;
const PERFECT_BONUS = 15;

const MIN_FRAGMENT_LINES = 2;
const MAX_FRAGMENT_LINES = 4;
const MIN_BLANKS = 4;
const MAX_BLANKS = 6;
const MIN_USABLE_BLANKS = 3; // below this a fragment is "too short" (spec)

function letterCount(text) {
  return [...String(text ?? "")].filter(isWordChar).length;
}

// --- stanza splitting ---------------------------------------------------------

/**
 * Split raw lyrics text into stanzas on blank lines.
 * @returns {Array<{startLine:number, lines:string[]}>} `lines` are trimmed,
 *   non-empty, consecutive source lines; `startLine` is the 0-based index of
 *   the first of those lines in the original text (blank lines counted).
 */
export function splitStanzas(text) {
  const rawLines = String(text ?? "").split("\n");
  const stanzas = [];
  let current = [];
  let currentStart = 0;
  rawLines.forEach((raw, i) => {
    const line = raw.trim();
    if (line) {
      if (current.length === 0) currentStart = i;
      current.push(line);
    } else if (current.length > 0) {
      stanzas.push({ startLine: currentStart, lines: current });
      current = [];
    }
  });
  if (current.length > 0) stanzas.push({ startLine: currentStart, lines: current });
  return stanzas;
}

// --- fragment selection --------------------------------------------------------

/**
 * Pick one fragment: 2-4 consecutive non-empty lines from one stanza. Windows
 * that contain a line repeated elsewhere in the song (a likely chorus) are
 * weighted 4x so the fun, recognizable part comes up more often than not,
 * while every other window stays reachable for variety.
 * @param {string} text  full lyrics
 * @param {{rng?: () => number, minLines?: number, maxLines?: number}} [opts]
 * @returns {{lines: string[], contextLine: string|null}|null}  null when no
 *   stanza has at least `minLines` non-empty lines (e.g. very short lyrics).
 *   `contextLine` is the line right before the fragment in the same stanza
 *   (dimmed context in the UI), or null when the fragment opens its stanza.
 */
export function pickFragment(text, { rng = Math.random, minLines = MIN_FRAGMENT_LINES, maxLines = MAX_FRAGMENT_LINES } = {}) {
  const stanzas = splitStanzas(text);

  const lineFreq = new Map();
  for (const st of stanzas) {
    for (const line of st.lines) {
      const n = normalize(line);
      if (!n) continue;
      lineFreq.set(n, (lineFreq.get(n) ?? 0) + 1);
    }
  }

  const candidates = [];
  for (const st of stanzas) {
    if (st.lines.length < minLines) continue;
    const winMax = Math.min(maxLines, st.lines.length);
    for (let size = minLines; size <= winMax; size++) {
      for (let start = 0; start + size <= st.lines.length; start++) {
        const windowLines = st.lines.slice(start, start + size);
        const hasRepeat = windowLines.some((l) => (lineFreq.get(normalize(l)) ?? 0) >= 2);
        const contextLine = start > 0 ? st.lines[start - 1] : null;
        candidates.push({ lines: windowLines, contextLine, weight: hasRepeat ? 4 : 1 });
      }
    }
  }
  if (candidates.length === 0) return null;

  const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
  let r = rng() * totalWeight;
  for (const c of candidates) {
    r -= c.weight;
    if (r <= 0) return { lines: c.lines, contextLine: c.contextLine };
  }
  const last = candidates[candidates.length - 1];
  return { lines: last.lines, contextLine: last.contextLine };
}

// --- blank picking ---------------------------------------------------------------

function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Choose which word indices (into `words`, as returned by lyrics-engine's
 * tokenize) become blanks: ≥3-letter words, one normalized word chosen at
 * most once (so no two blanks share the same answer — an answer never fills
 * two holes ambiguously), spread across lines so each line gets at least one
 * blank when there is a distinct eligible word available for it.
 * @returns {number[]|null}  ascending word indices, or null when fewer than
 *   3 distinct eligible words exist (fragment too short to hide ≥3 words).
 */
export function pickBlankIndices(words, { rng = Math.random, min = MIN_BLANKS, max = MAX_BLANKS } = {}) {
  const firstIndexByNorm = new Map();
  for (const w of words) {
    if (letterCount(w.text) < 3) continue;
    if (!firstIndexByNorm.has(w.normalized)) firstIndexByNorm.set(w.normalized, w.index);
  }
  const distinct = [...firstIndexByNorm.values()];
  if (distinct.length < MIN_USABLE_BLANKS) return null;

  const desired = min + Math.floor(rng() * (max - min + 1));
  const targetCount = Math.min(distinct.length, Math.max(MIN_USABLE_BLANKS, desired));

  const byLine = new Map();
  for (const idx of distinct) {
    const line = words[idx].line;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line).push(idx);
  }

  const chosen = [];
  for (const line of shuffle([...byLine.keys()], rng)) {
    if (chosen.length >= targetCount) break;
    const cands = byLine.get(line);
    chosen.push(cands[Math.floor(rng() * cands.length)]);
  }
  if (chosen.length < targetCount) {
    const remaining = shuffle(distinct.filter((i) => !chosen.includes(i)), rng);
    for (const idx of remaining) {
      if (chosen.length >= targetCount) break;
      chosen.push(idx);
    }
  }
  return chosen.sort((a, b) => a - b);
}

/**
 * Combine fragment selection + blank picking into one ready-to-play spec.
 * @returns {null|{rawLines:string[], contextLine:string|null, fragmentText:string,
 *   lines: Array, words: Array, blankIndices: number[]}}
 *   null when there is no usable fragment (no stanza long enough, or fewer
 *   than 3 hideable words) — the caller treats this like "no lyrics".
 */
export function buildFragment(text, opts = {}) {
  const picked = pickFragment(text, opts);
  if (!picked) return null;
  const fragmentText = picked.lines.join("\n");
  const { lines, words } = tokenize(fragmentText);
  const blankIndices = pickBlankIndices(words, opts);
  if (!blankIndices) return null;
  return { rawLines: picked.lines, contextLine: picked.contextLine, fragmentText, lines, words, blankIndices };
}

// --- fragment quiz state (factory, mirrors lyrics-engine's createLyricsGame) --

/**
 * Create the play state for one fragment's blanks.
 * @param {{words: Array, blankIndices: number[]}} spec  from buildFragment()
 */
export function createFragmentQuiz({ words, blankIndices }) {
  const filled = new Set();
  const hints = new Map(); // blank index -> revealed letter count
  let hintCalls = 0;

  function isBlank(i) {
    return blankIndices.includes(i);
  }

  function isComplete() {
    return filled.size === blankIndices.length;
  }

  /** Typed word vs every unfilled blank (accent/case/punctuation-insensitive). */
  function tryWord(typed) {
    const norm = normalize(typed);
    if (!norm) return { ok: false, index: null, done: false };
    for (const i of blankIndices) {
      if (filled.has(i)) continue;
      if (words[i].normalized === norm) {
        filled.add(i);
        return { ok: true, index: i, done: isComplete() };
      }
    }
    return { ok: false, index: null, done: false };
  }

  /** Reveal the next letter of the earliest unfilled blank; costs one use. */
  function hint() {
    const i = blankIndices.find((idx) => !filled.has(idx));
    if (i == null) return { ok: false, index: null, hintLevel: 0, filled: false, done: false };
    hintCalls += 1;
    const total = letterCount(words[i].text);
    const next = Math.min((hints.get(i) ?? 0) + 1, total);
    hints.set(i, next);
    const revealed = next >= total;
    if (revealed) filled.add(i);
    return { ok: true, index: i, hintLevel: next, filled: revealed, done: isComplete() };
  }

  function maskFor(i) {
    if (filled.has(i)) return words[i].text;
    return maskWord(words[i].text, hints.get(i) ?? 0);
  }

  function revealAll() {
    for (const i of blankIndices) filled.add(i);
  }

  return {
    isBlank,
    tryWord,
    hint,
    maskFor,
    revealAll,
    isComplete,
    isFilled: (i) => filled.has(i),
    foundCount: () => filled.size,
    totalBlanks: () => blankIndices.length,
    hintCalls: () => hintCalls,
  };
}

// --- synced-timing lookup (task T3: "Escuchar el fragmento") -----------------

/**
 * Locate the fragment inside the song's synced lines (LRCLIB timestamps),
 * matched by normalized text — the fragment came from the plain-text lyrics,
 * which may format lines slightly differently than the synced source.
 * @param {string[]} fragmentLines  raw fragment lines, in order
 * @param {Array<{ms:number, text:string}>|null|undefined} syncedLines
 * @param {{capMs?: number}} [opts]
 * @returns {{startMs:number, durationMs:number}|null}  null when there is no
 *   synced timing or the fragment's lines cannot be located in it.
 */
export function findFragmentTiming(fragmentLines, syncedLines, { capMs = LISTEN_CAP_MS } = {}) {
  if (!Array.isArray(syncedLines) || syncedLines.length === 0) return null;
  const wanted = fragmentLines.map((l) => normalize(l)).filter(Boolean);
  if (wanted.length === 0) return null;

  for (let i = 0; i + wanted.length <= syncedLines.length; i++) {
    let ok = true;
    for (let j = 0; j < wanted.length; j++) {
      if (normalize(syncedLines[i + j].text) !== wanted[j]) { ok = false; break; }
    }
    if (!ok) continue;
    const startMs = syncedLines[i].ms;
    const lastIndex = i + wanted.length - 1;
    const nextMs = lastIndex + 1 < syncedLines.length ? syncedLines[lastIndex + 1].ms : startMs + capMs;
    const durationMs = Math.min(Math.max(0, nextMs - startMs), capMs);
    return { startMs, durationMs: durationMs || capMs };
  }
  return null;
}

// --- scoring -------------------------------------------------------------------

/**
 * Points for one finished fragment.
 * - `POINTS_PER_WORD` per blank found, regardless of how the fragment ended.
 * - A time bonus (up to `TIME_BONUS_MAX`) only when every blank was found,
 *   scaled by the fraction of the timer left.
 * - Help costs (`HINT_COST` per Pista use, `LISTEN_COST` per listen use) are
 *   subtracted; the fragment's own score never goes below 0.
 * - "Perfect" = every blank found with zero help; earns `PERFECT_BONUS` on
 *   top and is the run's "stamp" moment.
 * @returns {{points:number, completed:boolean, perfect:boolean}}
 */
export function scoreFragment({
  totalBlanks, foundCount, hintCalls = 0, listenCalls = 0, remainingMs = 0, timerMs = FRAGMENT_TIMER_MS,
}) {
  const completed = totalBlanks > 0 && foundCount >= totalBlanks;
  const base = foundCount * POINTS_PER_WORD;
  const timeBonus = completed && timerMs > 0
    ? Math.round((Math.max(0, Math.min(remainingMs, timerMs)) / timerMs) * TIME_BONUS_MAX)
    : 0;
  const helpCost = hintCalls * HINT_COST + listenCalls * LISTEN_COST;
  const perfect = completed && hintCalls === 0 && listenCalls === 0;
  const points = Math.max(0, base + timeBonus - helpCost) + (perfect ? PERFECT_BONUS : 0);
  return { points, completed, perfect };
}
