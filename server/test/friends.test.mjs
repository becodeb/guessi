import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, play } from "./helpers.mjs";

test("friends lists every user, ordered by words typed this week then all time", async () => {
  const s = await boot(); // now = 2026-11-08T21:00Z
  try {
    const typed = (n) => ({ total: 100, typed: n, repeated: 0, byHint: 0, byLine: 0, givenUp: 0, open: 0 });
    const week = "2026-11-06T10:00:00.000Z";
    const old = "2026-10-01T10:00:00.000Z";
    await s.post("/api/plays", { plays: [play({ id: "1", startedAt: week, endedAt: week, words: typed(40) })] }, "tok-ana");
    await s.post("/api/plays", { plays: [play({ id: "1", startedAt: week, endedAt: week, words: typed(40) }), play({ id: "2", startedAt: old, endedAt: old, words: typed(500) })] }, "tok-bea");
    await s.post("/api/plays", { plays: [play({ id: "1", startedAt: week, endedAt: week, words: typed(90) })] }, "tok-cami");
    await s.get("/api/me", "tok-dani"); // no plays at all
    const r = await s.get("/api/friends", "tok-ana");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.friends.map((f) => f.id), ["cami", "bea", "ana", "dani"]);
    const [cami, bea, ana, dani] = r.body.friends;
    assert.equal(cami.wordsThisWeek, 90);
    assert.equal(bea.wordsThisWeek, 40, "the old play is outside the week");
    assert.equal(bea.summary.wordsTyped, 540, "but counts for all time");
    assert.equal(ana.isMe, true);
    assert.equal(cami.isMe, false);
    assert.equal(cami.lastPlayedAt, week);
    assert.equal(dani.lastPlayedAt, null);
    assert.equal(dani.summary.plays, 0);
    assert.deepEqual([cami.displayName, cami.imageUrl], ["CAMI", "https://img/cami.png"]);
    assert.equal(JSON.stringify(r.body).includes("tok-"), false);
  } finally {
    await s.close();
  }
});

test("friends needs a token", async () => {
  const s = await boot();
  try {
    assert.equal((await s.get("/api/friends")).status, 401);
  } finally {
    await s.close();
  }
});
