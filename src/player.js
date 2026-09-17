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
};

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
    // Silence guard: never leave the device playing outside an active clip.
    if (!state.clipActive && st && st.paused === false) state.player?.pause();
  });

  state.player = player;
  const connected = await player.connect();
  if (!connected) {
    notifyError("connect-failed");
  }
  return player;
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