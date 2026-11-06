// No-framework unit harness for the free-playback API in src/player.js.
// Run with: node tests/player.test.mjs  (exit code 0 = all pass)
// A fake SDK and a fake fetch stand in for Spotify; nothing touches the network.

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

const requests = [];
let putDelayMs = 0;
let putStatus = 204;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  requests.push({ method: init.method ?? "GET", path: u.pathname, query: u.search, body: init.body ? JSON.parse(init.body) : null });
  if (putDelayMs) await new Promise((r) => setTimeout(r, putDelayMs));
  if (putStatus === 403) return new Response("PREMIUM_REQUIRED", { status: 403 });
  return new Response(null, { status: putStatus });
};

class FakePlayer {
  constructor() { this.l = {}; this.calls = []; FakePlayer.last = this; }
  addListener(e, cb) { (this.l[e] ??= []).push(cb); }
  emit(e, p) { for (const cb of this.l[e] ?? []) cb(p); }
  connect() { setTimeout(() => this.emit("ready", { device_id: "dev-1" }), 5); return Promise.resolve(true); }
  pause() { this.calls.push("pause"); return Promise.resolve(); }
  resume() { this.calls.push("resume"); return Promise.resolve(); }
  seek(ms) { this.calls.push(`seek:${ms}`); return Promise.resolve(); }
  setVolume() { return Promise.resolve(); }
  activateElement() { this.calls.push("activate"); return Promise.resolve(); }
  getCurrentState() { return Promise.resolve(null); }
}
window.Spotify = { Player: FakePlayer };

const player = await import("../src/player.js");

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plays = () => requests.filter((r) => r.path.endsWith("/me/player/play"));
const st = (over = {}) => ({
  paused: false, position: 1000, duration: 200000,
  track_window: { current_track: { uri: "spotify:track:a" }, previous_tracks: [] }, ...over,
});

// --- describePlayback (pure) ---------------------------------------------------
{
  const d = player.describePlayback(st(), 5);
  check("describe: playing", [d.paused, d.position, d.uri, d.ended, d.lost, d.at], [false, 1000, "spotify:track:a", false, false, 5]);
  const lost = player.describePlayback(null, 7);
  check("describe: null state is lost", [lost.lost, lost.paused], [true, true]);
  const ended = player.describePlayback(st({
    paused: true, position: 0,
    track_window: { current_track: { uri: "spotify:track:a" }, previous_tracks: [{ uri: "spotify:track:a" }] },
  }));
  check("describe: ended", ended.ended, true);
  const relinked = player.describePlayback(st({
    track_window: { current_track: { uri: "spotify:track:b", linked_from: { uri: "spotify:track:a" } }, previous_tracks: [] },
  }));
  check("describe: relinked track keeps the requested uri", relinked.uri, "spotify:track:a");
  const fresh = player.describePlayback(st({ paused: true, position: 0 }));
  check("describe: paused at 0 without previous is not ended", fresh.ended, false);
}

// --- connecting never plays ----------------------------------------------------
await player.initPlayer(async () => "t");
await wait(30);
const sdk = FakePlayer.last;
check("device ready", player.getDeviceId(), "dev-1");
check("connecting sends no request", requests.length, 0);

// The silence guard still pauses stray playback before the user pressed play.
sdk.emit("player_state_changed", st());
check("guard pauses stray playback when not free", sdk.calls.includes("pause"), true);
check("no free calls before play", plays().length, 0);
check("not owning anything", player.isOwning("spotify:track:a"), false);
sdk.calls.length = 0;
player.resumeFree(); player.pauseFree(); player.seekFree(5); player.stopFree();
check("free controls are inert before play", sdk.calls, []);

// --- playTrack -----------------------------------------------------------------
const events = [];
const off = player.onPlayback((p) => events.push(p));
{
  const res = await player.playTrack("spotify:track:a", { positionMs: 4321.6 });
  check("playTrack ok", res.ok, true);
  check("exactly one PUT", plays().length, 1);
  check("PUT body", plays()[0].body, { uris: ["spotify:track:a"], position_ms: 4322 });
  check("PUT targets the device", plays()[0].query.includes("device_id=dev-1"), true);
  check("activates inside the gesture", sdk.calls.includes("activate"), true);
  check("owning the uri", player.isOwning("spotify:track:a"), true);
  check("not owning another uri", player.isOwning("spotify:track:b"), false);

  sdk.calls.length = 0;
  sdk.emit("player_state_changed", st());
  check("guard leaves owned playback alone", sdk.calls.includes("pause"), false);
  check("playback event forwarded", events.length, 1);
  check("event shape", [events[0].paused, events[0].uri, events[0].lost], [false, "spotify:track:a", false]);

  player.resumeFree(); player.seekFree(9000.4); player.pauseFree();
  check("free controls reach the SDK", sdk.calls.filter((c) => c !== "activate"), ["resume", "seek:9000", "pause"]);

  sdk.emit("player_state_changed", null);
  check("null state is reported as lost", events[1].lost, true);
  check("lost clears ownership", player.isOwning("spotify:track:a"), false);
}

// --- stale results ---------------------------------------------------------------
{
  requests.length = 0;
  putDelayMs = 40;
  const first = player.playTrack("spotify:track:a");
  await wait(5);
  const second = player.playTrack("spotify:track:b");
  const [r1, r2] = await Promise.all([first, second]);
  check("older playTrack is stale", [r1.ok, r1.reason], [false, "stale"]);
  check("newer playTrack wins", r2.ok, true);
  check("owns the newer uri only", [player.isOwning("spotify:track:a"), player.isOwning("spotify:track:b")], [false, true]);

  // A stop while a request is in flight must silence what the request starts.
  sdk.calls.length = 0;
  const third = player.playTrack("spotify:track:c");
  await wait(5);
  player.stopFree();
  const r3 = await third;
  check("play superseded by stop is stale", r3.reason, "stale");
  check("stale request's audio is paused", sdk.calls.filter((c) => c === "pause").length >= 2, true);
  check("nothing owned after stop", player.isOwning("spotify:track:c"), false);
  putDelayMs = 0;
}

// --- after stop, the guard is back ------------------------------------------------
{
  sdk.calls.length = 0;
  sdk.emit("player_state_changed", st());
  check("guard back on after stopFree", sdk.calls.includes("pause"), true);
}

// --- premium ---------------------------------------------------------------------
{
  let premiumSignals = 0;
  player.onPremiumError(() => premiumSignals++);
  putStatus = 403;
  const res = await player.playTrack("spotify:track:a");
  check("403 premium reason", [res.ok, res.reason], [false, "premium"]);
  check("premium flag flips", player.isPremium(), false);
  check("premium listeners notified", premiumSignals, 1);
  check("not owning after failure", player.isOwning("spotify:track:a"), false);
  putStatus = 204;
}

off();
if (failures.length > 0) {
  console.error(`player.test.mjs: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`player.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
process.exit(0);
