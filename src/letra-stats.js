// History of lyrics-game plays: one record per song played, kept on this device.
// Pure: no DOM, no storage; the game builds and saves records through these.
//
// Records are made to be uploaded later (to compare with friends): each has a
// stable id, a schema version and plain values only, so a future sync can send
// the local history as is and dedupe by id.

export const HISTORY_VERSION = 1;
export const HISTORY_CAP = 2000;
/** A pause longer than this doesn't count as time playing. */
export const IDLE_GAP_MS = 30000;

export function newPlayId(rng = Math.random) {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.floor(rng() * 1e9).toString(36)}`;
}

/** Adds the time since the last keystroke unless the player was away. */
export function addActiveTime(activeMs, lastAt, now, gapMs = IDLE_GAP_MS) {
  if (!lastAt) return activeMs;
  const d = now - lastAt;
  return d > 0 && d <= gapMs ? activeMs + d : activeMs;
}

/**
 * @param {object} p
 * @param {string} p.id
 * @param {{id:string, uri?:string, name?:string, artists?:Array, album?:object, duration_ms?:number}} p.track
 * @param {object} p.stats the typing engine's stats()
 * @param {"complete"|"gaveup"|"open"} p.status
 * @param {number} p.startedAt ms
 * @param {number} p.endedAt ms
 * @param {number} p.activeMs
 * @param {"synced"|"plain"} [p.source] whether the lyrics had timing
 */
export function buildRecord({ id, track, stats, status, startedAt, endedAt, activeMs, source }) {
  const s = stats ?? {};
  return {
    v: HISTORY_VERSION,
    id,
    game: "letra",
    status,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    activeMs: Math.max(0, Math.round(activeMs ?? 0)),
    track: {
      id: track.id,
      uri: track.uri ?? `spotify:track:${track.id}`,
      name: track.name ?? "",
      artists: (track.artists ?? []).map((a) => (typeof a === "string" ? a : a?.name ?? "")).filter(Boolean),
      album: track.album?.name ?? "",
      durationMs: track.duration_ms ?? 0,
    },
    words: {
      total: s.total ?? 0,
      typed: s.typed ?? 0,
      repeated: s.repeated ?? 0,
      byHint: s.byHint ?? 0,
      byLine: s.byLine ?? 0,
      givenUp: s.givenUp ?? 0,
      open: s.open ?? 0,
    },
    pct: s.pct ?? 0,
    bestStreak: s.bestStreak ?? 0,
    misses: s.misses ?? 0,
    jumps: s.jumps ?? 0,
    source: source ?? "plain",
  };
}

/** Replaces the record with the same id, or appends it; keeps the newest `cap`. */
export function upsertRecord(list, record, cap = HISTORY_CAP) {
  const out = (Array.isArray(list) ? list : []).filter((r) => r?.id !== record.id);
  out.push(record);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

const dayOf = (iso) => String(iso ?? "").slice(0, 10);

/**
 * Totals for a future progress screen: what was played, how much was typed by
 * the player, the best result per song, and the run of consecutive days played
 * up to `today` (YYYY-MM-DD, local).
 */
export function summarize(list, today) {
  const records = Array.isArray(list) ? list : [];
  const bestBySong = {};
  const days = new Set();
  let wordsTyped = 0;
  let activeMs = 0;
  let completed = 0;
  for (const r of records) {
    wordsTyped += r.words?.typed ?? 0;
    activeMs += r.activeMs ?? 0;
    if (r.status === "complete") completed++;
    days.add(dayOf(r.startedAt));
    const id = r.track?.id;
    if (id && (bestBySong[id]?.pct ?? -1) < (r.pct ?? 0)) bestBySong[id] = { pct: r.pct ?? 0, name: r.track.name };
  }
  let streakDays = 0;
  if (today) {
    const d = new Date(`${today}T12:00:00Z`);
    // A run still counts if today has no play yet but yesterday does.
    if (!days.has(today)) d.setUTCDate(d.getUTCDate() - 1);
    while (days.has(d.toISOString().slice(0, 10))) {
      streakDays++;
      d.setUTCDate(d.getUTCDate() - 1);
    }
  }
  return {
    plays: records.length,
    completed,
    songs: Object.keys(bestBySong).length,
    wordsTyped,
    activeMs,
    streakDays,
    bestBySong,
  };
}
