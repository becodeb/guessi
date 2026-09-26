// Versioned localStorage persistence (design "Data Model" section).
// Keys: deoido.v1.tokens | deoido.v1.auth_state | deoido.v1.library
// This module knows nothing about the Spotify API.

import { COVER_TTL_MS } from "./config.js";

const PREFIX = "deoido.v1.";
const KEYS = {
  tokens: `${PREFIX}tokens`,
  authState: `${PREFIX}auth_state`,
  library: `${PREFIX}library`,
  lyrics: `${PREFIX}lyrics`,
  manualLyrics: `${PREFIX}manualLyrics`,
  lyricsGameMode: `${PREFIX}lyricsGameMode`,
};

// v1 nested a full album copy (covers included) inside every track and kept
// every imported track forever, which tripled the payload: a big "Me gusta"
// blew the localStorage quota, the write failed silently and the library
// vanished on reload. v2 stores each album once in `albums` (tracks only carry
// `albumId`) and persists just the pool — the pending list is per-session.
const LIBRARY_VERSION = 2;
const READABLE_VERSIONS = [1, LIBRARY_VERSION];

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Quota exceeded or private mode: the caller decides how to degrade.
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

// --- library (compact v2 codec) ----------------------------------------------

/** Album metadata as stored: covers + `fetchedAt`, plus the Game 2 tracklist cache. */
function albumRecord(source, albumId) {
  return {
    id: albumId,
    name: source?.name ?? "",
    type: source?.type ?? source?.album_type ?? null,
    artists: (source?.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
    release_date: source?.release_date ?? null,
    total_tracks: source?.total_tracks ?? null,
    images: source?.images ?? [],
    fetchedAt: source?.fetchedAt ?? new Date().toISOString(),
    tracks: Array.isArray(source?.tracks) ? source.tracks : null,
  };
}

/** In-memory library → stored snapshot (albums normalized, pool only). */
function compactLibrary(library) {
  const tracks = {};
  const albums = {};
  const pool = [];
  for (const id of library.pool ?? []) {
    const track = library.tracks?.[id];
    if (!track?.id) continue;
    pool.push(id);
    tracks[id] = {
      id: track.id,
      name: track.name,
      artists: track.artists ?? [],
      albumId: track.album?.id ?? null,
      duration_ms: track.duration_ms,
    };
    // The uri is derivable from the id; only store it when it differs.
    if (track.uri && track.uri !== `spotify:track:${track.id}`) tracks[id].uri = track.uri;
    const albumId = tracks[id].albumId;
    if (!albumId || albums[albumId]) continue;
    albums[albumId] = albumRecord(library.albums?.[albumId] ?? track.album, albumId);
  }
  return { version: LIBRARY_VERSION, fetchedAt: new Date().toISOString(), tracks, albums, pool };
}

/** Stored snapshot (v1 or v2) → in-memory library (tracks own their album). */
function expandLibrary(data) {
  const albums = {};
  for (const [id, album] of Object.entries(data.albums ?? {})) albums[id] = albumRecord(album, id);
  const tracks = {};
  for (const [id, track] of Object.entries(data.tracks ?? {})) {
    const trackId = track.id ?? id;
    const albumId = track.albumId ?? track.album?.id ?? null;
    // v1 kept the album copy inside the track: promote it to the albums map.
    if (albumId && !albums[albumId] && track.album) albums[albumId] = albumRecord(track.album, albumId);
    tracks[id] = {
      id: trackId,
      uri: track.uri ?? `spotify:track:${trackId}`,
      name: track.name,
      artists: track.artists ?? [],
      album: albums[albumId] ?? { id: albumId },
      duration_ms: track.duration_ms,
    };
  }
  const pool = (Array.isArray(data.pool) ? data.pool : []).filter((id) => tracks[id]);
  return {
    version: LIBRARY_VERSION,
    fetchedAt: data.fetchedAt ?? new Date().toISOString(),
    tracks,
    albums,
    pool,
  };
}

/**
 * Load the persisted library. Returns null when absent or on an unknown schema
 * version (unknown discards the library, keeps tokens, and the empty-library
 * import guide takes over — design "Migration policy"). v1 migrates in place:
 * expanded through the same codec, then re-compacted on the next save.
 */
export function loadLibrary() {
  const data = read(KEYS.library, null);
  if (!data || typeof data !== "object") return null;
  if (!READABLE_VERSIONS.includes(data.version)) {
    remove(KEYS.library);
    return null;
  }
  return expandLibrary(data);
}

/**
 * Persist the library and report what happened. On a quota error the album
 * tracklist caches (re-fetchable by Game 2) are dropped and the write is
 * retried once, so the pool is never silently lost.
 * @returns {{ ok: boolean, droppedTracklists: boolean }}
 */
export function saveLibrary(library) {
  const snapshot = compactLibrary(library);
  if (write(KEYS.library, snapshot)) return { ok: true, droppedTracklists: false };
  const withoutTracklists = {};
  for (const [id, album] of Object.entries(snapshot.albums)) {
    withoutTracklists[id] = { ...album, tracks: null };
  }
  if (write(KEYS.library, { ...snapshot, albums: withoutTracklists })) {
    return { ok: true, droppedTracklists: true };
  }
  return { ok: false, droppedTracklists: true };
}

export function clearLibrary() {
  remove(KEYS.library);
}

// --- tokens -----------------------------------------------------------------

export function loadTokens() {
  return read(KEYS.tokens, null);
}

export function saveTokens(tokens) {
  write(KEYS.tokens, tokens);
}

export function clearTokens() {
  remove(KEYS.tokens);
}

// --- transient PKCE state ----------------------------------------------------

export function getAuthState() {
  return read(KEYS.authState, null);
}

export function setAuthState(state) {
  write(KEYS.authState, state);
}

export function clearAuthState() {
  remove(KEYS.authState);
}

// --- perishable covers -------------------------------------------------------

/** True when a stored cover's fetchedAt is older than the freshness window. */
export function isStaleCover(fetchedAt) {
  if (!fetchedAt) return true;
  const at = new Date(fetchedAt).getTime();
  if (Number.isNaN(at)) return true;
  return Date.now() - at > COVER_TTL_MS;
}

// --- lyrics cache (LRCLIB results, persisted per-track, polite-usage TTL) ---

export function loadLyricsCache() {
  return read(KEYS.lyrics, {});
}

export function saveLyricsCache(cache) {
  write(KEYS.lyrics, cache);
}

// --- manual lyrics overrides (user-pasted; never expire) --------------------

export function loadManualLyrics() {
  return read(KEYS.manualLyrics, {});
}

export function saveManualLyrics(map) {
  write(KEYS.manualLyrics, map);
}

// --- lyrics game mode preference (task T4 — pure convenience, never blocks) --

/** Last chosen "Completa la letra" mode ("timed" | "full"), or null. */
export function loadLyricsGameMode() {
  const v = read(KEYS.lyricsGameMode, null);
  return v === "timed" || v === "full" ? v : null;
}

export function saveLyricsGameMode(mode) {
  write(KEYS.lyricsGameMode, mode);
}