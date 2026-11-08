// Validation of one play record from the client (shape built by
// src/letra-stats.js buildRecord). Returns a sanitized copy or null: nothing
// arbitrary from the client is stored, only the fields below, with caps.

export const MAX_PLAYS_PER_REQUEST = 200;

const STATUSES = new Set(["complete", "gaveup", "open"]);
const SOURCES = new Set(["synced", "plain"]);
const WORD_KEYS = ["total", "typed", "repeated", "byHint", "byLine", "givenUp", "open"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Optional number: undefined -> 0, otherwise it must be finite and non-negative. */
function num(v, max = 1e12) {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > max) return NaN;
  return v;
}

/** Optional string, capped: undefined -> "", non-strings are invalid. */
function str(v, max) {
  if (v === undefined) return "";
  if (typeof v !== "string" || v.length > max) return null;
  return v;
}

function isoDate(v) {
  if (typeof v !== "string" || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** @returns {object|null} */
export function validatePlay(r) {
  if (!isObj(r) || r.v !== 1 || r.game !== "letra") return null;
  if (typeof r.id !== "string" || r.id.length < 1 || r.id.length > 64) return null;
  if (!STATUSES.has(r.status)) return null;
  const startedAt = isoDate(r.startedAt);
  const endedAt = isoDate(r.endedAt);
  if (!startedAt || !endedAt) return null;

  const t = r.track;
  if (!isObj(t) || typeof t.id !== "string" || t.id.length < 1 || t.id.length > 64) return null;
  const artists = t.artists === undefined ? [] : t.artists;
  if (!Array.isArray(artists) || artists.length > 20 || artists.some((a) => typeof a !== "string" || a.length > 200)) return null;
  const track = {
    id: t.id,
    uri: str(t.uri, 100),
    name: str(t.name, 300),
    artists,
    album: str(t.album, 300),
    durationMs: num(t.durationMs),
  };
  if (track.uri === null || track.name === null || track.album === null || Number.isNaN(track.durationMs)) return null;

  const w = r.words === undefined ? {} : r.words;
  if (!isObj(w)) return null;
  const words = {};
  for (const k of WORD_KEYS) {
    words[k] = num(w[k]);
    if (Number.isNaN(words[k])) return null;
  }

  const activeMs = num(r.activeMs);
  const pct = num(r.pct, 100);
  const bestStreak = num(r.bestStreak);
  const misses = num(r.misses);
  const jumps = num(r.jumps);
  if ([activeMs, pct, bestStreak, misses, jumps].some(Number.isNaN)) return null;
  const source = r.source === undefined ? "plain" : r.source;
  if (!SOURCES.has(source)) return null;

  return {
    v: 1, id: r.id, game: "letra", status: r.status, startedAt, endedAt,
    activeMs: Math.round(activeMs), track, words, pct, bestStreak, misses, jumps, source,
  };
}
