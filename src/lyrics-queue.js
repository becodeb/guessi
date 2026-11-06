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
 * @param {Array<{id: string}>} tracks
 * @param {{startIndex?: number, rng?: () => number}} [opts]
 */
export function createQueue(tracks, { startIndex = 0, rng = Math.random } = {}) {
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

  const api = {
    size: () => order.length,
    index: () => idx,
    current: () => (idx >= 0 ? order[idx] : null),
    tracks: () => order.slice(),
    isShuffled: () => shuffleOn,
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
