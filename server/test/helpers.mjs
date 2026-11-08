import { createApp } from "../app.js";
import { openDb } from "../db.js";

/** A play record shaped like src/letra-stats.js buildRecord output. */
export function play(over = {}) {
  return {
    v: 1, id: "p1", game: "letra", status: "complete",
    startedAt: "2026-11-08T20:00:00.000Z", endedAt: "2026-11-08T20:03:00.000Z", activeMs: 150000,
    track: { id: "t1", uri: "spotify:track:t1", name: "Una canción", artists: ["Nadie"], album: "Disco", durationMs: 180000 },
    words: { total: 100, typed: 60, repeated: 20, byHint: 5, byLine: 10, givenUp: 0, open: 5 },
    pct: 80, bestStreak: 12, misses: 3, jumps: 2, source: "synced",
    ...over,
  };
}

/**
 * Boots the app on an ephemeral port with an in-memory database and a fake
 * Spotify: tokens "tok-<name>" are user <name>; "bad" is rejected; "down"
 * makes Spotify unreachable. `lookups` counts calls to the fake.
 */
export async function boot({ start = Date.parse("2026-11-08T21:00:00.000Z") } = {}) {
  const clock = { t: start };
  const state = { lookups: 0 };
  const db = openDb(":memory:", () => clock.t);
  const fetchMe = async (token) => {
    state.lookups++;
    if (token === "down") throw new Error("boom");
    if (token === "bad" || !token.startsWith("tok-")) return null;
    const name = token.slice(4).split("~")[0]; // "tok-ana~anything" is still ana
    return { id: name, display_name: name.toUpperCase(), images: [{ url: `https://img/${name}.png` }] };
  };
  const server = createApp({ db, fetchMe, now: () => clock.t }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(method, path, { token, body, raw } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined || raw !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  }
  return {
    db, clock, state, call,
    get: (path, token) => call("GET", path, { token }),
    post: (path, body, token) => call("POST", path, { token, body }),
    close: () => new Promise((r) => server.close(() => { db.close(); r(); })),
  };
}
