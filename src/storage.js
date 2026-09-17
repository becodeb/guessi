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
};

const LIBRARY_VERSION = 1;

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
  } catch {
    // Quota exceeded or private mode: app keeps working in memory-only mode.
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore.
  }
}

// --- library ----------------------------------------------------------------

/**
 * Load the persisted library. Returns null when absent or on schema
 * version mismatch (mismatch discards the library, keeps tokens, and the
 * empty-library import guide takes over — design "Migration policy").
 */
export function loadLibrary() {
  const data = read(KEYS.library, null);
  if (!data) return null;
  if (data.version !== LIBRARY_VERSION) {
    remove(KEYS.library);
    return null;
  }
  return {
    version: LIBRARY_VERSION,
    fetchedAt: data.fetchedAt ?? new Date().toISOString(),
    tracks: data.tracks ?? {},
    albums: data.albums ?? {},
    pool: Array.isArray(data.pool) ? data.pool : [],
  };
}

export function saveLibrary(library) {
  write(KEYS.library, {
    version: LIBRARY_VERSION,
    fetchedAt: new Date().toISOString(),
    tracks: library.tracks ?? {},
    albums: library.albums ?? {},
    pool: library.pool ?? [],
  });
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