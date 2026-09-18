// Spotify Web API client (design D8, library/playback specs).
// Single fetch wrapper: 401 → silent refresh + retry once; 429 /
// QUOTA_EXCEEDED → Retry-After backoff + rate-limit signal to the UI.
// Paging iterates next/offset until exhausted, re-sending the caller's OWN
// query on every page: the page size is per-endpoint (Spotify caps /search at
// 10 since February 2026) and the item shape depends on it, so no page may
// invent its own parameters.
// Removed endpoints (audio-features/analysis, recommendations,
// related-artists) and /playlists/{id}/tracks are NEVER called.

import { API_BASE } from "./config.js";
import * as auth from "./auth.js";

export class ApiError extends Error {
  constructor(status, message) {
    super(message || `Spotify API error ${status}`);
    this.status = status;
    this.name = "ApiError";
  }
}

export class SessionError extends Error {
  constructor() {
    super("Sesión expirada");
    this.name = "SessionError";
  }
}

const rateLimitedListeners = new Set();

/** @param {(retryAfterMs: number) => void} cb */
export function onRateLimited(cb) {
  rateLimitedListeners.add(cb);
  return () => rateLimitedListeners.delete(cb);
}

function notifyRateLimited(retryAfterMs) {
  for (const cb of rateLimitedListeners) cb(retryAfterMs);
}

const ALBUM_TRACK_FIELDS = "id,name,artists(id,name),duration_ms,track_number";

async function request(path, { method = "GET", body, params, signal } = {}) {
  const token = await auth.getAccessToken();
  if (!token) throw new SessionError();

  const url = new URL(`${API_BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }

  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers["Content-Type"] = "application/json";

  const attempt = async (retried) => {
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal });
    } catch (err) {
      // Aborts are caller-driven (superseded search) — never a connection error.
      if (err?.name === "AbortError") throw err;
      throw new ApiError(0, "No se pudo conectar con Spotify");
    }

    if (res.status === 401) {
      if (!retried) {
        const ok = await auth.refreshToken();
        if (ok) return attempt(true);
      }
      throw new SessionError();
    }

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get("Retry-After")) || 5;
      const waitMs = Math.min(30_000, Math.max(1_000, retryAfterSec * 1000));
      notifyRateLimited(waitMs);
      await new Promise((r) => setTimeout(r, waitMs));
      if (!retried) return attempt(true);
      throw new ApiError(429, "Spotify va lento ahora mismo");
    }

    if (res.status === 403) {
      const text = await safeText(res);
      if (/quota_exceeded/i.test(text)) {
        const retryAfterSec = Number(res.headers.get("Retry-After")) || 5;
        const waitMs = Math.min(30_000, Math.max(1_000, retryAfterSec * 1000));
        notifyRateLimited(waitMs);
        await new Promise((r) => setTimeout(r, waitMs));
        if (!retried) return attempt(true);
        throw new ApiError(403, "Spotify va lento ahora mismo");
      }
      if (/premium_required/i.test(text)) throw new ApiError(403, "PREMIUM_REQUIRED");
      throw new ApiError(403, text || "Acceso denegado");
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw new ApiError(res.status, text || `Error ${res.status}`);
    }

    // 204/205 (and empty bodies) carry no JSON — resolve with null instead of
    // throwing: a successful PUT /me/player/play must not look like a failure.
    if (res.status === 204 || res.status === 205) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  };

  return attempt(false);
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Generic authenticated API call (used by player.js for the play endpoint).
 */
export function apiFetch(path, opts = {}) {
  return request(path, opts);
}

/**
 * Paginate a Spotify paging object via its `next`/`offset` links.
 * `params` is re-sent on every page: dropping `fields` (or `market`, or
 * `additional_types`) halfway through changes the item shape between pages,
 * which silently loses whole pages downstream.
 */
async function pageAll(firstPage, extractItems, params = {}) {
  const all = [];
  let page = firstPage;
  let guard = 0;
  while (page && guard < 200) {
    for (const item of extractItems(page)) all.push(item);
    if (!page.next) break;
    const nextUrl = new URL(page.next);
    page = await request(nextUrl.pathname.replace(/^\/v1/, ""), {
      params: nextPageParams(params, nextUrl),
    });
    guard++;
  }
  return all;
}

/**
 * The query for the next page: the caller's own parameters plus the offset
 * Spotify handed back. Never substitutes a page size — a walk that asks for
 * `limit=10` on page one and `limit=50` on page two is a 400 (or a silently
 * different item shape) waiting to happen.
 * @param {object} params the parameters the first page was requested with
 * @param {URL} nextUrl the paging object's `next` link
 */
export function nextPageParams(params, nextUrl) {
  const next = { ...params };
  const offset = nextUrl?.searchParams?.get("offset");
  if (offset !== null && offset !== undefined) next.offset = offset;
  return next;
}

/**
 * Unwrap one page of track rows into plain track objects.
 * Spotify's February 2026 rename moved a playlist row's track under `item`
 * (the legacy `track` key is still mirrored, and /me/tracks only has `track`).
 * Rows with no usable track — episodes, local files, unavailable items — are
 * counted as skipped so the UI can say so instead of quietly losing them.
 * @param {object} page a paging object
 * @returns {{tracks: object[], skipped: number}}
 */
export function unwrapTrackRows(page) {
  const tracks = [];
  let skipped = 0;
  for (const row of page?.items ?? []) {
    const track = row?.item ?? row?.track ?? row;
    if (track?.id && (track.type ?? "track") === "track") tracks.push(track);
    else skipped++;
  }
  return { tracks, skipped };
}

/** Track count of a playlist object, across the `tracks` → `items` rename. */
export function playlistTrackTotal(playlist) {
  return playlist?.items?.total ?? playlist?.tracks?.total ?? null;
}

/** Walk every page of a track listing, tallying what could not be imported. */
async function pageAllTracks(path, params) {
  const first = await request(path, { params });
  let skipped = 0;
  const tracks = await pageAll(first, (page) => {
    const unwrapped = unwrapTrackRows(page);
    skipped += unwrapped.skipped;
    return unwrapped.tracks;
  }, params);
  return { tracks, total: first?.total ?? tracks.length + skipped, skipped };
}

// --- typed endpoints ---------------------------------------------------------

export async function getPlaylists() {
  const params = { limit: 50 };
  const first = await request("/me/playlists", { params });
  return pageAll(first, (p) => (p.items ?? []).filter((pl) => pl?.id), params);
}

/**
 * Every track in a playlist.
 * No `fields` mask: /items nests the track under `item`, so a flat mask
 * matches nothing and returns a page of empty rows.
 * @returns {Promise<{tracks: object[], total: number, skipped: number}>}
 */
export function getPlaylistItems(id) {
  return pageAllTracks(`/playlists/${id}/items`, { limit: 50, additional_types: "track" });
}

/** @returns {Promise<{tracks: object[], total: number, skipped: number}>} */
export function getLikedTracks() {
  return pageAllTracks("/me/tracks", { limit: 50 });
}

// /search caps `limit` at 10 since February 2026 (it used to allow 50).
const SEARCH_LIMIT = 10;

/**
 * Unified catalog search: tracks + albums + playlists in one round trip.
 * Null entries (Spotify returns them for unavailable items) are dropped so
 * views can render the groups without defensive checks.
 * @param {string} query
 * @param {AbortSignal} [signal] caller-owned, to cancel superseded searches
 */
export async function searchCatalog(query, signal) {
  const data = await request("/search", {
    params: { type: "track,album,playlist", limit: SEARCH_LIMIT, q: query },
    signal,
  });
  return {
    tracks: (data.tracks?.items ?? []).filter((t) => t?.id),
    albums: (data.albums?.items ?? []).filter((a) => a?.id),
    playlists: (data.playlists?.items ?? []).filter((p) => p?.id),
  };
}

export async function getPlaylist(id) {
  return request(`/playlists/${id}`);
}

export async function getTrack(id) {
  return request(`/tracks/${id}`);
}

export async function getArtist(id) {
  return request(`/artists/${id}`);
}

export async function getAlbum(id) {
  return request(`/albums/${id}`);
}

/** Album tracklist, paged at 50 (albums/collections can exceed 50 tracks). */
export async function getAlbumTracks(id) {
  const params = { limit: 50, fields: `items(${ALBUM_TRACK_FIELDS}),next` };
  const first = await request(`/albums/${id}/tracks`, { params });
  return pageAll(first, (p) => p.items ?? [], params);
}