// The lyrics game's session, as kept on this device between reloads. Pure: no
// DOM, no storage. The game builds a plain object with `buildSession`, storage
// keeps it as JSON, and `parseSession` turns whatever comes back into data the
// game can trust, or null.
//
// Kept: the queue (songs, order, position, shuffle, repeat) and, per song with
// progress, what was revealed and how, hint letters, cursor, counters, where the
// song was, and the identity of its history record. Not kept: the half-typed
// word, audio state, scroll, open dialogs.

import { restoreQueue } from "./lyrics-queue.js";

export const SESSION_VERSION = 1;
/** A session older than this is not worth coming back to. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// One character per word: `.` open, then how the word was revealed.
const CODE_OF = { typed: "t", hint: "h", line: "l", repeat: "r", giveup: "g" };
const HOW_OF = Object.fromEntries(Object.entries(CODE_OF).map(([how, c]) => [c, how]));

/** `[null, "typed", "hint"]` → `".th"` */
export function encodeHow(how) {
  return how.map((m) => (m == null ? "." : CODE_OF[m] ?? "?")).join("");
}

/** `".th"` → `[null, "typed", "hint"]`; null when a character is unknown. */
export function decodeHow(text) {
  if (typeof text !== "string") return null;
  const out = [];
  for (const c of text) {
    if (c === ".") out.push(null);
    else if (HOW_OF[c]) out.push(HOW_OF[c]);
    else return null;
  }
  return out;
}

/** Word count plus a hash of the words' texts: changes whenever the lyrics do. */
export function lyricsSignature(parsed) {
  const words = parsed?.words ?? [];
  // FNV-1a over the texts, a separator between words so "ab c" differs from "a bc".
  let h = 0x811c9dc5;
  for (const w of words) {
    for (const ch of `${w.text}\u0001`) {
      h ^= ch.codePointAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return `${words.length}:${h.toString(36)}`;
}

// --- tracks ----------------------------------------------------------------------

/** The few fields the game shows and plays; covers keep url and width only. */
export function compactTrack(t) {
  const out = {
    id: t.id,
    uri: t.uri || `spotify:track:${t.id}`,
    name: t.name ?? "",
    artists: (t.artists ?? []).map((a) => (typeof a === "string" ? a : a?.name ?? "")),
    album: t.album?.name ?? "",
    images: (t.album?.images ?? []).filter((i) => i?.url).map((i) => (i.width ? { url: i.url, width: i.width } : { url: i.url })),
    ms: t.duration_ms ?? 0,
  };
  return out;
}

export function expandTrack(c) {
  return {
    id: c.id,
    uri: c.uri || `spotify:track:${c.id}`,
    name: c.name ?? "",
    artists: (c.artists ?? []).map((name) => ({ name })),
    album: { name: c.album ?? "", images: (c.images ?? []).map((i) => ({ ...i })) },
    duration_ms: c.ms ?? 0,
  };
}

// --- one song's progress ---------------------------------------------------------

const nat = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/**
 * @param {{sig: string, engine: object, pos?: number, playId?: string|null,
 *   t0?: number, activeMs?: number, elapsed?: number}} song
 */
export function encodeSong(song) {
  const e = song.engine;
  const out = {
    sig: song.sig,
    how: encodeHow(e.how),
    cur: e.cursor,
    streak: e.streak,
    best: e.bestStreak,
    miss: e.misses,
    jumps: e.jumps,
  };
  if (e.hints && Object.keys(e.hints).length > 0) out.hints = e.hints;
  if (e.confirmed && Object.keys(e.confirmed).length > 0) out.conf = e.confirmed;
  if (song.pos > 0) out.pos = nat(song.pos);
  if (song.playId) {
    out.play = song.playId;
    out.t0 = nat(song.t0);
    out.act = nat(song.activeMs);
  }
  if (song.elapsed > 0) out.el = nat(song.elapsed);
  return out;
}

export function decodeSong(rec) {
  if (!rec || typeof rec !== "object" || typeof rec.sig !== "string") return null;
  const how = decodeHow(rec.how);
  if (!how) return null;
  const map = (m) => (m && typeof m === "object" && !Array.isArray(m) ? m : {});
  return {
    sig: rec.sig,
    engine: {
      how,
      hints: map(rec.hints),
      confirmed: map(rec.conf),
      cursor: rec.cur,
      streak: nat(rec.streak),
      bestStreak: nat(rec.best),
      misses: nat(rec.miss),
      jumps: nat(rec.jumps),
    },
    pos: nat(rec.pos),
    playId: typeof rec.play === "string" && rec.play ? rec.play : null,
    t0: nat(rec.t0),
    activeMs: nat(rec.act),
    elapsed: nat(rec.el),
  };
}

// --- the session -----------------------------------------------------------------

/**
 * @param {{queue: object, repeat: boolean, songs: Record<string, object>, now?: number}} p
 *   `queue` is `createQueue(...).snapshot()`; `songs` maps a track id to the
 *   argument of `encodeSong`. Songs that are not in the queue are left out.
 */
export function buildSession({ queue, repeat, songs, now = Date.now() }) {
  const out = {};
  for (const t of queue.tracks) {
    if (songs?.[t.id]) out[t.id] = encodeSong(songs[t.id]);
  }
  return {
    v: SESSION_VERSION,
    savedAt: now,
    tracks: queue.tracks.map(compactTrack),
    order: queue.order.slice(),
    index: queue.index,
    shuffle: Boolean(queue.shuffle),
    repeat: Boolean(repeat),
    songs: out,
  };
}

/**
 * Whatever was read back (any JSON) → `{queue, repeat, songs, savedAt}` or null
 * when it is missing, from another version, expired or not a coherent queue.
 * `songs` maps a track id to `{sig, engine, pos, playId, t0, activeMs, elapsed}`;
 * a song record that does not decode is simply left out.
 */
export function parseSession(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.v !== SESSION_VERSION) return null;
  if (!Number.isFinite(raw.savedAt) || now - raw.savedAt > SESSION_TTL_MS) return null;
  if (!Array.isArray(raw.tracks) || !Array.isArray(raw.order)) return null;
  if (raw.tracks.some((t) => !t || typeof t.id !== "string" || !t.id)) return null;
  const queue = {
    tracks: raw.tracks.map(expandTrack),
    order: raw.order,
    index: raw.index,
    shuffle: Boolean(raw.shuffle),
  };
  if (!restoreQueue(queue)) return null;
  const songs = {};
  const known = new Set(queue.order);
  if (raw.songs && typeof raw.songs === "object" && !Array.isArray(raw.songs)) {
    for (const [id, rec] of Object.entries(raw.songs)) {
      const song = known.has(id) ? decodeSong(rec) : null;
      if (song) songs[id] = song;
    }
  }
  return { savedAt: raw.savedAt, queue, repeat: Boolean(raw.repeat), songs };
}

/** The song the session would come back to, with its place in the list. */
export function sessionSummary(session) {
  const id = session.queue.order[session.queue.index];
  const track = session.queue.tracks.find((t) => t.id === id);
  return { track, number: session.queue.index + 1, size: session.queue.order.length };
}
