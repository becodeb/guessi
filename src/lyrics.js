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
  const age = Date.now() - new Date(entry.fetchedAt).getTime();
  const ttl = entry.status === "ok" ? TTL_POSITIVE_MS : TTL_NEGATIVE_MS;
  return age > ttl ? null : entry;
}

function cachePut(trackId, entry) {
  const cache = loadLyricsCache();
  cache[trackId] = { ...entry, fetchedAt: new Date().toISOString() };
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
  if (!got.ok) return { status: "error", text: null, source: null };
  const list = Array.isArray(got.data) ? got.data : [];

  const eligible = list.filter(
    (c) => !c.instrumental && c.plainLyrics && String(c.plainLyrics).trim().length > 0
  );
  if (eligible.length === 0) {
    const status = list.some((c) => c.instrumental) ? "instrumental" : "not-found";
    cachePut(track.id, { status, text: null, source: "lrclib" });
    return { status, text: null, source: "lrclib" };
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
  cachePut(track.id, { status: "ok", text, source: "lrclib" });
  return { status: "ok", text, source: "lrclib" };
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
      cachePut(track.id, { status: "instrumental", text: null, source: "lrclib" });
      return { status: "instrumental", text: null, source: "lrclib" };
    }
    const text = pickLyrics(data);
    if (text) {
      cachePut(track.id, { status: "ok", text, source: "lrclib" });
      return { status: "ok", text, source: "lrclib" };
    }
    // Exact match had no usable lyrics — fall back to search.
    return searchLyrics(track, signal);
  }
  // 404 (or any non-ok) → search before giving up.
  return searchLyrics(track, signal);
}

/**
 * Resolve lyrics for a track. Always resolves to a plain object
 * `{ status, text, source }`; never rejects.
 *   status: "ok" | "not-found" | "instrumental" | "error"
 *   source: "manual" | "lrclib" | null
 * Network errors are reported as `error` (never cached).
 */
export async function getLyrics(track, { signal } = {}) {
  try {
    const manual = getManualLyrics(track.id);
    if (manual != null && manual.trim()) {
      return { status: "ok", text: manual.trim(), source: "manual" };
    }
    const cached = cacheGet(track.id);
    if (cached) {
      return { status: cached.status, text: cached.text ?? null, source: cached.source ?? "lrclib" };
    }
    return await fetchLyrics(track, signal);
  } catch {
    // Aborts and any network failure degrade to `error` (never cached).
    return { status: "error", text: null, source: null };
  }
}
