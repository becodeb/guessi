// No-framework unit harness for src/stats-sync.js.
// Run with: node tests/stats-sync.test.mjs  (exit code 0 = all pass)

import {
  pendingPlays, toBatches, markSynced, syncPlays, createScheduler, SYNC_BATCH, HIDE_BATCH, HIDE_MAX_BATCHES,
} from "../src/stats-sync.js";

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}: expected ${e}, got ${a}`);
}

const at = (min) => new Date(Date.UTC(2026, 10, 8, 20, min)).toISOString();
const rec = (id, min) => ({ v: 1, id, game: "letra", endedAt: at(min) });

// --- pendingPlays ----------------------------------------------------------------------
{
  const h = [rec("c", 3), rec("a", 1), rec("b", 2)];
  check("pending: everything when nothing was sent, oldest first", pendingPlays(h, {}).map((r) => r.id), ["a", "b", "c"]);
  check("pending: sent ones are left out", pendingPlays(h, { a: at(1), b: at(2) }).map((r) => r.id), ["c"]);
  check("pending: a record that ended later is pending again", pendingPlays(h, { a: at(0), b: at(2), c: at(3) }).map((r) => r.id), ["a"]);
  check("pending: sent a later version than the local one is not pending", pendingPlays([rec("a", 1)], { a: at(5) }), []);
  check("pending: junk is tolerated", pendingPlays([null, {}, { id: 3 }, rec("ok", 1)], null).map((r) => r.id), ["ok"]);
  check("pending: not a list", pendingPlays(undefined, {}), []);
}

// --- toBatches / markSynced -------------------------------------------------------------
{
  const list = Array.from({ length: 250 }, (_, i) => i);
  check("batches: 100, 100, 50", toBatches(list).map((b) => b.length), [100, 100, 50]);
  check("batches: order kept", toBatches(list)[2][0], 200);
  check("batches: empty", toBatches([]), []);
  check("batches: custom size", toBatches([1, 2, 3], 2), [[1, 2], [3]]);
  check("default batch size", SYNC_BATCH, 100);

  const m = markSynced({ old: at(1), gone: at(1) }, [rec("a", 2)], [rec("old", 1), rec("a", 2)]);
  check("markSynced: adds the sent, keeps live ids, forgets deleted ones", m, { old: at(1), a: at(2) });
}

// --- syncPlays -------------------------------------------------------------------------------
function world({ history, synced = {}, respond = () => ({ ok: true, status: 200 }), token = "tok" } = {}) {
  const w = { history, synced, calls: [], tokenCalls: 0, saved: 0 };
  w.io = {
    loadHistory: () => w.history,
    loadSynced: () => w.synced,
    saveSynced: (m) => { w.synced = m; w.saved++; return true; },
    fetchFn: async (url, init) => {
      w.calls.push({ url, init, plays: JSON.parse(init.body).plays });
      return respond(w.calls.length);
    },
  };
  w.getToken = async () => { w.tokenCalls++; return token; };
  return w;
}

{
  const history = Array.from({ length: 250 }, (_, i) => rec(`r${String(i).padStart(3, "0")}`, 250 - i)); // newest first, like the app
  const w = world({ history });
  const n = await syncPlays(w.getToken, w.io);
  check("sync: all sent", n, 250);
  check("sync: three requests of 100, 100, 50", w.calls.map((c) => c.plays.length), [100, 100, 50]);
  check("sync: newest last overall", [w.calls[0].plays[0].id, w.calls[2].plays[49].id], ["r249", "r000"]);
  check("sync: url, method, auth", [w.calls[0].url, w.calls[0].init.method, w.calls[0].init.headers.Authorization], ["/api/plays", "POST", "Bearer tok"]);
  check("sync: no keepalive on normal runs", w.calls[0].init.keepalive, undefined);
  check("sync: everything marked", Object.keys(w.synced).length, 250);
  check("sync: progress saved per batch", w.saved, 3);
  w.calls.length = 0;
  check("sync: nothing pending the second time", await syncPlays(w.getToken, w.io), 0);
  check("sync: no request when nothing is pending", w.calls.length, 0);
  w.history = [rec("r000", 999), ...history.slice(1)];
  await syncPlays(w.getToken, w.io);
  check("sync: a replaced record goes again, alone", w.calls.map((c) => c.plays.map((p) => p.id)), [["r000"]]);
}
{
  const w = world({ history: [rec("a", 1)] });
  w.tokenCalls = 0;
  await syncPlays(w.getToken, { ...w.io, loadHistory: () => [] });
  check("sync: no token requested when nothing is pending", w.tokenCalls, 0);
}
{
  const w = world({ history: [rec("a", 1)], token: null });
  check("sync: signed out sends nothing", [await syncPlays(w.getToken, w.io), w.calls.length], [0, 0]);
}
{
  const w = world({ history: Array.from({ length: 150 }, (_, i) => rec(`x${i}`, i)), respond: (n) => (n === 1 ? { ok: true } : { ok: false, status: 401 }) });
  const n = await syncPlays(w.getToken, w.io);
  check("sync: a failing batch stops the run and keeps the rest pending", [n, w.calls.length, Object.keys(w.synced).length], [100, 2, 100]);
  check("sync: the failed batch is retried next time", pendingPlays(w.history, w.synced).length, 50);
}
{
  const w = world({ history: [rec("a", 1)], respond: () => ({ ok: false, status: 503 }) });
  check("sync: 5xx keeps it pending", [await syncPlays(w.getToken, w.io), Object.keys(w.synced).length], [0, 0]);
}
{
  // Never rejects, whatever breaks.
  const boom = () => { throw new Error("boom"); };
  const w = world({ history: [rec("a", 1)] });
  check("sync: fetch throws", await syncPlays(w.getToken, { ...w.io, fetchFn: async () => boom() }), 0);
  check("sync: token lookup throws", await syncPlays(async () => boom(), w.io), 0);
  check("sync: storage throws", await syncPlays(w.getToken, { ...w.io, loadHistory: boom }), 0);
  check("sync: saving progress throws", await syncPlays(w.getToken, { ...w.io, saveSynced: boom }), 0);
  check("sync: no fetch at all", await syncPlays(w.getToken, { ...w.io, fetchFn: undefined, loadHistory: () => [rec("z", 1)] }), 0);
}
{
  // A second trigger while one is running joins it instead of sending twice.
  const w = world({ history: [rec("a", 1)] });
  let release;
  const gate = new Promise((r) => { release = r; });
  w.io.fetchFn = async (url, init) => { w.calls.push({ plays: JSON.parse(init.body).plays }); await gate; return { ok: true }; };
  const p1 = syncPlays(w.getToken, w.io);
  const p2 = syncPlays(w.getToken, w.io);
  release();
  check("sync: concurrent triggers share one run", [await p1, await p2, w.calls.length], [1, 1, 1]);
}
{
  const history = Array.from({ length: 200 }, (_, i) => rec(`k${i}`, i));
  const w = world({ history });
  await syncPlays(w.getToken, { ...w.io, keepalive: true });
  check("hide: keepalive, small batches, capped", [w.calls.length, w.calls[0].plays.length, w.calls[0].init.keepalive], [HIDE_MAX_BATCHES, HIDE_BATCH, true]);
  check("hide: no abort signal on keepalive", w.calls[0].init.signal, undefined);
}

// --- scheduler ------------------------------------------------------------------------------
{
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const advance = (ms) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
  };
  let runs = 0;
  const s = createScheduler(() => runs++, { delayMs: 3000, setTimer, clearTimer });
  s.schedule(); advance(1000); s.schedule(); advance(1000); s.schedule();
  advance(2999);
  check("scheduler: waits for 3 s of quiet", runs, 0);
  advance(1);
  check("scheduler: one run after the last save", runs, 1);
  check("scheduler: idle afterwards", s.pending, false);
  s.schedule(); s.cancel(); advance(5000);
  check("scheduler: cancel", runs, 1);
}

if (failures.length) {
  console.error(failures.join("\n"));
  console.error(`${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`stats-sync: ${passed} checks passed`);
