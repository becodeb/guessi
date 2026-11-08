import { test } from "node:test";
import assert from "node:assert/strict";
import { boot, play } from "./helpers.mjs";

test("a user can't see or overwrite another user's plays by reusing an id", async () => {
  const s = await boot();
  try {
    await s.post("/api/plays", { plays: [play({ id: "shared-id", pct: 10, track: { id: "mine", name: "De Ana" } })] }, "tok-ana");

    // Bea can't see Ana's play.
    assert.deepEqual((await s.get("/api/me/plays", "tok-bea")).body.plays, []);
    assert.equal((await s.get("/api/me", "tok-bea")).body.summary.plays, 0);

    // Bea reuses the id with a newer, different record: it becomes her own row.
    await s.post("/api/plays", { plays: [play({ id: "shared-id", pct: 99, endedAt: "2026-11-09T00:00:00.000Z", track: { id: "hers", name: "De Bea" } })] }, "tok-bea");

    const ana = (await s.get("/api/me/plays", "tok-ana")).body.plays;
    assert.equal(ana.length, 1);
    assert.deepEqual([ana[0].pct, ana[0].track.name], [10, "De Ana"], "Ana's record is untouched");
    const bea = (await s.get("/api/me/plays", "tok-bea")).body.plays;
    assert.deepEqual([bea.length, bea[0].pct, bea[0].track.name], [1, 99, "De Bea"]);
    assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM plays WHERE id = 'shared-id'").get().n, 2);

    // No endpoint takes a user id from the client.
    assert.equal((await s.get("/api/me/plays?user=ana&user_id=ana", "tok-bea")).body.plays.length, 1);
  } finally {
    await s.close();
  }
});
