import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, play } from "./helpers.mjs";

test("saves plays and lists them newest first with a limit", async () => {
  const s = await boot();
  try {
    const r = await s.post("/api/plays", { plays: [
      play({ id: "a", endedAt: "2026-11-08T10:00:00.000Z" }),
      play({ id: "b", endedAt: "2026-11-08T12:00:00.000Z" }),
      play({ id: "c", endedAt: "2026-11-08T11:00:00.000Z" }),
    ] }, "tok-ana");
    assert.deepEqual(r.body, { saved: 3, skipped: 0 });
    const all = await s.get("/api/me/plays", "tok-ana");
    assert.deepEqual(all.body.plays.map((p) => p.id), ["b", "c", "a"]);
    assert.equal(all.body.plays[0].track.name, "Una canción");
    assert.deepEqual((await s.get("/api/me/plays?limit=2", "tok-ana")).body.plays.map((p) => p.id), ["b", "c"]);
    assert.equal((await s.get("/api/me/plays?limit=abc", "tok-ana")).body.plays.length, 3, "bad limit falls back to the default");
    assert.equal((await s.get("/api/me/plays?limit=0", "tok-ana")).body.plays.length, 3);
  } finally {
    await s.close();
  }
});

test("limit is capped at 500", async () => {
  const s = await boot();
  try {
    const plays = Array.from({ length: 200 }, (_, i) => play({ id: `x${i}` }));
    for (let i = 0; i < 3; i++) await s.post("/api/plays", { plays: plays.map((p) => ({ ...p, id: `${p.id}-${i}` })) }, "tok-ana");
    assert.equal((await s.get("/api/me/plays?limit=9999", "tok-ana")).body.plays.length, 500);
    assert.equal((await s.get("/api/me/plays", "tok-ana")).body.plays.length, 50);
  } finally {
    await s.close();
  }
});

test("same id again replaces the play only when it ended at the same time or later", async () => {
  const s = await boot();
  try {
    const t = (m) => `2026-11-08T20:0${m}:00.000Z`;
    await s.post("/api/plays", { plays: [play({ id: "a", endedAt: t(3), pct: 50 })] }, "tok-ana");
    await s.post("/api/plays", { plays: [play({ id: "a", endedAt: t(5), pct: 90 })] }, "tok-ana");
    let got = (await s.get("/api/me/plays", "tok-ana")).body.plays;
    assert.equal(got.length, 1);
    assert.equal(got[0].pct, 90, "newer replaces");
    await s.post("/api/plays", { plays: [play({ id: "a", endedAt: t(4), pct: 10 })] }, "tok-ana");
    got = (await s.get("/api/me/plays", "tok-ana")).body.plays;
    assert.equal(got[0].pct, 90, "older is ignored");
    await s.post("/api/plays", { plays: [play({ id: "a", endedAt: t(5), pct: 95 })] }, "tok-ana");
    assert.equal((await s.get("/api/me/plays", "tok-ana")).body.plays[0].pct, 95, "same time replaces");
  } finally {
    await s.close();
  }
});

test("invalid records are skipped and reported, valid ones in the same batch are kept", async () => {
  const s = await boot();
  try {
    const bad = [
      null, "x", [], {},
      play({ v: 2, id: "v2" }),
      play({ game: "clip", id: "g" }),
      play({ id: "" }),
      play({ id: "x".repeat(65) }),
      play({ id: 7 }),
      play({ id: "st", status: "weird" }),
      play({ id: "d1", startedAt: "not a date" }),
      play({ id: "d2", endedAt: 12345 }),
      play({ id: "n1", activeMs: -1 }),
      play({ id: "n2", pct: Infinity }),
      play({ id: "n3", pct: "80" }),
      play({ id: "n4", words: { total: 1, typed: -3 } }),
      play({ id: "s1", track: { id: "t", name: "x".repeat(301) } }),
      play({ id: "s2", track: { name: "no id" } }),
      play({ id: "s3", track: { id: "t", artists: "Nadie" } }),
      play({ id: "s4", source: "other" }),
    ];
    const r = await s.post("/api/plays", { plays: [play({ id: "ok" }), ...bad] }, "tok-ana");
    assert.deepEqual(r.body, { saved: 1, skipped: bad.length });
    assert.deepEqual((await s.get("/api/me/plays", "tok-ana")).body.plays.map((p) => p.id), ["ok"]);
  } finally {
    await s.close();
  }
});

test("only known fields are stored, dates normalized", async () => {
  const s = await boot();
  try {
    await s.post("/api/plays", { plays: [play({ id: "a", startedAt: "2026-11-08T20:00:00Z", extra: "<script>", track: { id: "t", name: "N", evil: 1 } })] }, "tok-ana");
    const [p] = (await s.get("/api/me/plays", "tok-ana")).body.plays;
    assert.equal(p.extra, undefined);
    assert.equal(p.track.evil, undefined);
    assert.equal(p.startedAt, "2026-11-08T20:00:00.000Z");
  } finally {
    await s.close();
  }
});

test("batch caps: 200 plays ok, 201 refused, body over 1 MB refused, bad json refused", async () => {
  const s = await boot();
  try {
    const mk = (n) => Array.from({ length: n }, (_, i) => play({ id: `p${i}` }));
    assert.deepEqual((await s.post("/api/plays", { plays: mk(200) }, "tok-ana")).body, { saved: 200, skipped: 0 });
    assert.equal((await s.post("/api/plays", { plays: mk(201) }, "tok-ana")).status, 413);
    assert.equal((await s.post("/api/plays", { plays: [play({ id: "big", pad: "x".repeat(1_100_000) })] }, "tok-ana")).status, 413);
    assert.equal((await s.post("/api/plays", { nope: 1 }, "tok-ana")).status, 400);
    assert.equal((await s.call("POST", "/api/plays", { token: "tok-ana", raw: "{oops" })).status, 400);
    assert.equal((await s.call("POST", "/api/plays", { token: "tok-ana" })).status, 400, "no body");
  } finally {
    await s.close();
  }
});

test("/api/me returns the user and the summary of their plays", async () => {
  const s = await boot();
  try {
    await s.post("/api/plays", { plays: [
      play({ id: "a", startedAt: "2026-11-08T10:00:00.000Z", endedAt: "2026-11-08T10:05:00.000Z" }),
      play({ id: "b", startedAt: "2026-11-07T10:00:00.000Z", endedAt: "2026-11-07T10:05:00.000Z", status: "gaveup", track: { id: "t2", name: "Otra" } }),
    ] }, "tok-ana");
    const r = await s.get("/api/me", "tok-ana");
    assert.equal(r.status, 200);
    assert.equal(r.body.user.id, "ana");
    assert.equal(r.body.summary.plays, 2);
    assert.equal(r.body.summary.completed, 1);
    assert.equal(r.body.summary.songs, 2);
    assert.equal(r.body.summary.wordsTyped, 120);
    assert.equal(r.body.summary.streakDays, 2);
    assert.equal(r.headers.get("cache-control"), "no-store");
  } finally {
    await s.close();
  }
});

test("health needs no auth and reports the database creation time and user count", async () => {
  const s = await boot();
  try {
    const h = await s.get("/api/health");
    assert.deepEqual(h.body, { ok: true, dbCreatedAt: "2026-11-08T21:00:00.000Z", users: 0 });
    await s.get("/api/me", "tok-ana");
    s.clock.t += 86400000;
    assert.deepEqual((await s.get("/api/health")).body, { ok: true, dbCreatedAt: "2026-11-08T21:00:00.000Z", users: 1 });
    assert.equal((await s.get("/api/nothing", "tok-ana")).status, 404);
  } finally {
    await s.close();
  }
});
