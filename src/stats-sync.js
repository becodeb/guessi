// Sends the lyrics-game history to the stats server (POST /api/plays).
// Fire-and-forget: it never throws, never blocks the game and shows nothing.
// Any failure just leaves the records pending for the next trigger.
//
// The pure parts (what is pending, batching) take plain data; syncPlays and
// the scheduler take their collaborators, so tests run without a browser.

export const SYNC_BATCH = 100;
export const SYNC_DEBOUNCE_MS = 3000;
// A keepalive request may carry about 64 KB in total, so the page-hide flush is small.
export const HIDE_BATCH = 20;
export const HIDE_MAX_BATCHES = 2;

const ms = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Records the server hasn't seen in their current form, oldest first
 * (a record is pending again when it ended later than what was sent).
 * @param {Array} history local records
 * @param {Record<string,string>} synced id -> endedAt that was sent
 */
export function pendingPlays(history, synced) {
  const sent = synced && typeof synced === "object" ? synced : {};
  return (Array.isArray(history) ? history : [])
    .filter((r) => r && typeof r.id === "string" && r.endedAt && (!(r.id in sent) || ms(r.endedAt) > ms(sent[r.id])))
    .sort((a, b) => ms(a.endedAt) - ms(b.endedAt));
}

export function toBatches(list, size = SYNC_BATCH) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Adds what a batch sent; ids no longer in the history are forgotten. */
export function markSynced(synced, sentRecords, history) {
  const next = { ...(synced && typeof synced === "object" ? synced : {}) };
  for (const r of sentRecords) next[r.id] = r.endedAt;
  const live = new Set((Array.isArray(history) ? history : []).map((r) => r?.id));
  for (const id of Object.keys(next)) if (!live.has(id)) delete next[id];
  return next;
}

let inFlight = null;

/**
 * Posts every pending record. Resolves to the number of records sent; never rejects.
 * @param {() => (string|null|Promise<string|null>)} getToken
 * @param {object} io
 * @param {() => Array} io.loadHistory
 * @param {() => object} io.loadSynced
 * @param {(m: object) => any} io.saveSynced
 * @param {typeof fetch} [io.fetchFn]
 * @param {string} [io.url]
 * @param {boolean} [io.keepalive] page is going away: small batches, and don't wait for an earlier run
 */
export async function syncPlays(getToken, io) {
  if (inFlight && !io.keepalive) return inFlight;
  const run = doSync(getToken, io);
  if (!io.keepalive) {
    inFlight = run.finally(() => { inFlight = null; });
    return inFlight;
  }
  return run;
}

async function doSync(getToken, { loadHistory, loadSynced, saveSynced, fetchFn = globalThis.fetch, url = "/api/plays", keepalive = false }) {
  let sent = 0;
  try {
    const history = loadHistory();
    const pending = pendingPlays(history, loadSynced());
    if (!pending.length) return 0;
    const token = await getToken();
    if (!token) return 0;
    let batches = toBatches(pending, keepalive ? HIDE_BATCH : SYNC_BATCH);
    if (keepalive) batches = batches.slice(0, HIDE_MAX_BATCHES);
    for (const batch of batches) {
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plays: batch }),
      };
      if (keepalive) init.keepalive = true;
      else if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(15000);
      const res = await fetchFn(url, init);
      // Any failure (401, 5xx, 413...) leaves everything pending for the next trigger.
      if (!res?.ok) break;
      saveSynced(markSynced(loadSynced(), batch, loadHistory()));
      sent += batch.length;
    }
  } catch {
    // Silent on purpose: sync is a bonus.
  }
  return sent;
}

/**
 * Debounced trigger: many saves in a row become one sync, `delayMs` after the last.
 * @param {() => any} run
 */
export function createScheduler(run, { delayMs = SYNC_DEBOUNCE_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  return {
    schedule() {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    get pending() {
      return timer !== null;
    },
  };
}
