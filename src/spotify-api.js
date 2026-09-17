// Spotify Web API client (design D8, library/playback specs).
// Single fetch wrapper: 401 → silent refresh + retry once; 429 /
// QUOTA_EXCEEDED → Retry-After backoff + rate-limit signal to the UI.
// Paging always uses limit=50 and iterates next/offset until exhausted.
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

// Item shape used across playlist/liked/album-tracks paging.
const ITEM_FIELDS = "id,name,artists(id,name),album(id,name,album_type,release_date,images,artists(id,name),total_tracks),duration_ms";
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

/** Paginate a Spotify paging object via its `next`/`offset` links. */
async function pageAll(firstPage, extractItems) {
  const all = [];
  let page = firstPage;
  let guard = 0;
  while (page && guard < 200) {
    for (const item of extractItems(page)) all.push(item);
    if (!page.next) break;
    const nextUrl = new URL(page.next);
    const offset = nextUrl.searchParams.get("offset");
    const params = { limit: 50 };
    if (offset !== null) params.offset = offset;
    // Re-request the same resource path with the next offset (limit=50).
    page = await request(`${nextUrl.pathname.replace("/v1", "")}`, { params });
    guard++;
  }
  return all;
}

// --- typed endpoints ---------------------------------------------------------

export async function getPlaylists() {
  const first = await request("/me/playlists", { params: { limit: 50 } });
  return pageAll(first, (p) => (p.items ?? []).filter((pl) => pl?.id));
}

export async function getPlaylistItems(id) {
  const first = await request(`/playlists/${id}/items`, {
    params: { limit: 50, fields: `items(${ITEM_FIELDS}),next` },
  });
  // `/items` items carry `.item`; the older `.track` key is kept as a fallback.
  const tracks = await pageAll(first, (p) =>
    (p.items ?? []).map((it) => it.track ?? it.item ?? it).filter((t) => t && t.id)
  );
  return tracks;
}

export async function getLikedTracks() {
  const first = await request("/me/tracks", {
    params: { limit: 50, fields: `items(track(${ITEM_FIELDS})),next` },
  });
  return pageAll(first, (p) =>
    (p.items ?? []).map((it) => it.track ?? it).filter((t) => t && t.id)
  );
}

/**
 * Unified catalog search: tracks + albums + playlists in one round trip.
 * Null entries (Spotify returns them for unavailable items) are dropped so
 * views can render the groups without defensive checks.
 * @param {string} query
 * @param {AbortSignal} [signal] caller-owned, to cancel superseded searches
 */
export async function searchCatalog(query, signal) {
  const data = await request("/search", {
    params: { type: "track,album,playlist", limit: 12, q: query },
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
  const first = await request(`/albums/${id}/tracks`, {
    params: { limit: 50, fields: `items(${ALBUM_TRACK_FIELDS}),next` },
  });
  return pageAll(first, (p) => p.items ?? []);
}