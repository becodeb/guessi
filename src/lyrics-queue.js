// Pure play queue for the lyrics game. No DOM, no I/O.
//
// Order as given; shuffle reshuffles only what is still ahead of the current
// song and turning it off restores the original order around the same song.

/** Fisher-Yates on a copy; `rng` returns [0, 1). */
function shuffled(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Tracks the game can actually play. Some Spotify endpoints come back without
 * `uri` (the album tracklist's field mask drops it), and a play request with a
 * missing uri is a 400, so it is rebuilt from the id here.
 * @param {object[]} tracks
 * @returns {object[]}
 */
export function playableTracks(tracks) {
  return (tracks ?? [])
    .filter((t) => t?.id)
    .map((t) => (t.uri ? t : { ...t, uri: `spotify:track:${t.id}` }));
}

/**
 * @param {Array<{id: string}>} tracks
 * @param {{startIndex?: number, rng?: () => number, restore?: {order: string[], shuffle: boolean}}} [opts]
 *   `restore` puts a saved play order and shuffle state back (see `restoreQueue`).
 */
export function createQueue(tracks, { startIndex = 0, rng = Math.random, restore = null } = {}) {
  const seen = new Set();
  let original = [];
  for (const t of tracks ?? []) {
    if (!t?.id || seen.has(t.id)) continue;
    seen.add(t.id);
    original.push(t);
  }
  let order = original.slice();
  let idx = original.length === 0 ? -1 : Math.min(Math.max(0, startIndex), original.length - 1);
  let shuffleOn = false;
  if (restore) {
    const byId = new Map(original.map((t) => [t.id, t]));
    order = restore.order.map((id) => byId.get(id));
    shuffleOn = Boolean(restore.shuffle) && order.length > 0;
  }

  const api = {
    size: () => order.length,
    index: () => idx,
    current: () => (idx >= 0 ? order[idx] : null),
    tracks: () => order.slice(),
    isShuffled: () => shuffleOn,

    /** Plain data to rebuild this queue later: original order, current order, position. */
    snapshot: () => ({
      tracks: original.slice(),
      order: order.map((t) => t.id),
      index: idx,
      shuffle: shuffleOn,
    }),
    hasNext: () => idx >= 0 && idx + 1 < order.length,
    hasPrev: () => idx > 0,

    /** Moves forward and returns the new current song, or null at the end. */
    next() {
      if (!api.hasNext()) return null;
      idx++;
      return order[idx];
    },

    /** Moves back and returns the new current song, or null at the start. */
    prev() {
      if (!api.hasPrev()) return null;
      idx--;
      return order[idx];
    },

    /** Turns shuffle on or off; the current song stays current either way. */
    setShuffle(on) {
      const want = Boolean(on);
      if (want === shuffleOn || idx < 0) {
        shuffleOn = want && idx >= 0;
        return;
      }
      const cur = order[idx];
      if (want) {
        order = [...order.slice(0, idx + 1), ...shuffled(order.slice(idx + 1), rng)];
      } else {
        order = original.slice();
        idx = order.findIndex((t) => t.id === cur.id);
      }
      shuffleOn = want;
    },

    /**
     * Removes a song that cannot be played. When it is the current one the next
     * song (or, at the end, the previous one) becomes current. Returns the
     * current song afterwards, or null when the queue is empty.
     */
    drop(id) {
      const at = order.findIndex((t) => t.id === id);
      if (at === -1) return api.current();
      original = original.filter((t) => t.id !== id);
      order.splice(at, 1);
      if (order.length === 0) idx = -1;
      else if (at < idx) idx--;
      else if (idx >= order.length) idx = order.length - 1;
      return api.current();
    },
  };
  return api;
}

/**
 * Rebuilds a queue from `queue.snapshot()` data. Returns null when the data is
 * not a coherent queue (the saved order must be the same songs, once each).
 */
export function restoreQueue(snap, { rng = Math.random } = {}) {
  const tracks = snap?.tracks;
  const order = snap?.order;
  if (!Array.isArray(tracks) || !Array.isArray(order) || tracks.length === 0) return null;
  const ids = tracks.map((t) => t?.id);
  if (ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) return null;
  if (order.length !== ids.length || new Set(order).size !== order.length) return null;
  const known = new Set(ids);
  if (!order.every((id) => known.has(id))) return null;
  if (!Number.isInteger(snap.index) || snap.index < 0 || snap.index >= order.length) return null;
  return createQueue(tracks, { startIndex: snap.index, rng, restore: { order, shuffle: snap.shuffle } });
}
