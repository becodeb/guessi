// Shared clip player for the "Afiche" game kit: a pill progress meter, one
// Play/Stop button and volume, and a Premium gate that reacts live to player
// status instead of trusting a one-shot isPremium().

import * as ui from "./ui.js";
import { CLIP_STEPS_MS } from "./clip-steps.js";

const MAX_SCALE_MS = CLIP_STEPS_MS[CLIP_STEPS_MS.length - 1];

/**
 * Build a clip player bound to `ctx.player`. Call `setTrack()` before
 * `play()`, and `destroy()` on unmount or when swapping to a new song.
 * @param {object} ctx  app context ({ player, state, ... })
 * @param {{actions?: Node[], gate?: HTMLElement}} [opts]  `gate` overrides the
 *   default premium-gate content (e.g. a game-specific message and link).
 * @returns {{el: HTMLElement, setStep: (i:number)=>void, getStep: ()=>number,
 *   getOffset: ()=>number, stepsCount: number, play: ()=>void, stop: ()=>void,
 *   isPlaying: ()=>boolean, setTrack: (track:object, opts?:{fromMs?:number})=>void,
 *   destroy: ()=>void}}
 */
export function createClipPlayer(ctx, opts = {}) {
  const st = {
    track: null,
    stepIndex: 0,
    fromMs: 0,
    playing: false,
    primed: false,
    priming: null,
  };

  const fill = ui.el("div", { class: "clip-player__fill" });
  const unlocked = ui.el("div", { class: "clip-player__unlocked" });
  const ticks = ui.el("div", { class: "clip-player__ticks", "aria-hidden": "true" });
  for (const ms of CLIP_STEPS_MS) {
    ticks.append(ui.el("span", { class: "clip-player__tick", style: `left:${(ms / MAX_SCALE_MS) * 100}%` }));
  }
  const track = ui.el("div", { class: "clip-player__track", "aria-hidden": "true" }, unlocked, ticks, fill);
  const length = ui.el("span", { class: "clip-player__length display--num" });
  const meter = ui.el("div", { class: "clip-player__meter" }, track, length);

  const playBtn = ui.el("button", {
    class: "clip-player__play",
    type: "button",
    "aria-label": "Reproducir",
  }, ui.icon("play"));
  playBtn.addEventListener("click", () => {
    if (st.playing) stop();
    else play();
  });

  const volumeHost = ui.volumeControl(ctx);
  volumeHost.classList.add("volume--compact");
  const hint = ui.el("p", { class: "clip-player__hint small dim", hidden: true });
  const gate = opts.gate ?? ui.premiumGate({});
  gate.classList.add("clip-player__gate");
  gate.hidden = true;

  const primary = ui.el("div", { class: "clip-player__controls" }, playBtn, ...(opts.actions ?? []));
  const secondary = ui.el("div", { class: "clip-player__secondary" }, volumeHost);

  const root = ui.el("div", { class: "clip-player" }, meter, hint, gate, primary, secondary);

  const offReady = ctx.player.onReady(() => syncStatus());
  const offPremiumError = ctx.player.onPremiumError(() => syncStatus());

  function syncStatus() {
    const premium = ctx.player.isPremium();
    const ready = ctx.player.isReady();
    root.dataset.state = !premium ? "non-premium" : !ready ? "connecting" : st.playing ? "playing" : "idle";
    gate.hidden = premium;
    hint.hidden = !premium || ready;
    meter.hidden = !premium;
    primary.hidden = !premium;
    secondary.hidden = !premium;
    playBtn.disabled = !premium || !ready;
    hint.textContent = "Conectando con Spotify…";
  }

  function syncMeter() {
    const targetMs = CLIP_STEPS_MS[st.stepIndex];
    const pct = (targetMs / MAX_SCALE_MS) * 100;
    unlocked.style.width = `${pct}%`;
    fill.style.width = `${pct}%`;
    for (let i = 0; i < ticks.children.length; i++) {
      ticks.children[i].classList.toggle("clip-player__tick--unlocked", i <= st.stepIndex);
    }
    length.textContent = ui.formatMs(targetMs);
  }

  async function play() {
    if (st.playing || !st.track || playBtn.disabled) return;
    if (!st.primed && st.priming) await st.priming;
    if (!ctx.player.isPrimed(st.track.uri)) {
      st.priming = ctx.player.prime(st.track.uri);
      st.primed = await st.priming;
    }
    if (!st.primed) {
      ui.toast("El reproductor todavía no está listo. Probá de nuevo.", "error");
      return;
    }
    const targetMs = CLIP_STEPS_MS[st.stepIndex];
    st.playing = true;
    playBtn.setAttribute("aria-label", "Detener");
    playBtn.replaceChildren(ui.icon("stop"));
    root.dataset.state = "playing";
    fill.style.transition = "none";
    fill.style.transform = "scaleX(0)";
    void fill.offsetWidth;
    fill.style.transition = `transform ${targetMs}ms linear`;
    fill.style.transform = "scaleX(1)";
    ctx.player.playClip(targetMs, {
      fromMs: st.fromMs,
      onEnd: () => {
        st.playing = false;
        playBtn.setAttribute("aria-label", "Reproducir");
        playBtn.replaceChildren(ui.icon("play"));
        root.dataset.state = ctx.player.isReady() ? "idle" : "connecting";
        fill.style.transition = "transform 120ms ease-out";
        fill.style.transform = "scaleX(0)";
      },
    });
  }

  function stop() {
    if (st.playing) ctx.player.stop();
  }

  function setStep(i) {
    stop();
    st.stepIndex = Math.min(Math.max(i, 0), CLIP_STEPS_MS.length - 1);
    syncMeter();
  }

  function setTrack(trackData, { fromMs = 0 } = {}) {
    stop();
    st.track = trackData ?? null;
    st.primed = false;
    st.stepIndex = 0;
    st.fromMs = fromMs > 0 ? fromMs : 0;
    syncMeter();
    if (st.track) {
      st.priming = ctx.player.prime(st.track.uri, { positionMs: st.fromMs });
      st.priming.then((ok) => { st.primed = ok; });
    }
  }

  function destroy() {
    stop();
    offReady();
    offPremiumError();
  }

  syncMeter();
  syncStatus();

  return {
    el: root,
    setStep,
    getStep: () => st.stepIndex,
    getOffset: () => st.fromMs,
    stepsCount: CLIP_STEPS_MS.length,
    play,
    stop,
    isPlaying: () => st.playing,
    setTrack,
    destroy,
  };
}
