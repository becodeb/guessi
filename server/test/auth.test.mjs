import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "./helpers.mjs";
import { createTokenCache } from "../auth.js";

test("missing, malformed and rejected tokens answer 401 JSON", async () => {
  const s = await boot();
  try {
    for (const r of [
      await s.get("/api/me"),
      await s.call("GET", "/api/me", { token: "bad" }),
      await s.post("/api/plays", { plays: [] }),
    ]) {
      assert.equal(r.status, 401);
      assert.ok(r.body.error);
    }
    assert.equal(s.state.lookups, 1, "only the bad token reached Spotify");
  } finally {
    await s.close();
  }
});

test("Spotify unreachable answers 503, not 401", async () => {
  const s = await boot();
  try {
    const r = await s.get("/api/me", "down");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "spotify_unavailable");
  } finally {
    await s.close();
  }
});

test("a good token creates the user and is cached for 10 minutes", async () => {
  const s = await boot();
  try {
    const a = await s.get("/api/me", "tok-ana");
    assert.equal(a.status, 200);
    assert.deepEqual([a.body.user.id, a.body.user.displayName, a.body.user.imageUrl], ["ana", "ANA", "https://img/ana.png"]);
    await s.get("/api/me", "tok-ana");
    await s.get("/api/me/plays", "tok-ana");
    assert.equal(s.state.lookups, 1, "cached");
    s.clock.t += 9 * 60 * 1000;
    await s.get("/api/me", "tok-ana");
    assert.equal(s.state.lookups, 1, "still cached at 9 minutes");
    s.clock.t += 2 * 60 * 1000;
    await s.get("/api/me", "tok-ana");
    assert.equal(s.state.lookups, 2, "asked again after expiry");
  } finally {
    await s.close();
  }
});

test("the token cache is bounded and evicts the oldest", () => {
  let t = 0;
  const cache = createTokenCache(() => t, 1000, 3);
  for (const k of ["a", "b", "c", "d"]) cache.set(k, { id: k });
  assert.equal(cache.size, 3);
  assert.equal(cache.get("a"), null);
  assert.equal(cache.get("d").id, "d");
  t = 5000;
  assert.equal(cache.get("d"), null, "expired");
});

test("tokens never reach the logs or the database", async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => lines.push(a.join(" "));
  const s = await boot();
  try {
    assert.equal((await s.get("/api/me", "tok-ana~secretive")).status, 200);
    await s.call("POST", "/api/plays", { token: "tok-ana~secretive", raw: "{not json" });
    const dump = JSON.stringify([...s.db.prepare("SELECT * FROM users").all(), ...s.db.prepare("SELECT * FROM plays").all(), ...s.db.prepare("SELECT * FROM meta").all()]);
    assert.ok(!dump.includes("secretive"));
  } finally {
    Object.assign(console, orig);
    await s.close();
  }
  assert.ok(!lines.join("\n").includes("secretive"));
});
