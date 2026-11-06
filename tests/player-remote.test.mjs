// Unit harness for the phone fallback in src/player.js ("remote mode").
// Run with: node tests/player-remote.test.mjs  (exit code 0 = all pass)
// A fake SDK and a fake Web API stand in for Spotify; nothing touches the network.

const store = new Map();
globalThis.window = { location: { origin: "http://127.0.0.1:8080", pathname: "/" } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};
store.set("deoido.v1.tokens", JSON.stringify({
  access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600_000, scopes: [],
}));

let coarse = true;
globalThis.matchMedia = (q) => ({ matches: q.includes("pointer: coarse") ? coarse : false });

const requests = [];
const api = {
  devices: [
    { id: "dev-1", name: "de oído", type: "Computer", is_active: false, is_restricted: false },
    { id: "phone-1", name: "Pixel", type: "Smartphone", is_active: true, is_restricted: false },
  ],
  player: null, // body of GET /me/player (null = 204)
  sdkPutStatus: 204,
  phoneStatus: 204, // status of control calls aimed at the phone
};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method ?? "GET";
  const path = u.pathname.replace(/^\/v1/, "");
  requests.push({ method, path, query: u.search, body: init.body ? JSON.parse(init.body) : null });
  const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (path === "/me/player/devices") return json({ devices: api.devices });
  if (path === "/me/player" && method === "GET") return api.player ? json(api.player) : new Response(null, { status: 204 });
  const device = u.searchParams.get("device_id");
  if (device === "dev-1") return api.sdkPutStatus === 403 ? new Response("PREMIUM_REQUIRED", { status: 403 }) : new Response(null, { status: api.sdkPutStatus });
  return new Response(api.phoneStatus === 404 ? "no device" : null, { status: api.phoneStatus });
};

let sdkReady = false; // "dead" SDK: connect() works, no device ever shows up
class FakePlayer {
  constructor() { this.l = {}; this.calls = []; this.state = null; FakePlayer.last = this; }
  addListener(e, cb) { (this.l[e] ??= []).push(cb); }
  emit(e, p) { for (const cb of this.l[e] ?? []) cb(p); }
  connect() { if (sdkReady) setTimeout(() => this.emit("ready", { device_id: "dev-1" }), 2); return Promise.resolve(true); }
  pause() { this.calls.push("pause"); return Promise.resolve(); }
  resume() { this.calls.push("resume"); return Promise.resolve(); }
  seek(ms) { this.calls.push(`seek:${ms}`); return Promise.resolve(); }
  setVolume() { return Promise.resolve(); }
  activateElement() { this.calls.push("activate"); return Promise.resolve(); }
  getCurrentState() { return Promise.resolve(this.state); }
}
window.Spotify = { Player: FakePlayer };

const player = await import("../src/player.js");
Object.assign(player.timing, { deviceWait: 60, deviceWaitCoarse: 60, confirm: 70, poll: 30, settle: 150, grace: 60 });

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) || (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const list = () => requests.map((r) => `${r.method} ${r.path}${r.query}`);
const reset = () => { requests.length = 0; };
const A = "spotify:track:a";
const B = "spotify:track:b";
const remoteState = (over = {}) => ({
  device: { id: "phone-1" }, is_playing: true, progress_ms: 5000,
  item: { uri: A, duration_ms: 200000 }, ...over,
});

// --- pickPhoneDevice ---------------------------------------------------------------
{
  const d = (id, type, active = false, restricted = false, name = id) => ({ id, name, type, is_active: active, is_restricted: restricted });
  const pick = (ds, own) => player.pickPhoneDevice(ds, own)?.id ?? null;
  check("pick: active phone first", pick([d("a", "Computer", true), d("b", "Smartphone"), d("c", "Smartphone", true)]), "c");
  check("pick: any phone beats an active computer", pick([d("a", "Computer", true), d("b", "Smartphone")]), "b");
  check("pick: otherwise the active device", pick([d("a", "TV"), d("b", "Computer", true)]), "b");
  check("pick: nothing usable", pick([d("a", "TV"), d("b", "Computer")]), null);
  check("pick: restricted devices are skipped", pick([d("a", "Smartphone", true, true), d("b", "Smartphone")]), "b");
  check("pick: never the SDK's own id", pick([d("own", "Smartphone", true), d("b", "Computer", true)], "own"), "b");
  check("pick: never a device named like the SDK's", pick([d("ghost", "Smartphone", true, false, "de oído"), d("b", "Smartphone")]), "b");
  check("pick: empty list", pick([]), null);
  check("pick: junk input", pick(undefined), null);
  check("pick: type is case-insensitive", pick([d("a", "smartphone")]), "a");
}

// --- before any press: nothing ---------------------------------------------------------
await player.initPlayer(async () => "t");
await wait(20);
check("dead SDK has no device", player.getDeviceId(), null);
check("connecting a dead SDK sends nothing", requests.length, 0);
const events = [];
const notices = [];
player.onPlayback((p) => events.push(p));
player.onNotice((n) => notices.push(n));

// --- a desktop never falls back ---------------------------------------------------------
{
  coarse = false;
  const res = await player.playTrack(A);
  check("desktop, dead SDK: no-device", [res.ok, res.reason], [false, "no-device"]);
  check("desktop, dead SDK: not a single request", requests.length, 0);
  coarse = true;
}

// --- dead SDK on a phone: straight to the app ----------------------------------------------
{
  reset();
  api.player = remoteState();
  const res = await player.playTrack(A, { positionMs: 1234.4 });
  check("dead SDK: ok", res.ok, true);
  check("dead SDK: exact requests", list(), ["GET /me/player/devices", "PUT /me/player/play?device_id=phone-1"]);
  check("dead SDK: body", requests[1].body, { uris: [A], position_ms: 1234 });
  check("dead SDK: owning", player.isOwning(A), true);
  check("dead SDK: told once", notices, ["remote-playing"]);
  check("dead SDK: first payload is playing", [events.at(-1).paused, events.at(-1).uri, events.at(-1).remote], [false, A, true]);

  // polling maps the app's state
  reset();
  await wait(100);
  check("polling runs while audible", requests.filter((r) => r.path === "/me/player").length >= 2, true);
  const polled = events.at(-1);
  check("poll payload", [polled.paused, polled.position, polled.duration, polled.uri, polled.lost, polled.ended], [false, 5000, 200000, A, false, false]);

  // pause
  reset();
  player.pauseFree();
  await wait(100);
  check("pause: one PUT, then no polling", list(), ["PUT /me/player/pause?device_id=phone-1"]);

  // seek while paused
  reset();
  player.seekFree(42000.7);
  await wait(20);
  check("seek while paused", list(), ["PUT /me/player/seek?position_ms=42001&device_id=phone-1"]);

  // resume: PUT play without a body, polling again
  reset();
  player.resumeFree();
  await wait(100);
  check("resume: PUT play, no body", [list()[0], requests[0].body], ["PUT /me/player/play?device_id=phone-1", null]);
  check("resume: polling again", requests.filter((r) => r.path === "/me/player").length >= 1, true);

  // the app paused itself (after the grace): the poll reports it and stops
  api.player = remoteState({ is_playing: false, progress_ms: 9000 });
  await wait(160);
  check("app paused: payload", [events.at(-1).paused, events.at(-1).position], [true, 9000]);
  reset();
  await wait(100);
  check("app paused: polling stopped", requests.length, 0);

  // leaving while paused sends nothing; leaving while playing pauses
  reset();
  player.stopFree();
  await wait(20);
  check("stopFree while paused: silent", requests.length, 0);
  check("stopFree: no longer owning", player.isOwning(A), false);
}

// --- polling stops on leaving, with a pause ----------------------------------------------------
{
  reset();
  api.player = remoteState();
  await player.playTrack(A);
  await wait(80);
  reset();
  player.stopFree();
  await wait(120);
  check("leaving: exactly one pause, no polls", list(), ["PUT /me/player/pause?device_id=phone-1"]);
}

// --- another device or another song = lost ----------------------------------------------------
{
  reset();
  api.player = remoteState({ device: { id: "tv-9" } });
  const before = events.length;
  await player.playTrack(A);
  await wait(60);
  check("not ours yet: still waiting (settle)", events.slice(before).some((e) => e.lost), false);
  await wait(200);
  check("another device: lost after settling", events.slice(before).some((e) => e.lost), true);
  check("lost: no longer owning", player.isOwning(A), false);
  reset();
  await wait(100);
  check("lost: polling stopped", requests.length, 0);

  api.player = remoteState();
  const res = await player.playTrack(A);
  check("after lost the next play hands over again", [res.ok, list().filter((l) => l.startsWith("PUT")).length], [true, 1]);
  await wait(60);
  api.player = remoteState({ item: { uri: B, duration_ms: 1000 } });
  const n = events.length;
  await wait(120);
  check("another song confirmed ours once, then lost", events.slice(n).some((e) => e.lost), true);
  player.stopFree();
}

// --- no device ------------------------------------------------------------------------------------
{
  reset();
  notices.length = 0;
  api.devices = [{ id: "tv", name: "Sala", type: "TV", is_active: false, is_restricted: true }];
  const res = await player.playTrack(A);
  check("no device: reason", [res.ok, res.reason], [false, "no-remote-device"]);
  check("no device: only the list was asked", list(), ["GET /me/player/devices"]);
  check("no device: toast notice", notices, ["no-remote-device"]);
  check("no device: not owning", player.isOwning(A), false);
  api.devices = [
    { id: "dev-1", name: "de oído", type: "Computer", is_active: false, is_restricted: false },
    { id: "phone-1", name: "Pixel", type: "Smartphone", is_active: true, is_restricted: false },
  ];
}

// --- the device went away (404) -------------------------------------------------------------------
{
  reset();
  notices.length = 0;
  api.player = remoteState();
  await player.playTrack(A);
  api.phoneStatus = 404;
  const n = events.length;
  player.pauseFree();
  await wait(40);
  check("404 on pause: lost", events.slice(n).some((e) => e.lost), true);
  check("404 on pause: toast", notices, ["no-remote-device"]);
  api.phoneStatus = 204;
  player.stopFree();
}

// --- silent SDK: device ready, PUT ok, no state ever ---------------------------------------------
{
  sdkReady = true;
  FakePlayer.last.emit("ready", { device_id: "dev-1" });
  check("SDK device appeared", player.getDeviceId(), "dev-1");
  reset();
  notices.length = 0;
  api.player = remoteState();
  const res = await player.playTrack(A);
  check("silent: PUT ok first", [res.ok, list()], [true, ["PUT /me/player/play?device_id=dev-1"]]);
  await wait(200);
  check("silent: then devices and the app", list().slice(0, 3), [
    "PUT /me/player/play?device_id=dev-1", "GET /me/player/devices", "PUT /me/player/play?device_id=phone-1",
  ]);
  check("silent: owning through the app", player.isOwning(A), true);
  player.stopFree();
  await wait(20);

  // the SDK is now known to be silent: the next play goes straight to the app
  reset();
  api.player = remoteState();
  await player.playTrack(A);
  check("silent, second play: straight to the app", list(), ["GET /me/player/devices", "PUT /me/player/play?device_id=phone-1"]);
  player.stopFree();
  await wait(20);
  // a device (re)appearing gives the SDK another chance
  FakePlayer.last.emit("ready", { device_id: "dev-1" });
}

// --- the SDK's own PUT failing -----------------------------------------------------------------------
{
  reset();
  api.sdkPutStatus = 500;
  api.player = remoteState();
  const res = await player.playTrack(A);
  check("PUT 500: falls back", [res.ok, list()], [true, [
    "PUT /me/player/play?device_id=dev-1", "GET /me/player/devices", "PUT /me/player/play?device_id=phone-1",
  ]]);
  player.stopFree();
  await wait(20);
  FakePlayer.last.emit("ready", { device_id: "dev-1" });
  api.sdkPutStatus = 204;
}

// --- Premium is not a reason to fall back ---------------------------------------------------------------
{
  reset();
  api.sdkPutStatus = 403;
  const res = await player.playTrack(A);
  check("premium: no fallback", [res.ok, res.reason, list()], [false, "premium", ["PUT /me/player/play?device_id=dev-1"]]);
  api.sdkPutStatus = 204;
}

// --- a working SDK is left alone --------------------------------------------------------------------------
{
  const sdk = FakePlayer.last;
  // premium was refused above; the account is fine in this scenario
  const res0 = await player.playTrack(A);
  check("healthy: PUT ok", res0.ok, true);
  reset();
  sdk.emit("player_state_changed", {
    paused: false, position: 10, duration: 200000,
    track_window: { current_track: { uri: A }, previous_tracks: [] },
  });
  await wait(200);
  check("healthy: no fallback, no polling", list(), []);
  player.stopFree();
}

// --- pausing during the grace period cancels the watchdog -------------------------------------------------
{
  await wait(20);
  FakePlayer.last.emit("ready", { device_id: "dev-1" });
  reset();
  await player.playTrack(A);
  player.pauseFree();
  await wait(200);
  check("paused before the watchdog: stays on the SDK", list(), ["PUT /me/player/play?device_id=dev-1"]);
  player.stopFree();
}

console.log(`player-remote.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
