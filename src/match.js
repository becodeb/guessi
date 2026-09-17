// Pure matching functions for the guessing games.
// No DOM, no state, no I/O — deterministic: identical inputs always produce
// identical outputs, so the module is unit-testable without a framework.

// Alias markers stripped before comparison (design D10 / matching spec).
// Parentheticals: (feat. …), (featuring …), (remaster), (deluxe), (explicit),
// (deluxe edition), (expanded) — plus trailing "- remaster" / "- expanded".
const ALIAS_PATTERNS = [
  /\((?:feat\.?|featuring)[^)]*\)/gi,
  /\(remaster[^)]*\)/gi,
  /\(deluxe[^)]*\)/gi,
  /\(explicit[^)]*\)/gi,
  /\(expanded[^)]*\)/gi,
  // Trailing "- remaster" / "- expanded" (allows extra words: "- 2013 Remaster").
  /\s+-\s+[^-]*?(?:remaster(?:ed)?|expanded)\s*$/gi,
];

/**
 * Deterministic normalization:
 * lowercase → NFD + strip combining marks → strip non-letter/number/space →
 * collapse whitespace.
 */
export function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove alias markers (feat., edition suffixes) from a raw string. */
export function stripAliases(s) {
  let out = String(s ?? "");
  for (const pattern of ALIAS_PATTERNS) {
    out = out.replace(pattern, "");
  }
  return out.trim();
}

/** Classic Levenshtein edit distance (DP). */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Typo tolerance: Levenshtein distance ≤ max(1, floor(len/10)), capped at 2
 * (design D10 / matching spec). Length is the normalized target length.
 */
export function isMatch(guess, target) {
  const t = normalize(target);
  const g = normalize(guess);
  if (t === "") return false;
  const cap = Math.min(2, Math.max(1, Math.floor(t.length / 10)));
  return levenshtein(g, t) <= cap;
}

/** Title match: accepted against the raw-normalized OR alias-normalized target. */
export function matchTitle(guess, target) {
  const g = normalize(guess);
  return isMatch(g, normalize(target)) || isMatch(g, normalize(stripAliases(target)));
}

/** Same normalization + alias + typo rules as titles. */
export function matchAlbum(guess, albumName) {
  return matchTitle(guess, albumName);
}

function matchArtist(guess, name) {
  const g = normalize(guess);
  return isMatch(g, normalize(name)) || isMatch(g, normalize(stripAliases(name)));
}

/**
 * Per-artist slot matching (design D11 / matching spec):
 * - one guess per credited artist, compared order-independently;
 * - the first unsolved credited artist a guess matches fills that slot;
 * - a wrong guess flags the slot "incorrect" but stays editable (never burns
 *   a slot — the artist is only consumed by a correct guess);
 * - solved ⇔ every credited artist is matched.
 *
 * @param {string[]} guesses  current guess text per slot (may be empty)
 * @param {Array<{name:string}|string>} credited  all credited artists
 * @returns {{slots: Array<{guess:string,status:"open"|"correct"|"incorrect",matchedIndex:number|null}>, solved: boolean}}
 *   `matchedIndex` is the credited artist index a correct slot matched, or
 *   `null` when the slot is open/incorrect. `status`/`solved` are unchanged.
 */
export function matchArtistSlots(guesses, credited) {
  const names = credited.map((c) => (typeof c === "string" ? c : c.name ?? ""));
  const matched = new Set();
  const slots = guesses.map((rawGuess) => {
    const guess = String(rawGuess ?? "").trim();
    if (!guess) return { guess: "", status: "open", matchedIndex: null };
    let hit = -1;
    for (let i = 0; i < names.length; i++) {
      if (matched.has(i)) continue;
      if (matchArtist(guess, names[i])) {
        hit = i;
        break;
      }
    }
    if (hit === -1) return { guess, status: "incorrect", matchedIndex: null };
    matched.add(hit);
    return { guess, status: "correct", matchedIndex: hit };
  });
  // Vacuous truth: with no credited artists everything is matched.
  const solved = matched.size === names.length;
  return { slots, solved };
}

/**
 * Compute the canonical artist-slot layout after matching.
 *
 * A correct guess relocates to the credited artist's OWN field (so the order of
 * fields "changes" until each solved field shows the artist that belongs there).
 * Non-matching text is kept editable in a spill slot so a wrong guess is never
 * burned. Pure and deterministic — same contract as the rest of match.js.
 *
 * Algorithm:
 *   1. `names` = credited names (objects → `.name`).
 *   2. placements: for every `status === "correct"` slot, write the canonical
 *      name at `matchedIndex` and lock it. Done BEFORE leftovers so a correct
 *      guess can never be overwritten by stray text.
 *   3. leftovers: non-correct non-empty text stays at its own index `i` only if
 *      that slot is still empty & unlocked; otherwise it joins the spill queue
 *      (in slot order).
 *   4. spill fill: walk 0..names.length-1, filling the first empty unlocked
 *      slots from the spill queue in order.
 *
 * @param {string[]} guesses  current guess text per slot (may be empty)
 * @param {Array<{name:string}|string>} credited  all credited artists
 * @returns {{values:string[], locked:boolean[], solved:boolean}}
 *   `values`/`locked` have `names.length` entries; `solved` from matchArtistSlots.
 */
export function assignArtistSlots(guesses, credited) {
  const names = credited.map((c) => (typeof c === "string" ? c : (c.name ?? "")));
  const { slots, solved } = matchArtistSlots(guesses, credited);

  const values = new Array(names.length).fill("");
  const locked = new Array(names.length).fill(false);

  // Pass 1 — placements: correct guesses land in their own credited field.
  for (let i = 0; i < slots.length && i < names.length; i++) {
    const slot = slots[i];
    if (slot.status === "correct" && slot.matchedIndex != null) {
      values[slot.matchedIndex] = names[slot.matchedIndex];
      locked[slot.matchedIndex] = true;
    }
  }

  // Pass 2 — leftovers: keep non-matching text in place when safe, else spill.
  const spill = [];
  for (let i = 0; i < slots.length && i < names.length; i++) {
    const slot = slots[i];
    if (slot.status === "correct") continue;
    const text = slot.guess;
    if (!text) continue;
    if (!locked[i] && values[i] === "") {
      values[i] = text;
    } else {
      spill.push(text);
    }
  }

  // Spill fill: first empty unlocked slots, in order.
  for (const text of spill) {
    for (let j = 0; j < names.length; j++) {
      if (!locked[j] && values[j] === "") {
        values[j] = text;
        break;
      }
    }
  }

  return { values, locked, solved };
}

/**
 * Year hint for Game 3.
 * direction: where the actual year sits relative to the guess
 *   ("newer" | "older" | "equal").
 * closeness: |guess − actual| → "very-close" (≤2) | "close" (≤10) | "far".
 */
export function yearHint(guess, actual) {
  const g = Number(guess);
  const a = Number(actual);
  const d = Math.abs(g - a);
  const direction = g < a ? "newer" : g > a ? "older" : "equal";
  const closeness = d <= 2 ? "very-close" : d <= 10 ? "close" : "far";
  return { direction, closeness };
}