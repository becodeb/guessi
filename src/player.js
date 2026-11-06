// Spotify Web Playback SDK engine (design "Web Playback SDK Lifecycle", playback spec).
// SDK script is injected lazily (never in index.html). Clip control:
// prime-on-select → seek(0)+resume() inside the click gesture → 50ms position
// poll → pause() at targetMs. No DOM access; HTTP only via spotify-api.

import { SDK_URL, PLAYER_NAME } from "./config.js";
import { apiFetch } from "./spotify-api.js";

const state = {
  player: null,
  deviceId: null,
  volume: 0.8,
  premium: true, // assumed Premium until proven otherwise
  connecting: false,
  pollId: null,
  failsafeId: null,
  clipActive: false,
  onEnd: null,
  primedUri: null, // track currently loaded (paused) on the device
  // "Free" playback (the continuous lyrics player): playback the user started
  // with an explicit play press. Nothing here ever runs before that press.
  free: false,
  ownedUri: null, // track this tab put on the device via playTrack
  sdkLive: false, // last SDK state was non-null, i.e. the device still has playback
  playSeq: 0, // bumped by every free operation, so stale async results can tell
  lastOp: null, // "play" | "stop", what bumped playSeq last
  // Phone fallback (see "remote mode" below). Never touched before a play press.
  confirmed: false, // the SDK reported our uri playing since the last play
  sdkSilent: false, // the SDK device proved useless on this phone: go straight to the app
  watchdogId: null,
  intent: null, // { uri, pos, at, playing }: what the user asked for, to resume from
  remoteToasted: false,
  remote: {
    on: false, // playback lives on another device of the user, driven over HTTP
    pending: false, // the fallback is deciding; the SDK is not to be believed meanwhile
    seq: 0,
    deviceId: null,
    paused: true,
    confirmed: false,
    settleUntil: 0,
    graceUntil: 0,
    lastPos: 0,
    sawPlaying: false,
    pollId: null,
    polling: false,
  },
};

/** Timings in ms; tests shrink them. */
export const timing = {
  deviceWait: 5000, // wait for the SDK device before giving up on it (desktop)
  deviceWaitCoarse: 3000, // ...and on a phone, where the fallback is next
  confirm: 4000, // after a PUT that worked: wait this long for a playing SDK state
  poll: 2000, // remote mode: GET /me/player cadence while audible
  settle: 6000, // remote mode: a state that is not ours yet is not "lost" before this
  grace: 3000, // remote mode: right after a resume, a paused state is stale
};

const playbackListeners = new Set();

/**
 * Subscribe to free-playback state: `{ paused, position, duration, uri, ended,
 * lost, at }`. Only fires while this tab owns free playback (after playTrack).
 * `lost` means the SDK reported no state, i.e. playback moved to another device.
 * @param {(s: object) => void} cb
 */
export function onPlayback(cb) {
  playbackListeners.add(cb);
  return () => playbackListeners.delete(cb);
}

function notifyPlayback(payload) {
  for (const cb of playbackListeners) cb(payload);
}

const noticeListeners = new Set();

/**
 * One-line facts the UI may tell the user about the phone fallback:
 * "remote-playing" (first time per session) and "no-remote-device".
 * @param {(kind: string) => void} cb
 */
export function onNotice(cb) {
  noticeListeners.add(cb);
  return () => noticeListeners.delete(cb);
}

function notice(kind) {
  for (const cb of noticeListeners) cb(kind);
}

/** A finger is the main pointer: the Spotify app on this phone is a way out. */
function isCoarse() {
  return typeof globalThis.matchMedia === "function" && globalThis.matchMedia("(pointer: coarse)").matches;
}

/**
 * The device to hand playback to when this tab's own SDK device cannot make
 * sound. Prefers an active smartphone, then any smartphone, then any active
 * device. Restricted devices cannot be controlled, and this tab's own device
 * (by id, or by the name it registers with) is never the answer.
 * @param {Array<{id?: string, name?: string, type?: string, is_active?: boolean, is_restricted?: boolean}>} devices
 * @param {string|null} [ownId]
 */
export function pickPhoneDevice(devices, ownId = null) {
  const usable = (Array.isArray(devices) ? devices : []).filter((d) => (
    d && d.id && !d.is_restricted && d.id !== ownId && d.name !== PLAYER_NAME
  ));
  const phone = (d) => String(d.type ?? "").toLowerCase() === "smartphone";
  return usable.find((d) => phone(d) && d.is_active)
    ?? usable.find(phone)
    ?? usable.find((d) => d.is_active)
    ?? null;
}

const premiumListeners = new Set();
const errorListeners = new Set();
const readyListeners = new Set();

/** @param {(deviceId: string|null) => void} cb */
export function onPremiumError(cb) {
  premiumListeners.add(cb);
  return () => premiumListeners.delete(cb);
}

export function onPlayerError(cb) {
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

/** Fires when the SDK device (re)connects — lets the app self-heal banners. */
export function onReady(cb) {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

function notifyPremium() {
  for (const cb of premiumListeners) cb();
}

function notifyError(detail) {
  for (const cb of errorListeners) cb(detail);
}

function notifyReady() {
  for (const cb of readyListeners) cb();
}

function loadSdk() {
  if (window.Spotify?.Player) return Promise.resolve();
  if (state.connecting) return state.connecting;
  state.connecting = new Promise((resolve, reject) => {
    const existing = document.getElementById("spotify-player-sdk");
    if (existing) {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", () => reject(new Error("SDK load failed")), { once: true });
      return;
    }
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.id = "spotify-player-sdk";
    script.src = SDK_URL;
    script.async = true;
    script.onerror = () => reject(new Error("SDK load failed"));
    document.head.appendChild(script);
  });
  return state.connecting;
}

/**
 * Lazy-init the SDK and connect the player. Idempotent.
 * @param {() => Promise<string|null>} getToken  returns a fresh access token
 */
export async function initPlayer(getToken) {
  if (state.player) return state.player;
  try {
    await loadSdk();
  } catch (err) {
    notifyError("sdk-load");
    throw err;
  }
  const player = new window.Spotify.Player({
    name: PLAYER_NAME,
    getOAuthToken: (cb) => {
      getToken().then((token) => cb(token ?? ""));
    },
    volume: state.volume,
  });

  player.addListener("ready", ({ device_id }) => {
    state.deviceId = device_id;
    state.sdkSilent = false; // a device (re)appeared: the SDK gets another chance
    notifyReady();
  });
  player.addListener("not_ready", ({ device_id }) => {
    // Normal SDK lifecycle: the device session went inactive. NOT fatal.
    if (device_id === state.deviceId) state.deviceId = null;
  });
  player.addListener("initialization_error", () => notifyError("initialization_error"));
  player.addListener("authentication_error", () => notifyError("authentication_error"));
  player.addListener("account_error", () => {
    state.premium = false;
    notifyPremium();
  });
  player.addListener("autoplay_failed", () => {
    // Not a premium signal and not fatal: best-effort unlock, then warn.
    bestEffortActivate();
    console.warn("Spotify player: autoplay blocked; activateElement() requested.");
  });
  player.addListener("player_state_changed", (st) => {
    // Silence guard: never leave the device playing outside an active clip or
    // free playback the user started.
    if (!state.clipActive && !state.free && st && st.paused === false) state.player?.pause();
    if (state.free) handleFreeState(st);
  });

  state.player = player;
  const connected = await player.connect();
  if (!connected) {
    notifyError("connect-failed");
  }
  return player;
}

/** Maps an SDK state to the payload `onPlayback` listeners get. */
export function describePlayback(st, now = Date.now()) {
  if (!st) return { paused: true, position: 0, duration: 0, uri: null, ended: false, lost: true, at: now };
  const current = st.track_window?.current_track;
  const previous = st.track_window?.previous_tracks ?? [];
  // A track relinked for the user's market reports the uri that was asked for
  // under `linked_from`; that is the one the game knows the song by.
  const uriOf = (t) => t?.linked_from?.uri ?? t?.uri ?? null;
  const uri = uriOf(current);
  const ended = Boolean(st.paused && (st.position ?? 0) === 0 && uri && previous.some((t) => uriOf(t) === uri));
  return {
    paused: Boolean(st.paused),
    position: st.position ?? 0,
    duration: st.duration ?? 0,
    uri,
    ended,
    lost: false,
    at: now,
  };
}

function handleFreeState(st) {
  // Once playback lives on the Spotify app the SDK device has nothing to say
  // (it reports "no state" as soon as playback leaves it, which is not a loss).
  if (state.remote.on || state.remote.pending) return;
  if (st && st.paused === false && describePlayback(st).uri === (state.ownedUri ?? state.intent?.uri)) {
    state.confirmed = true;
    state.sdkSilent = false;
    clearWatchdog();
  }
  state.sdkLive = Boolean(st);
  if (!st) state.ownedUri = null; // playback moved elsewhere: the next play must PUT again
  notifyPlayback(describePlayback(st));
}

/** True when the SDK has given us a usable device. */
export function isReady() {
  return Boolean(state.player && state.deviceId);
}

export function isPremium() {
  return state.premium;
}

export function getDeviceId() {
  return state.deviceId;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeState() {
  try {
    return (await state.player?.getCurrentState()) ?? null;
  } catch {
    return null;
  }
}

/** Best-effort playback unlock (autoplay policy). Fire-and-forget. */
function bestEffortActivate() {
  try {
    const p = state.player?.activateElement?.();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {
    // Best-effort only.
  }
}

/** Poll until playback actually starts (paused === false), bounded. */
async function waitForPlaying(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await safeState();
    if (st && st.paused === false) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Guarantee a primed track ends paused: wait for the stream to actually start,
 * pause, then verify `paused === true` with bounded retries. When the state is
 * never readable, pause() is still called a few times (bounded) so playback
 * can never be left running.
 */
async function ensurePaused() {
  if (!state.player) return;
  await waitForPlaying(1200);
  state.player.pause();
  for (let i = 0; i < 6; i++) {
    await sleep(120);
    const st = await safeState();
    if (st?.paused === true) return;
    state.player.pause();
  }
}

/**
 * True when `uri` is the track currently loaded (paused) on the device, i.e.
 * Play only needs seek+resume. Another view may have primed a different track.
 */
export function isPrimed(uri) {
  return Boolean(state.player && state.deviceId && state.primedUri === uri);
}

/**
 * Preload a track onto the device: PUT play from `positionMs`, then make sure
 * it ends paused, so Play only needs seek+resume. Called on select and Next;
 * the album tracklist passes an offset to prime inside a track's tail. Returns
 * false when no device is available or the play call fails.
 */
export async function prime(uri, { positionMs = 0 } = {}) {
  if (!state.player || !state.deviceId) return false;
  try {
    await apiFetch(`/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`, {
      method: "PUT",
      body: { uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) },
    });
    await ensurePaused();
    state.primedUri = uri;
    return true;
  } catch (err) {
    if (err?.status === 403 && err?.message === "PREMIUM_REQUIRED") {
      state.premium = false;
      notifyPremium();
    } else {
      notifyError("prime-failed");
    }
    return false;
  }
}

/**
 * Play a clip: seek(fromMs)+resume() fire synchronously inside the user
 * gesture; a 50ms poll pauses at position ≥ fromMs + targetMs. `fromMs` starts
 * the window elsewhere in the track (the album tracklist previews the tail).
 * The audible window may exceed targetMs by SDK latency (100–500ms) —
 * tolerated by design, no compensation beyond one poll interval.
 */
export function playClip(targetMs, { fromMs = 0, onEnd } = {}) {
  if (!state.player || !state.deviceId) return false;
  stop();
  state.clipActive = true;
  state.onEnd = onEnd ?? null;
  bestEffortActivate();
  state.player.seek(fromMs);
  state.player.resume();
  // Wall-clock failsafe: even when the position poll can never read state,
  // the clip cannot run away (the 50ms poll stays the primary stop).
  state.failsafeId = setTimeout(() => stop(), targetMs + 600);
  state.pollId = setInterval(async () => {
    let position = null;
    try {
      const st = await state.player.getCurrentState();
      position = st?.position ?? null;
    } catch {
      position = null;
    }
    if (position != null && position >= fromMs + targetMs) {
      stop();
    }
  }, 50);
  return true;
}

/** Pause + clear the position poll and failsafe. Leaves the device active. */
export function stop() {
  state.clipActive = false;
  state.free = false;
  state.ownedUri = null;
  state.sdkLive = false;
  endRemote({ pause: true });
  clearWatchdog();
  if (state.failsafeId) {
    clearTimeout(state.failsafeId);
    state.failsafeId = null;
  }
  if (state.pollId) {
    clearInterval(state.pollId);
    state.pollId = null;
  }
  if (state.player) state.player.pause();
  if (state.onEnd) {
    const cb = state.onEnd;
    state.onEnd = null;
    cb();
  }
}

export function setVolume(v) {
  state.volume = Math.min(1, Math.max(0, v));
  if (state.player) state.player.setVolume(state.volume);
}

// --- free playback (continuous lyrics player) --------------------------------
// Nothing below is called before the user presses play: opening the game,
// picking a song, seeking or skipping while paused only touch the UI.

async function waitForDevice(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!state.deviceId && Date.now() < deadline) await sleep(100);
  return Boolean(state.player && state.deviceId);
}

const playUrl = (deviceId) => `/me/player/play?device_id=${encodeURIComponent(deviceId)}`;
const playBody = (uri, positionMs) => ({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) });

/** Where the song should be now, by what the user asked for. */
function intentPosition() {
  const i = state.intent;
  if (!i) return 0;
  return i.playing ? i.pos + (Date.now() - i.at) : i.pos;
}

function setIntent(patch) {
  state.intent = { ...(state.intent ?? { uri: null, pos: 0, at: Date.now(), playing: false }), ...patch };
}

/**
 * Start `uri` on this tab's device (the moment playback moves here).
 * Resolves `{ ok: true }`, or `{ ok: false, reason }` with reason
 * "premium" | "no-device" | "no-remote-device" | "error" | "stale". "stale"
 * means the user did something else (skipped, stopped) while the request was
 * in flight.
 *
 * On a phone (coarse pointer) the SDK device may never make sound, so when it
 * has no device, when its play request fails, or when no playing state shows up
 * after a request that worked, playback is handed to the Spotify app on the
 * phone (see "remote mode"). That only ever happens after this call.
 * @param {string} uri
 * @param {{positionMs?: number}} [opts]
 */
export async function playTrack(uri, { positionMs = 0 } = {}) {
  const coarse = isCoarse();
  if (!state.player && !coarse) return { ok: false, reason: "no-device" };
  const my = ++state.playSeq;
  state.lastOp = "play";
  state.free = true;
  state.ownedUri = null;
  state.confirmed = false;
  clearWatchdog();
  setIntent({ uri, pos: positionMs, at: Date.now(), playing: true });
  bestEffortActivate();
  if (coarse && (state.remote.on || state.sdkSilent)) {
    return remotePlay(uri, positionMs, my, state.remote.on ? state.remote.deviceId : null);
  }
  if (!state.player || !(await waitForDevice(coarse ? timing.deviceWaitCoarse : timing.deviceWait))) {
    if (my !== state.playSeq) return { ok: false, reason: "stale" };
    if (coarse) {
      state.sdkSilent = true;
      return remotePlay(uri, positionMs, my, null);
    }
    state.free = false;
    return { ok: false, reason: "no-device" };
  }
  if (my !== state.playSeq) return { ok: false, reason: "stale" };
  try {
    await apiFetch(playUrl(state.deviceId), { method: "PUT", body: playBody(uri, positionMs) });
  } catch (err) {
    if (err?.status === 403 && err?.message === "PREMIUM_REQUIRED") {
      if (my === state.playSeq) state.free = false;
      state.premium = false;
      notifyPremium();
      return { ok: false, reason: "premium" };
    }
    if (coarse && my === state.playSeq) {
      console.warn("Spotify rejected play, trying the Spotify app:", err?.status, err?.message);
      return remotePlay(uri, positionMs, my, null);
    }
    if (my === state.playSeq) state.free = false;
    console.warn("Spotify rejected play:", err?.status, err?.message, { uri, positionMs });
    return { ok: false, reason: "error" };
  }
  if (my !== state.playSeq) {
    // The user moved on while the request was in flight. If the newer action
    // was a stop, the audio this request started must not keep playing.
    if (state.lastOp === "stop") state.player?.pause();
    return { ok: false, reason: "stale" };
  }
  state.ownedUri = uri;
  state.sdkLive = true;
  state.primedUri = null; // the device now holds free playback, not a primed clip
  setIntent({ at: Date.now() });
  if (coarse) armWatchdog(my);
  return { ok: true };
}

/** True when this tab started `uri` and the device still holds that playback. */
export function isOwning(uri) {
  return Boolean(state.free && state.ownedUri && state.ownedUri === uri && state.sdkLive);
}

export function resumeFree() {
  if (!state.free) return;
  if (state.remote.on) return remoteResume();
  if (state.remote.pending) {
    setIntent({ at: Date.now(), playing: true });
    return;
  }
  if (!state.player) return;
  setIntent({ at: Date.now(), playing: true });
  bestEffortActivate();
  state.player.resume();
  if (!state.confirmed && isCoarse()) armWatchdog(state.playSeq);
}

export function pauseFree() {
  if (!state.free) return;
  setIntent({ pos: intentPosition(), at: Date.now(), playing: false });
  if (state.remote.on) return remotePause();
  clearWatchdog();
  if (state.remote.pending || !state.player) return;
  state.player.pause();
}

export function seekFree(ms) {
  if (!state.free) return;
  const to = Math.max(0, Math.round(ms));
  setIntent({ pos: to, at: Date.now() });
  if (state.remote.on) return remoteSeek(to);
  if (state.remote.pending || !state.player) return;
  state.player.seek(to);
}

/** Pause and give up free playback (the next play will PUT again). */
export function stopFree() {
  state.playSeq++;
  state.lastOp = "stop";
  const wasFree = state.free;
  state.free = false;
  state.ownedUri = null;
  state.sdkLive = false;
  clearWatchdog();
  if (state.remote.pending) state.remote.pending = false;
  if (state.remote.on) {
    endRemote({ pause: true });
    return;
  }
  if (wasFree && state.player) state.player.pause();
}

// --- remote mode: the Spotify app on this phone -------------------------------
// The SDK device of a phone browser is sometimes silent. After the user pressed
// play, playback is handed to another device of theirs (normally the Spotify
// app on this very phone) and driven with plain Web API calls. Polling
// GET /me/player maps its state onto the same `onPlayback` payload; it runs
// only while the song is audibly playing.

function clearWatchdog() {
  if (state.watchdogId) {
    clearTimeout(state.watchdogId);
    state.watchdogId = null;
  }
}

/** No playing SDK state shortly after a PUT that worked: the SDK is silent. */
function armWatchdog(seq) {
  clearWatchdog();
  if (!isCoarse() || state.confirmed) return;
  state.watchdogId = setTimeout(async () => {
    state.watchdogId = null;
    if (seq !== state.playSeq || !state.free || state.confirmed || state.remote.on) return;
    const st = await safeState();
    if (seq !== state.playSeq || !state.free || state.remote.on) return;
    if (st && st.paused === false) {
      state.confirmed = true;
      return;
    }
    state.sdkSilent = true;
    const uri = state.intent?.uri ?? state.ownedUri;
    if (!uri) return;
    const res = await remotePlay(uri, intentPosition(), seq, null);
    if (!res.ok && res.reason !== "stale") {
      // The user already saw "playing"; tell the UI it is not.
      state.ownedUri = null;
      state.sdkLive = false;
      notifyPlayback(describePlayback(null));
    }
  }, timing.confirm);
}

/**
 * Hands `uri` to the phone's Spotify app (or to `knownDevice` when remote mode
 * already runs). Resolves like playTrack.
 */
async function remotePlay(uri, positionMs, my, knownDevice) {
  const r = state.remote;
  if (!r.on) r.pending = true;
  const seq = ++r.seq;
  let deviceId = knownDevice;
  try {
    if (!deviceId) {
      const data = await apiFetch("/me/player/devices");
      if (my !== state.playSeq || seq !== r.seq) return { ok: false, reason: "stale" };
      const dev = pickPhoneDevice(data?.devices, state.deviceId);
      if (!dev) return failRemote(my, "no-remote-device");
      deviceId = dev.id;
    }
    await apiFetch(playUrl(deviceId), { method: "PUT", body: playBody(uri, positionMs) });
  } catch (err) {
    if (my !== state.playSeq || seq !== r.seq) return { ok: false, reason: "stale" };
    if (err?.status === 403 && err?.message === "PREMIUM_REQUIRED") {
      state.premium = false;
      notifyPremium();
      return failRemote(my, "premium");
    }
    if (err?.status === 404) return failRemote(my, "no-remote-device");
    console.warn("Spotify rejected play on the phone:", err?.status, err?.message);
    return failRemote(my, "error");
  }
  if (my !== state.playSeq || seq !== r.seq) {
    if (state.lastOp === "stop" && deviceId) remoteCall(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`);
    return { ok: false, reason: "stale" };
  }
  const now = Date.now();
  Object.assign(r, {
    on: true, pending: false, deviceId, paused: false, confirmed: false,
    settleUntil: now + timing.settle, graceUntil: now + timing.grace,
    lastPos: positionMs, sawPlaying: false,
  });
  state.ownedUri = uri;
  state.sdkLive = true; // "the playback is still held somewhere we can drive"
  state.primedUri = null;
  clearWatchdog();
  // The user may have paused while the hand-over was in flight.
  if (state.intent && !state.intent.playing) {
    remotePause();
  } else {
    startPoll();
    notifyPlayback({
      paused: false, position: positionMs, duration: 0, uri, ended: false, lost: false, at: now, remote: true,
    });
  }
  if (!state.remoteToasted) {
    state.remoteToasted = true;
    notice("remote-playing");
  }
  return { ok: true };
}

function failRemote(my, reason) {
  const r = state.remote;
  r.pending = false;
  if (r.on) endRemote(); // the device we were driving is gone
  if (my === state.playSeq) {
    state.free = false;
    state.ownedUri = null;
    state.sdkLive = false;
  }
  if (reason === "no-remote-device") notice("no-remote-device");
  return { ok: false, reason };
}

/** Fire-and-forget control call; a 404 means the device went away. */
async function remoteCall(path, opts = { method: "PUT" }) {
  const seq = state.remote.seq;
  try {
    await apiFetch(path, opts);
  } catch (err) {
    if (seq !== state.remote.seq) return;
    if (err?.status === 404) {
      lostRemote(true);
      return;
    }
    console.warn("Spotify app control failed:", path.split("?")[0], err?.status, err?.message);
  }
}

const withDevice = (path, extra = "") => {
  const q = `${extra ? `${extra}&` : ""}device_id=${encodeURIComponent(state.remote.deviceId)}`;
  return `${path}?${q}`;
};

function remotePause() {
  const r = state.remote;
  r.paused = true;
  stopPoll();
  remoteCall(withDevice("/me/player/pause"));
}

function remoteResume() {
  const r = state.remote;
  const now = Date.now();
  r.paused = false;
  r.graceUntil = now + timing.grace;
  r.settleUntil = now + timing.settle;
  remoteCall(withDevice("/me/player/play"));
  startPoll();
}

function remoteSeek(ms) {
  state.remote.graceUntil = Date.now() + timing.grace;
  remoteCall(withDevice("/me/player/seek", `position_ms=${ms}`));
}

function startPoll() {
  const r = state.remote;
  if (r.pollId) return;
  r.pollId = setInterval(pollRemote, timing.poll);
}

function stopPoll() {
  const r = state.remote;
  if (r.pollId) {
    clearInterval(r.pollId);
    r.pollId = null;
  }
}

/** Leaves remote mode (optionally pausing the app). Sends nothing when idle. */
function endRemote({ pause = false } = {}) {
  const r = state.remote;
  r.seq++;
  r.pending = false;
  stopPoll();
  if (!r.on) return;
  const deviceId = r.deviceId;
  const audible = !r.paused;
  r.on = false;
  r.deviceId = null;
  r.paused = true;
  if (pause && audible && deviceId) {
    apiFetch(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, { method: "PUT" }).catch(() => {});
  }
}

/** Playback is no longer ours: another device or another song took over. */
function lostRemote(gone) {
  const r = state.remote;
  if (!r.on) return;
  endRemote();
  state.ownedUri = null;
  state.sdkLive = false;
  notifyPlayback(describePlayback(null));
  if (gone) notice("no-remote-device");
}

async function pollRemote() {
  const r = state.remote;
  if (!r.on || r.paused || r.polling) return;
  const seq = r.seq;
  r.polling = true;
  try {
    const st = await apiFetch("/me/player");
    if (seq !== r.seq || !r.on) return;
    applyRemoteState(st);
  } catch {
    // A failed poll is skipped; the next tick asks again.
  } finally {
    r.polling = false;
  }
}

/** Maps a GET /me/player body onto the payload `onPlayback` listeners get. */
function applyRemoteState(st) {
  const r = state.remote;
  const now = Date.now();
  const item = st?.item;
  const uri = item?.linked_from?.uri ?? item?.uri ?? null;
  const ours = Boolean(st && st.device?.id === r.deviceId && uri && uri === state.ownedUri);
  if (!ours) {
    // Right after the hand-over the app may still report what it played before.
    if (!r.confirmed && Date.now() < r.settleUntil) return;
    lostRemote(false);
    return;
  }
  r.confirmed = true;
  const paused = !st.is_playing;
  if (paused && now < r.graceUntil) return; // stale: the resume has not landed yet
  const position = st.progress_ms ?? 0;
  const duration = item.duration_ms ?? 0;
  if (!paused) r.sawPlaying = true;
  const ended = paused && r.sawPlaying && duration > 0 && r.lastPos >= duration - 5000
    && (position <= 1000 || position >= duration - 1500);
  r.lastPos = position;
  if (paused) {
    r.paused = true;
    stopPoll();
  }
  notifyPlayback({
    paused, position: ended ? 0 : position, duration, uri: state.ownedUri, ended, lost: false, at: now, remote: true,
  });
}
