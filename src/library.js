// Library: import (playlists / liked / search / albums / pasted links),
// pending list, "songs I know" pool, dedupe, albums set, random draws,
// album-tracklist cache (library spec). No rendering; views read state via
// getters.

import * as storage from "./storage.js";
import * as api from "./spotify-api.js";
import * as match from "./match.js";

/**
 * Thrown when Spotify hands over a playlist's name but not its songs.
 * Since February 2026 a playlist you do not own returns metadata only, which
 * covers every Spotify-made list: «This Is …», Discover Weekly, Radar.
 */
export class UnreadablePlaylistError extends Error {
  constructor(playlist) {
    super("Spotify no comparte las canciones de esta playlist");
    this.name = "UnreadablePlaylistError";
    this.playlist = playlist ?? null;
  }
}

/** True for the statuses Spotify uses to hide content from this app. */
function isBlocked(err) {
  return err?.status === 404 || err?.status === 403;
}

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
    version: 2,
    fetchedAt: new Date().toISOString(),
    tracks: {},
    albums: {},
    pool: [],
  };
}

const saveListeners = new Set();

/**
 * Subscribe to persistence results: `{ ok, droppedTracklists }`. Views use it
 * to warn when the browser storage is full and the pool could not be saved.
 * @param {(result: {ok: boolean, droppedTracklists: boolean}) => void} cb
 */
export function onSaveResult(cb) {
  saveListeners.add(cb);
  return () => saveListeners.delete(cb);
}

function persist() {
  const result = storage.saveLibrary(state.lib);
  for (const cb of saveListeners) cb(result);
  return result;
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
      // Album artists must survive the in-session import too: the round's
      // album card draws its album-level artist slots from them (after a
      // reload the full record comes from the albums map).
      artists: (track.album?.artists ?? []).map((a) => ({ id: a.id, name: a.name })),
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

/**
 * Upsert raw API tracks and queue them for selection.
 * @param {object[]} tracks
 * @returns {number} how many are NEW in the pending list (0 when every track
 *   was already pending or in the pool).
 */
export function addTracks(tracks) {
  const before = state.pending.length;
  for (const t of tracks) upsertTrack(t);
  pushPending(tracks);
  persist();
  return state.pending.length - before;
}

export async function importFromPlaylist(id) {
  const { tracks } = await api.getPlaylistItems(id);
  return { fetched: tracks.length, added: addTracks(tracks) };
}

export async function importLiked() {
  const { tracks } = await api.getLikedTracks();
  return { fetched: tracks.length, added: addTracks(tracks) };
}

/** Whole album: metadata + full tracklist (also cached for Game 2). */
export async function importAlbum(id) {
  const [album, tracks] = await Promise.all([api.getAlbum(id), api.getAlbumTracks(id)]);
  const full = tracks.map((t) => ({ ...t, album }));
  const added = addTracks(full);
  const lib = ensureLib();
  if (lib.albums[id]) {
    lib.albums[id].tracks = tracks;
    lib.albums[id].fetchedAt = new Date().toISOString();
    persist();
  }
  return { fetched: full.length, added };
}

export async function importTrack(id) {
  const track = await api.getTrack(id);
  return { fetched: 1, added: addTracks([track]) };
}

/**
 * Everything a reference points at, fetched but NOT stored: the import dialog
 * shows this and only what the user keeps reaches the library.
 * @param {{type: string, id: string}} ref
 * @returns {Promise<{tracks: object[], total: number, skipped: number, album?: object, rawTracks?: object[]}>}
 */
export async function previewRef({ type, id }, onProgress) {
  if (type === "playlist") return previewPlaylist(id);
  if (type === "artist") return previewArtist(id, onProgress);
  if (type === "album") {
    const [album, tracks] = await Promise.all([api.getAlbum(id), api.getAlbumTracks(id)]);
    const full = tracks.map((t) => ({ ...t, album }));
    // `rawTracks` is what the Game 2 cache stores: the album is already the
    // key, so repeating it inside every track would only bloat storage.
    return { tracks: full, rawTracks: tracks, total: album?.total_tracks ?? full.length, skipped: 0, album };
  }
  if (type === "track") {
    const track = await api.getTrack(id);
    return { tracks: track?.id ? [track] : [], total: track?.id ? 1 : 0, skipped: 0 };
  }
  return { tracks: [], total: 0, skipped: 0 };
}

/**
 * Whether a playlist that yielded no songs was withheld rather than empty.
 * Only a list that explicitly declares zero is genuinely empty: an unknown
 * count means Spotify handed over metadata and kept the contents.
 * @param {{fetched: number, declared: number|null}} counts
 */
export function looksWithheld({ fetched, declared }) {
  return fetched === 0 && declared !== 0;
}

/**
 * A playlist's songs, or a clear failure when Spotify withholds them.
 * Telling "blocked" apart from "empty" is the whole point of also reading
 * the metadata: both come back as zero tracks otherwise.
 */
async function previewPlaylist(id) {
  const [meta, page] = await Promise.all([
    api.getPlaylist(id).catch((err) => {
      if (isBlocked(err)) return null;
      throw err;
    }),
    api.getPlaylistItems(id).catch((err) => {
      if (isBlocked(err)) return null;
      throw err;
    }),
  ]);
  const declared = api.playlistTrackTotal(meta);
  if (!page || looksWithheld({ fetched: page.tracks.length, declared })) {
    throw new UnreadablePlaylistError(meta);
  }
  return { ...page, total: page.total || declared || page.tracks.length };
}

/**
 * Release order for a discography sweep: studio albums first, then
 * compilations, then singles and EPs; oldest first inside each group.
 * The dedupe below keeps whichever pressing it meets first, so this ordering
 * is what makes the album cut win over the single.
 */
function releaseRank(album) {
  const kind = album?.album_group ?? album?.album_type ?? "";
  if (kind === "album") return 0;
  if (kind === "compilation") return 1;
  return 2;
}

function byRelease(a, b) {
  const rank = releaseRank(a) - releaseRank(b);
  if (rank !== 0) return rank;
  return String(a?.release_date ?? "").localeCompare(String(b?.release_date ?? ""));
}

/**
 * Every song an artist released, walked album by album.
 * Spotify has no "all tracks by artist" endpoint and the batch album endpoint
 * was removed in February 2026, so this costs one request per release — hence
 * the progress callback, because a long discography is a visibly slow import.
 * @param {string} id
 * @param {(p: {done: number, total: number}) => void} [onProgress]
 */
async function previewArtist(id, onProgress) {
  const [artist, albums] = await Promise.all([api.getArtist(id), api.getArtistAlbums(id)]);
  const ordered = [...albums].sort(byRelease);
  const tracks = [];
  const seen = new Set();
  let done = 0;
  onProgress?.({ done, total: ordered.length });
  for (const album of ordered) {
    for (const track of await api.getAlbumTracks(album.id)) {
      // One hit ships on the album, on its own single and on the deluxe
      // edition, each with a different track id. Keep one.
      const credits = (track?.artists ?? []).map((a) => a.id).sort().join(",");
      const key = `${match.normalize(track?.name)}|${credits}`;
      if (!track?.id || seen.has(key)) continue;
      seen.add(key);
      tracks.push({ ...track, album });
    }
    done++;
    onProgress?.({ done, total: ordered.length });
  }
  return { tracks, total: tracks.length, skipped: 0, artist, albumCount: ordered.length };
}

/** Liked songs, staged the same way as a reference. */
export function previewLiked() {
  return api.getLikedTracks();
}

/** Most-played songs, staged the same way as a reference. */
export function previewTopTracks(timeRange) {
  return api.getTopTracks(timeRange);
}

/**
 * Put the chosen tracks straight into «Lo que sé» — importing IS adding.
 * @param {object[]} tracks the tracks that were offered
 * @param {Iterable<string>} ids the subset the user kept
 * @returns {{added: number, already: number}} added is what the pool gained
 */
export function commitTracks(tracks, ids) {
  const keep = new Set(ids);
  const lib = ensureLib();
  let added = 0;
  let already = 0;
  for (const track of tracks) {
    if (!track?.id || !keep.has(track.id)) continue;
    upsertTrack(track);
    if (lib.pool.includes(track.id)) {
      already++;
    } else {
      lib.pool.push(track.id);
      added++;
    }
  }
  // A track the user just decided on is no longer awaiting a decision.
  state.pending = state.pending.filter((t) => !keep.has(t.id));
  persist();
  return { added, already };
}

/** Cache a freshly fetched album tracklist so Game 2 does not refetch it. */
export function cacheAlbumTracklist(albumId, tracks) {
  const lib = ensureLib();
  const album = lib.albums[albumId];
  if (!album || !Array.isArray(tracks)) return;
  album.tracks = tracks;
  album.fetchedAt = new Date().toISOString();
  persist();
}

/** Resolve a parsed Spotify link to its display metadata (no side effects). */
export async function resolveRef({ type, id }) {
  if (type === "track") return { kind: "track", item: await api.getTrack(id) };
  if (type === "album") return { kind: "album", item: await api.getAlbum(id) };
  if (type === "artist") return { kind: "artist", item: await api.getArtist(id) };
  if (type === "playlist") {
    // A blocked playlist is a real answer, not a network failure: the view
    // explains why instead of showing "we could not read that link".
    const item = await api.getPlaylist(id).catch((err) => {
      if (isBlocked(err)) return null;
      throw err;
    });
    return { kind: "playlist", item, blocked: !item };
  }
  return null;
}

/** Import whatever a parsed Spotify link points at. */
export async function importRef({ type, id }) {
  if (type === "album") return importAlbum(id);
  if (type === "playlist") return importFromPlaylist(id);
  if (type === "track") return importTrack(id);
  return { fetched: 0, added: 0 };
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

/** Empty «Lo que sé»: the stored snapshot keeps only pool-referenced data. */
export function clearPool() {
  const lib = ensureLib();
  lib.pool = [];
  state.lastTrackId = null;
  state.lastAlbumId = null;
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

export function isPending(id) {
  return state.pending.some((t) => t.id === id);
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