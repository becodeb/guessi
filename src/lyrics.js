// Lyrics source + cache for the round game's lyrics stage.
// Primary source: LRCLIB (public, keyless, CORS-enabled — verified 2026-09-17).
// Results are cached in localStorage (positive 30d, negative 7d). Manual pastes
// win over the network and never expire. Never throws; stale responses are
// cancelled via the optional AbortSignal.

import { normalize, isMatch } from "./match.js";
import {
  loadLyricsCache,
  saveLyricsCache,
  loadManualLyrics,
  saveManualLyrics as persistManualLyrics,
} from "./storage.js";

const LRCLIB_GET = "https://lrclib.net/api/get";
const LRCLIB_SEARCH = "https://lrclib.net/api/search";
const TTL_POSITIVE_MS = 30 * 24 * 60 * 60 * 1000;
const TTL_NEGATIVE_MS = 7 * 24 * 60 * 60 * 1000;

// Cache schema (task T3): entries cached before synced-line support have no
// `lines`, so bumping this forces every old entry to refetch once instead of
// silently missing timing for up to 30 days. Bump again if the cached shape
// ever changes in a way old entries can't safely answer for.
const CACHE_SCHEMA = 2;

// --- manual overrides (public API) -----------------------------------------

export function saveManualLyrics(trackId, text) {
  const map = loadManualLyrics();
  map[trackId] = String(text ?? "");
  persistManualLyrics(map);
}

export function getManualLyrics(trackId) {
  const map = loadManualLyrics();
  return trackId in map ? map[trackId] : null;
}

// --- cache helpers -----------------------------------------------------------

function cacheGet(trackId) {
  const cache = loadLyricsCache();
  const entry = cache[trackId];
  if (!entry || !entry.fetchedAt) return null;
  // Pre-T3 entries (and any future incompatible shape) never match the
  // current schema — treat them as absent so they refetch once, instead of
  // permanently answering "no timing" for up to 30 days.
  if (entry.schema !== CACHE_SCHEMA) return null;
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  const ttl = entry.status === "ok" ? TTL_POSITIVE_MS : TTL_NEGATIVE_MS;
  return age > ttl ? null : entry;
}

function cachePut(trackId, entry) {
  const cache = loadLyricsCache();
  cache[trackId] = { ...entry, schema: CACHE_SCHEMA, fetchedAt: new Date().toISOString() };
  saveLyricsCache(cache);
}

// --- LRCLIB shaping ----------------------------------------------------------

function pickLyrics(data) {
  if (data?.plainLyrics && String(data.plainLyrics).trim()) {
    return String(data.plainLyrics).trim();
  }
  if (data?.syncedLyrics) {
    // Strip the [mm:ss.xx] time tags from synced lyrics.
    return String(data.syncedLyrics)
      .replace(/\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  return null;
}

const TIME_TAG = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/g;

/**
 * Parse an LRC `syncedLyrics` blob into `{ ms, text }` lines, in chronological
 * order (task T3 — used by the lyrics game to time "Escuchar el fragmento").
 * - A line can carry more than one `[mm:ss.xx]` tag (e.g. a repeated chorus
 *   line stamped at each occurrence) — one entry is produced per tag.
 * - Metadata-only tags (`[length: 03:45]`, `[ar:...]`, …) never match
 *   `TIME_TAG` (their first character isn't a digit) and are ignored.
 * - A line whose tag(s) leave no text behind (a timed pause) is dropped —
 *   it carries no lyric content a fragment could ever need.
 * @param {string|null|undefined} syncedLyrics
 * @returns {Array<{ms:number, text:string}>}  empty when there is nothing to parse
 */
export function parseSyncedLyrics(syncedLyrics) {
  if (!syncedLyrics) return [];
  const out = [];
  for (const rawLine of String(syncedLyrics).split("\n")) {
    const tags = [...rawLine.matchAll(TIME_TAG)];
    if (tags.length === 0) continue;
    const text = rawLine.replace(TIME_TAG, "").trim();
    if (!text) continue;
    for (const tag of tags) {
      const minutes = Number(tag[1]);
      const seconds = Number(tag[2]);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
      out.push({ ms: Math.round((minutes * 60 + seconds) * 1000), text });
    }
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

async function fetchJson(url, signal) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, data: await res.json() };
}

function artistString(track) {
  return (track.artists ?? []).map((a) => (typeof a === "string" ? a : a.name)).join(", ");
}

function durationSeconds(track) {
  return Math.round((track.duration_ms ?? 0) / 1000);
}

// Search endpoint fallback: prefer non-instrumental, non-empty plainLyrics whose
// normalized name + artist match; ties broken by closest duration.
async function searchLyrics(track, signal) {
  const params = new URLSearchParams({
    track_name: track.name,
    artist_name: artistString(track),
  });
  const got = await fetchJson(`${LRCLIB_SEARCH}?${params}`, signal);
  if (!got.ok) return { status: "error", text: null, source: null, lines: null };
  const list = Array.isArray(got.data) ? got.data : [];

  const eligible = list.filter(
    (c) => !c.instrumental && c.plainLyrics && String(c.plainLyrics).trim().length > 0
  );
  if (eligible.length === 0) {
    const status = list.some((c) => c.instrumental) ? "instrumental" : "not-found";
    cachePut(track.id, { status, text: null, source: "lrclib", lines: null });
    return { status, text: null, source: "lrclib", lines: null };
  }

  const wantedName = normalize(track.name);
  const wantedArtist = normalize(artistString(track));
  const wantedDur = durationSeconds(track);

  const scored = eligible.map((c) => {
    const cName = normalize(c.trackName ?? "");
    const cArtist = normalize(String(c.artistName ?? "").split(",").map((s) => s.trim()).join(", "));
    const nameMatch = cName === wantedName || isMatch(c.trackName ?? "", track.name);
    const artistMatch = cArtist === wantedArtist || isMatch(c.artistName ?? "", artistString(track));
    const dur = Number(c.duration) || 0;
    let tier = 2;
    if (nameMatch && artistMatch) tier = 0;
    else if (nameMatch || artistMatch) tier = 1;
    return { c, tier, durDiff: Math.abs(dur - wantedDur) };
  });
  scored.sort((a, b) => a.tier - b.tier || a.durDiff - b.durDiff);

  const text = String(scored[0].c.plainLyrics).trim();
  const synced = parseSyncedLyrics(scored[0].c.syncedLyrics);
  const lines = synced.length > 0 ? synced : null;
  cachePut(track.id, { status: "ok", text, source: "lrclib", lines });
  return { status: "ok", text, source: "lrclib", lines };
}

async function fetchLyrics(track, signal) {
  const params = new URLSearchParams({
    artist_name: artistString(track),
    track_name: track.name,
    album_name: track.album?.name ?? "",
    duration: String(durationSeconds(track)),
  });
  const got = await fetchJson(`${LRCLIB_GET}?${params}`, signal);
  if (got.ok) {
    const data = got.data;
    if (data?.instrumental) {
      cachePut(track.id, { status: "instrumental", text: null, source: "lrclib", lines: null });
      return { status: "instrumental", text: null, source: "lrclib", lines: null };
    }
    const text = pickLyrics(data);
    if (text) {
      // The synced lines are parsed independently of which text source was
      // picked: LRCLIB can return plainLyrics AND syncedLyrics together.
      const synced = parseSyncedLyrics(data.syncedLyrics);
      const lines = synced.length > 0 ? synced : null;
      cachePut(track.id, { status: "ok", text, source: "lrclib", lines });
      return { status: "ok", text, source: "lrclib", lines };
    }
    // Exact match had no usable lyrics — fall back to search.
    return searchLyrics(track, signal);
  }
  // 404 (or any non-ok) → search before giving up.
  return searchLyrics(track, signal);
}

/**
 * Resolve lyrics for a track. Always resolves to a plain object
 * `{ status, text, source, lines }`; never rejects.
 *   status: "ok" | "not-found" | "instrumental" | "error"
 *   source: "manual" | "lrclib" | null
 *   lines: `{ms, text}[]` synced timestamps (task T3, "Escuchar el fragmento"),
 *     or null when the source has none (manual pastes never have timing).
 * Network errors are reported as `error` (never cached).
 */
export async function getLyrics(track, { signal } = {}) {
  try {
    const manual = getManualLyrics(track.id);
    if (manual != null && manual.trim()) {
      return { status: "ok", text: manual.trim(), source: "manual", lines: null };
    }
    const cached = cacheGet(track.id);
    if (cached) {
      return { status: cached.status, text: cached.text ?? null, source: cached.source ?? "lrclib", lines: cached.lines ?? null };
    }
    return await fetchLyrics(track, signal);
  } catch {
    // Aborts and any network failure degrade to `error` (never cached).
    return { status: "error", text: null, source: null, lines: null };
  }
}
