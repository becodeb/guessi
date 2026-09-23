// Pure guessing logic for "La primera décima": suggestion search, dedupe,
// guess evaluation, and repeat-avoiding draws. No DOM, no state.

import { normalize, matchTitle } from "./match.js";

/** Credited artist names, in order. */
export function artistNames(track) {
  return (track?.artists ?? []).map((a) => (typeof a === "string" ? a : a?.name ?? ""));
}

function artistKey(a) {
  return typeof a === "string" ? normalize(a) : (a?.id ?? normalize(a?.name ?? ""));
}

/** Whether two tracks share at least one credited artist (by id, else by normalized name). */
export function shareArtist(a, b) {
  const keysA = new Set((a?.artists ?? []).map(artistKey));
  return (b?.artists ?? []).some((x) => keysA.has(artistKey(x)));
}

/** A picked candidate is correct: same normalized title, and a shared artist. */
export function isCorrectPick(candidate, answer) {
  return normalize(candidate?.name) === normalize(answer?.name) && shareArtist(candidate, answer);
}

/** Collapses tracks that share a normalized title and the same main (first) artist. */
export function dedupeByTitleArtist(tracks) {
  const seen = new Set();
  const out = [];
  for (const t of tracks) {
    const key = `${normalize(t.name)}::${normalize(artistNames(t)[0] ?? "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Up to `limit` deduped pool tracks whose title or an artist contains `query` (normalized). */
export function searchSuggestions(pool, query, limit = 6) {
  const needle = normalize(query);
  if (needle.length < 2) return [];
  const hits = pool.filter((t) =>
    normalize(t.name).includes(needle) || artistNames(t).some((n) => normalize(n).includes(needle))
  );
  return dedupeByTitleArtist(hits).slice(0, limit);
}

/**
 * Free-text guess against `answer`: correct when it tolerant-matches the
 * answer's title and no OTHER pool track's title also matches; wrong (with
 * that other track) when it points elsewhere; unknown when it matches nothing.
 * @returns {{result: "correct"|"wrong"|"unknown", track?: object}}
 */
export function evaluateFreeText(text, answer, pool) {
  const other = pool.find((t) => t.id !== answer.id && matchTitle(text, t.name));
  if (other) return { result: "wrong", track: other };
  if (matchTitle(text, answer.name)) return { result: "correct" };
  return { result: "unknown" };
}

/** Pool tracks excluding `recentIds`, or the full pool when that would empty it. */
export function eligibleTracks(pool, recentIds) {
  const recent = new Set(recentIds);
  const filtered = pool.filter((t) => !recent.has(t.id));
  return filtered.length > 0 ? filtered : pool;
}
