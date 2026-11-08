// No-framework unit harness for src/letra-stats.js.
// Run with: node tests/letra-stats.test.mjs  (exit code 0 = all pass)

import {
  buildRecord, upsertRecord, summarize, addActiveTime, newPlayId, HISTORY_VERSION, IDLE_GAP_MS,
} from "../src/letra-stats.js";

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}: expected ${e}, got ${a}`);
}

const track = { id: "t1", name: "Una canción inventada", artists: [{ name: "Nadie" }], album: { name: "Disco" }, duration_ms: 180000 };
const stats = { total: 100, typed: 60, repeated: 20, byHint: 5, byLine: 10, givenUp: 0, open: 5, pct: 80, bestStreak: 12, misses: 3, jumps: 2 };
const t0 = Date.UTC(2026, 10, 8, 20, 0, 0);

// --- buildRecord ---------------------------------------------------------------------
{
  const r = buildRecord({ id: "a", track, stats, status: "open", startedAt: t0, endedAt: t0 + 60000, activeMs: 45000.4, source: "synced" });
  check("record: schema version", r.v, HISTORY_VERSION);
  check("record: id and game", [r.id, r.game].join(), "a,letra");
  check("record: dates as ISO", r.startedAt, "2026-11-08T20:00:00.000Z");
  check("record: active time rounded", r.activeMs, 45000);
  check("record: plain artists", r.track.artists, ["Nadie"]);
  check("record: uri rebuilt from the id", r.track.uri, "spotify:track:t1");
  check("record: words breakdown", r.words, { total: 100, typed: 60, repeated: 20, byHint: 5, byLine: 10, givenUp: 0, open: 5 });
  check("record: result", [r.pct, r.bestStreak, r.misses, r.jumps, r.status, r.source].join(), "80,12,3,2,open,synced");
  check("record: survives JSON", JSON.parse(JSON.stringify(r)), r);
}

// --- upsertRecord ----------------------------------------------------------------------
{
  const a = buildRecord({ id: "a", track, stats, status: "open", startedAt: t0, endedAt: t0, activeMs: 0 });
  const a2 = { ...a, status: "complete" };
  const b = { ...a, id: "b" };
  let list = upsertRecord([], a);
  list = upsertRecord(list, b);
  list = upsertRecord(list, a2);
  check("upsert: same id is replaced", list.length, 2);
  check("upsert: the newest version wins", list.find((r) => r.id === "a").status, "complete");
  check("upsert: a bad list starts fresh", upsertRecord(null, a).length, 1);
  const many = Array.from({ length: 5 }, (_, i) => ({ ...a, id: `r${i}` }));
  check("upsert: keeps the newest within the cap", upsertRecord(many, { ...a, id: "new" }, 3).map((r) => r.id), ["r3", "r4", "new"]);
}

// --- active time -------------------------------------------------------------------------
{
  check("active: first keystroke adds nothing", addActiveTime(0, 0, 1000), 0);
  check("active: a short gap counts", addActiveTime(100, 1000, 3000), 2100);
  check("active: a long pause doesn't", addActiveTime(100, 1000, 1000 + IDLE_GAP_MS + 1), 100);
  check("active: clock going backwards doesn't", addActiveTime(100, 5000, 4000), 100);
  check("ids are unique", newPlayId() !== newPlayId(), true);
}

// --- summarize ----------------------------------------------------------------------------
{
  const at = (day, extra) => buildRecord({ id: `${day}-${extra.id}`, track: extra.track ?? track, stats: { ...stats, ...extra.stats }, status: extra.status ?? "complete", startedAt: Date.parse(`${day}T20:00:00Z`), endedAt: Date.parse(`${day}T20:05:00Z`), activeMs: 60000 });
  const other = { ...track, id: "t2", name: "Otra inventada" };
  const list = [
    at("2026-11-06", { id: 1, stats: { pct: 40, typed: 30 } }),
    at("2026-11-07", { id: 2, stats: { pct: 90, typed: 70 } }),
    at("2026-11-08", { id: 3, track: other, status: "open", stats: { pct: 10, typed: 5 } }),
  ];
  const s = summarize(list, "2026-11-08");
  check("summary: plays and completed", [s.plays, s.completed, s.songs].join(), "3,2,2");
  check("summary: words typed by the player", s.wordsTyped, 105);
  check("summary: time", s.activeMs, 180000);
  check("summary: best result per song", s.bestBySong.t1.pct, 90);
  check("summary: days in a row", s.streakDays, 3);
  check("summary: a run holds until today ends", summarize(list.slice(0, 2), "2026-11-08").streakDays, 2);
  check("summary: a gap breaks the run", summarize([list[0], list[2]], "2026-11-08").streakDays, 1);
  check("summary: nothing is zero", summarize([], "2026-11-08"), { plays: 0, completed: 0, songs: 0, wordsTyped: 0, activeMs: 0, streakDays: 0, bestBySong: {} });
}

if (failures.length > 0) {
  console.error(`letra-stats.test.mjs: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`letra-stats.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
