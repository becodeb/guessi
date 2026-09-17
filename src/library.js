// Library: import (playlists / liked / search), pending list, "songs I know"
// pool, dedupe, albums set, random draws, album-tracklist cache (library spec).
// No rendering; views read state via getters.

import * as storage from "./storage.js";
import * as api from "./spotify-api.js";

const state = {
  lib: null, // { version, fetchedAt, tracks: {}, albums: {}, pool: [] }
  pending: [], // tracks awaiting user selection (in-memory, per session)
  lastTrackId: null,
  lastAlbumId: null,
};

function ensureLib() {
  if (!state.lib) state.lib = storage.loadLibrary() ?? emptyLib();
  return state.lib;
}

function emptyLib() {
  return {
    version: 1,
    fetchedAt: new Date().toISOString(),
    tracks: {},
    albums: {},
    pool: [],
  };
}

function persist() {
  storage.saveLibrary(state.lib);
}

/** Upsert a track (dedupe by id) and its album into the maps. */
function upsertTrack(track) {
  const lib = ensureLib();
  if (!track?.id) return;
  const existing = lib.tracks[track.id];
  lib.tracks[track.id] = {
    id: track.id,
    uri: track.uri ?? `spotify:track:${track.id}`,
    name: track.name,
    artists: (track.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
    album: {
      id: track.album?.id,
      name: track.album?.name,
      type: track.album?.album_type ?? track.album?.type,
      release_date: track.album?.release_date,
      images: track.album?.images ?? [],
    },
    duration_ms: track.duration_ms,
  };
  const album = track.album;
  if (album?.id) {
    const stored = lib.albums[album.id];
    lib.albums[album.id] = {
      id: album.id,
      name: album.name,
      type: album.album_type ?? album.type,
      artists: (album.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
      release_date: album.release_date,
      total_tracks: album.total_tracks,
      images: album.images ?? [],
      fetchedAt: stored?.fetchedAt ?? new Date().toISOString(),
      tracks: stored?.tracks ?? null,
    };
  }
  // Keep the pool referentially intact (no auto-add on import).
  if (!existing) return; // nothing else to do for new tracks
}

function pushPending(tracks) {
  const ids = new Set(state.pending.map((t) => t.id));
  for (const t of tracks) {
    if (t?.id && !ids.has(t.id) && !ensureLib().pool.includes(t.id)) {
      state.pending.push(t);
      ids.add(t.id);
    }
  }
}

// --- import sources -----------------------------------------------------------

export async function importFromPlaylist(id) {
  const tracks = await api.getPlaylistItems(id);
  for (const t of tracks) upsertTrack(t);
  pushPending(tracks);
  persist();
  return tracks.length;
}

export async function importLiked() {
  const tracks = await api.getLikedTracks();
  for (const t of tracks) upsertTrack(t);
  pushPending(tracks);
  persist();
  return tracks.length;
}

export async function search(query) {
  const tracks = await api.searchTracks(query);
  for (const t of tracks) upsertTrack(t);
  pushPending(tracks);
  persist();
  return tracks.length;
}

// --- pool ("songs I know") -----------------------------------------------------

export function addToPool(ids) {
  const lib = ensureLib();
  let changed = false;
  for (const id of ids) {
    if (lib.tracks[id] && !lib.pool.includes(id)) {
      lib.pool.push(id);
      changed = true;
    }
  }
  // Drop from pending so the pending list shrinks.
  state.pending = state.pending.filter((t) => !ids.includes(t.id));
  if (changed) persist();
}

export function addAllPendingToPool() {
  addToPool(state.pending.map((t) => t.id));
}

/** Remove a song from the pool; prune albums no longer referenced by pool tracks. */
export function removeFromPool(id) {
  const lib = ensureLib();
  lib.pool = lib.pool.filter((pid) => pid !== id);
  const referenced = new Set(lib.pool.map((pid) => lib.tracks[pid]?.album?.id).filter(Boolean));
  for (const albumId of Object.keys(lib.albums)) {
    if (!referenced.has(albumId)) delete lib.albums[albumId];
  }
  persist();
}

// --- getters -------------------------------------------------------------------

export function getPending() {
  return [...state.pending];
}

export function getPool() {
  return [...ensureLib().pool];
}

export function getPoolTracks() {
  const lib = ensureLib();
  return lib.pool.map((id) => lib.tracks[id]).filter(Boolean);
}

export function getPoolCount() {
  return ensureLib().pool.length;
}

export function getTrackCount() {
  return Object.keys(ensureLib().tracks).length;
}

export function isInPool(id) {
  return ensureLib().pool.includes(id);
}

/** Albums referenced by pool tracks (the Game 2 draw set). */
export function getAlbums() {
  const lib = ensureLib();
  const referenced = new Set(
    lib.pool.map((id) => lib.tracks[id]?.album?.id).filter(Boolean)
  );
  return [...referenced].map((id) => lib.albums[id]).filter(Boolean);
}

/** Random pool track, avoiding an immediate repeat when feasible. */
export function getRandomTrack() {
  const pool = getPoolTracks();
  if (pool.length === 0) return null;
  let track;
  if (pool.length === 1) {
    track = pool[0];
  } else {
    const candidates = pool.filter((t) => t.id !== state.lastTrackId);
    track = candidates[Math.floor(Math.random() * candidates.length)];
  }
  state.lastTrackId = track.id;
  return track;
}

/** Random album from the draw set, avoiding an immediate repeat when feasible. */
export function getRandomAlbum() {
  const albums = getAlbums();
  if (albums.length === 0) return null;
  let album;
  if (albums.length === 1) {
    album = albums[0];
  } else {
    const candidates = albums.filter((a) => a.id !== state.lastAlbumId);
    album = candidates[Math.floor(Math.random() * candidates.length)];
  }
  state.lastAlbumId = album.id;
  return album;
}

/**
 * Full album tracklist for Game 2: cached in storage by albumId; fetched
 * from /albums/{id}/tracks (paginated >50) on first access.
 */
export async function getAlbumTracklist(albumId) {
  const lib = ensureLib();
  const album = lib.albums[albumId];
  if (!album) return [];
  if (Array.isArray(album.tracks)) return album.tracks;
  const tracks = await api.getAlbumTracks(albumId);
  album.tracks = tracks;
  persist();
  return tracks;
}

/** Refresh album metadata (fresh cover URL) and update the cache. */
export async function refreshAlbum(albumId) {
  const fresh = await api.getAlbum(albumId);
  const lib = ensureLib();
  const stored = lib.albums[albumId];
  if (stored && fresh) {
    lib.albums[albumId] = {
      ...stored,
      name: fresh.name,
      artists: (fresh.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
      release_date: fresh.release_date,
      total_tracks: fresh.total_tracks,
      images: fresh.images ?? [],
      fetchedAt: new Date().toISOString(),
    };
    persist();
  }
  return lib.albums[albumId] ?? null;
}

/** Raw library for views that need the full maps (e.g. membership marks). */
export function getLibrary() {
  return ensureLib();
}