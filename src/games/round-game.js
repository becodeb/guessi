// Round game — the merged mode: one random track, every challenge alive on a
// single screen at once (no stages, no forced order). A single shared clue card
// holds the obscured album cover and the audio clip; the challenge sections
// below it track their own progress independently.
//
// Cleanup contract (design "Cleanup"): unmount() stops audio, clears every
// createAutoGuess timer, aborts the lyrics fetch, and drops the round so no
// timer/listener outlives a route change.

import * as ui from "../ui.js";
import * as match from "../match.js";
import { createAutoGuess } from "../guess-auto.js";
import {
  CLIP_STEPS_MS, clipIncrement, growClip,
  OFFSET_STEPS_MS, offsetIncrement, growOffset,
} from "../clip-steps.js";
import { isStaleCover } from "../storage.js";
import { createLyricsGame, tokenize, maskWord } from "../lyrics-engine.js";
import { getLyrics, saveManualLyrics } from "../lyrics.js";

// --- obscuring modes for the shared cover -----------------------------------
// Step 0 is the STRONGEST obscuring; the last index is fully revealed. Blur
// values are CSS px over a cover that can render up to ~560px wide, so they are
// sized for the wide layout: step 0 must read as a single color blob.
const BLUR_STEPS = [150, 110, 76, 48, 26, 11, 0]; // "Difusa"
const COLOR_STEPS = [190, 140, 100, 62, 34, 14, 0]; // "Color" — huge blur + boosted saturation
const PIXEL_STEPS = [64, 44, 30, 20, 12, 6, 1]; // "Pixeles" — block size, ratio of COVER_PX
const LAST_STEP = BLUR_STEPS.length - 1;
const COVER_PX = 512; // canvas backing resolution (sharp at the widest cover)

const CARD_TITLES = { song: "La canción", album: "El álbum", lyrics: "La letra" };

let handle = null;

export function mount(container, ctx) {
  handle = { container, ctx, autos: [], timers: [], abort: null };
  render();
}

export function unmount() {
  if (!handle) return;
  for (const a of handle.autos) a.clearAll();
  for (const id of handle.timers) clearTimeout(id);
  if (handle.abort) {
    try {
      handle.abort.abort();
    } catch {
      // Ignore.
    }
  }
  handle.ctx.player.stop();
  handle = null;
}

// ---------------------------------------------------------------------------

function render() {
  const { container, ctx } = handle;
  container.innerHTML = "";

  if (ctx.library.getPoolTracks().length === 0) {
    container.append(ui.emptyGuide({
      body: "Añade canciones a «Lo que sé» para jugar la ronda.",
      actionLabel: "Ir a la biblioteca",
      onAction: () => ctx.navigate("#/library"),
    }));
    return;
  }

  const view = ui.el("section", { class: "view stack--lg" });
  const live = ui.liveRegion();
  handle.view = view;
  handle.live = live;
  container.append(view);
  drawRound(view, live);
}

function drawRound(view, live) {
  // Tear down anything from the previous round so nothing leaks across draws.
  for (const a of handle.autos) a.clearAll();
  handle.autos = [];
  for (const id of handle.timers) clearTimeout(id);
  handle.timers = [];
  if (handle.abort) {
    try {
      handle.abort.abort();
    } catch {
      // Ignore.
    }
    handle.abort = null;
  }
  handle.ctx.player.stop();

  handle.cardChips = {};
  handle.cardReveal = {};
  handle.cardState = {};
  handle.cardEls = {};
  // Sections that removed themselves after their data arrived (see dropCard).
  // They must leave the progress denominator with everything else.
  handle.droppedCards = new Set();

  const track = handle.ctx.library.getRandomTrack();
  handle.round = {
    track,
    // Round-level knowledge bus: a name or an artist solved in ANY card is
    // published once and every other card gets a chance to fill itself with it.
    // The card closures stay private; only these two channels cross them.
    bus: {
      titles: new Set(), // normalized names already published (re-entrancy guard)
      rawTitles: [], // same names, raw, in publish order (for late subscribers)
      artists: new Set(), // artist keys already published
      titleSubs: [],
      artistSubs: [],
    },
  };

  view.replaceChildren(live, renderHeader(), buildLayout(track), renderFooter());
  updateProgress();
}

// --- knowledge bus ----------------------------------------------------------

/** Stable identity for a credited artist (Spotify id, else the name). */
function artistKeyOf(a) {
  return typeof a === "string" ? a : (a?.id ?? a?.name ?? null);
}

/**
 * Subscribe to solved song/album names. Returns an unsubscribe function: a
 * section that removes itself has to stop reacting, or it keeps writing into
 * detached inputs every time another card solves something.
 */
function onTitle(fn) {
  const subs = handle.round.bus.titleSubs;
  subs.push(fn);
  return () => {
    const i = subs.indexOf(fn);
    if (i !== -1) subs.splice(i, 1);
  };
}

/** Same contract as onTitle, for credited artists. */
function onArtist(fn) {
  const subs = handle.round.bus.artistSubs;
  subs.push(fn);
  return () => {
    const i = subs.indexOf(fn);
    if (i !== -1) subs.splice(i, 1);
  };
}

/**
 * Publish a solved song/album name to every card. The normalized name enters
 * the set BEFORE the subscribers run: a subscriber that locks its own field and
 * republishes the very same name must short-circuit instead of recursing.
 */
function publishTitle(name) {
  const bus = handle?.round?.bus;
  if (!bus) return;
  const key = match.normalize(name);
  if (!key || bus.titles.has(key)) return;
  bus.titles.add(key);
  bus.rawTitles.push(name);
  for (const fn of [...bus.titleSubs]) fn(name);
}

/** Same contract as publishTitle, keyed by artist identity. */
function publishArtist(artist) {
  const bus = handle?.round?.bus;
  if (!bus) return;
  const key = artistKeyOf(artist);
  if (key == null || key === "" || bus.artists.has(key)) return;
  bus.artists.add(key);
  for (const fn of [...bus.artistSubs]) fn(artist);
}

// --- header + progress ------------------------------------------------------

// Both primary actions live here, in a sticky bar: the round is a long page and
// neither "Otra canción" nor "Ver respuestas" should cost a scroll to the
// bottom. The footer keeps only the way out of the game.
function renderHeader() {
  const progress = ui.el("span", { class: "chip chip--muted", id: "round-progress" });
  handle.progressChip = progress;
  const segments = ui.el("div", { class: "round__segments", "aria-hidden": "true" });
  handle.progressSegments = segments;
  const actions = ui.el("div", { class: "round__actions" },
    barButton("btn btn--primary", "Otra canción", "Otra", () =>
      drawRound(handle.view, handle.live)),
    barButton("btn btn--ghost", "Ver respuestas", "Respuestas", () => revealAll()),
  );
  return ui.el("div", { class: "round__bar" },
    ui.el("div", { class: "round__header" },
      ui.el("span", { class: "round__title", text: "Ronda" }),
      ui.el("div", { class: "round__progress" }, segments, progress),
      actions,
    ),
  );
}

// Sticky-bar button with two visible labels, one per breakpoint, so the bar
// stays a single line on a phone. `aria-label` carries the full wording, which
// also stops a screen reader from announcing both spans.
function barButton(cls, full, short, onClick) {
  return ui.el("button", {
    class: cls,
    "aria-label": full,
    title: full,
    on: { click: onClick },
  },
    ui.el("span", { class: "round__act-full", text: full }),
    ui.el("span", { class: "round__act-short", text: short }),
  );
}

// Playable cards only (the Premium-gated ones leave the denominator when the
// player is not Premium). Segments mirror the same states as the chips:
// solved = accent, hinted/revealed = dimmed accent, pending = empty.
function playableCardIds() {
  const ids = handle.ctx.player.isPremium()
    ? ["song", "album", "lyrics"]
    : ["album", "lyrics"];
  // A section that removed itself is not a challenge: it must not count in the
  // chip's denominator nor leave a phantom segment in the strip.
  return ids.filter((id) => !handle.droppedCards.has(id));
}

function isCardDone(state) {
  return state === "solved" || state === "hinted" || state === "revealed";
}

function updateProgress() {
  if (!handle.progressChip) return;
  const ids = playableCardIds();
  const done = ids.filter((id) => isCardDone(handle.cardState[id])).length;
  handle.progressChip.textContent = `${done}/${ids.length} resueltos`;
  // Without the album card nothing reveals the cover on its own. A free account
  // has no song card either, so a fully settled round reveals it here. A round
  // that still has its album card reached this with the cover already open.
  if (
    ids.length > 0 && done === ids.length &&
    !handle.cardEls.album && handle.round?.cover?.step !== LAST_STEP
  ) {
    revealCoverFull();
  }
  if (handle.progressSegments) {
    handle.progressSegments.replaceChildren(...ids.map((id) => {
        const state = handle.cardState[id];
        const mod = state === "solved" ? "round__seg--done" : isCardDone(state) ? "round__seg--partial" : "";
        return ui.el("span", { class: `round__seg${mod ? ` ${mod}` : ""}` });
      }));
  }
}

/**
 * Remove a challenge section from the round for good. The DOM node is only half
 * the job: the round tracks each section in five places, and a detached node
 * left in any of them makes revealAll() and updateProgress() operate on
 * something that is not on screen.
 */
function dropCard(id, { auto, unsubs } = {}) {
  if (handle.droppedCards.has(id)) return;
  handle.droppedCards.add(id);

  handle.cardEls[id]?.remove();
  delete handle.cardEls[id];
  delete handle.cardChips[id];
  delete handle.cardReveal[id];
  delete handle.cardState[id];

  // Pending debounce timers would fire against inputs that are gone.
  if (auto) {
    auto.clearAll();
    handle.autos = handle.autos.filter((a) => a !== auto);
  }
  for (const off of unsubs ?? []) off();

  // The album card is what reveals the cover on a solve. If the song was
  // already settled before this section went away, nobody else would.
  if (id === "album" && isCardDone(handle.cardState.song)) revealCoverFull();

  updateProgress();
}

/**
 * The cover is the album's clue, so the album card owns revealing it. When that
 * section is not on screen, the song card inherits the job: identifying the
 * track is the same "you earned it" moment for a single-track album.
 */
function revealCoverWhenAlbumAbsent() {
  if (!handle.cardEls.album) revealCoverFull();
}

function setCardState(id, state) {
  handle.cardState[id] = state;
  const chip = handle.cardChips[id];
  if (chip) {
    const map = {
      solved: ["Adivinado", "chip--ok"],
      hinted: ["Con pistas", "chip--muted"],
      revealed: ["Revelado", "chip--muted"],
    };
    const entry = map[state];
    if (entry) {
      chip.hidden = false;
      chip.textContent = entry[0];
      chip.className = `chip ${entry[1]}`;
    }
  }
  const cardEl = handle.cardEls[id];
  if (cardEl) cardEl.classList.toggle("card--solved", state === "solved");
  updateProgress();
}

// --- layout -----------------------------------------------------------------

function buildLayout(track) {
  const premium = handle.ctx.player.isPremium();
  const left = ui.el("div", { class: "round__col round__col--left" },
    renderCoverBlock(track),
    renderAudioBar(track),
  );
  const right = ui.el("div", { class: "round__col round__col--right" },
    renderSongCard(track, premium),
    renderAlbumCard(track, premium),
  );
  const lyrics = renderLyricsCard(track);
  lyrics.classList.add("round__lyrics");
  return ui.el("div", { class: "round__grid" }, left, right, lyrics);
}

// --- shared cover block (THE only album image on screen) ---------------------

function renderCoverBlock(track) {
  const album = track.album;
  const url = album?.images?.[0]?.url;
  const c = { mode: "blur", step: 0, img: null, canvas: null, hintEl: null, modeButtons: [], retries: 0, album };
  handle.round.cover = c;

  const stage = ui.el("div", { class: "cover-stage" });

  if (url) {
    const canvas = ui.el("canvas", {
      class: "cover-canvas cover-canvas--snap",
      tabindex: "0",
      role: "button",
      "aria-label": "Portada oculta, clic para revelar",
    });
    c.canvas = canvas;
    const onReveal = () => advanceCover();
    canvas.addEventListener("click", onReveal);
    canvas.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onReveal();
      }
    });
    stage.append(canvas);

    const img = new Image();
    img.decoding = "async";
    img.onload = () => drawCover();
    img.onerror = () => {
      if (c.retries >= 1) return;
      c.retries = 1;
      handle.ctx.library.refreshAlbum(album.id).then((fresh) => {
        const u = fresh?.images?.[0]?.url;
        if (u) img.src = u;
      });
    };
    img.src = url;
    c.img = img;

    // Perishable covers: lazily re-fetch when the stored URL is stale (design D6).
    if (isStaleCover(album?.fetchedAt)) {
      handle.ctx.library.refreshAlbum(album.id).then((fresh) => {
        const u = fresh?.images?.[0]?.url;
        if (u && c.img && c.step < LAST_STEP) c.img.src = u;
      });
    }
  } else {
    stage.append(ui.el("div", { class: "cover-placeholder", "aria-label": "Sin portada" }, ui.icon("cover")));
  }

  const modes = ui.el("div", { class: "cover-modes", role: "group", "aria-label": "Modo de ocultado" },
    modeButton("blur", "Difusa", c),
    modeButton("pixel", "Pixeles", c),
    modeButton("color", "Color", c),
  );
  c.modeButtons = [...modes.querySelectorAll("button")];

  const hint = ui.el("p", { class: "cover-hint", text: `Clics restantes: ${LAST_STEP}` });
  c.hintEl = hint;

  // The art and its "Clics restantes" counter travel together: on a wide screen
  // the clue card lifts the mode buttons into the column beside the art, and the
  // counter has to stay glued underneath it.
  return ui.el("div", { class: "cover-block" },
    modes,
    ui.el("div", { class: "cover-art" }, stage, hint),
  );
}

function modeButton(mode, label, c) {
  return ui.el("button", {
    class: "cover-mode",
    type: "button",
    "aria-pressed": String(mode === c.mode),
    dataset: { mode },
    text: label,
    on: { click: () => setCoverMode(mode) },
  });
}

function setCoverMode(mode) {
  const c = handle.round.cover;
  c.mode = mode;
  for (const b of c.modeButtons) {
    b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
  }
  drawCover();
}

// REAL pixelation for "Pixeles": draw the image into a tiny canvas and let the
// browser upscale it with image-rendering: pixelated (no pixel readback — the
// cover is cross-origin). "Difusa"/"Color" draw full-res and lean on CSS filter.
//
// A fresh cover mounts with `cover-canvas--snap` (transition: none): the first
// paint must be instant, or the filter transition would fade from "no filter"
// and flash the new album in focus for ~300ms on "Otra canción".
function releaseInitialSnap(canvas) {
  if (!canvas.classList.contains("cover-canvas--snap")) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => canvas.classList.remove("cover-canvas--snap"));
  });
}

function drawCover() {
  const c = handle.round.cover;
  const canvas = c.canvas;
  const img = c.img;
  if (!canvas || !img || !img.complete || !img.naturalWidth) return;

  const mode = c.mode;
  const step = c.step;
  canvas.classList.toggle("cover-canvas--pixel", mode === "pixel");

  if (mode === "pixel") {
    const block = PIXEL_STEPS[step];
    const small = Math.max(1, Math.round(COVER_PX / block));
    canvas.width = small;
    canvas.height = small;
    const cx = canvas.getContext("2d");
    cx.imageSmoothingEnabled = false;
    cx.clearRect(0, 0, small, small);
    cx.drawImage(img, 0, 0, small, small);
    canvas.style.filter = "none";
    releaseInitialSnap(canvas);
    return;
  }

  const blur = mode === "color" ? COLOR_STEPS[step] : BLUR_STEPS[step];
  const saturate = mode === "color" ? 2.4 : 1;
  canvas.width = COVER_PX;
  canvas.height = COVER_PX;
  const cx = canvas.getContext("2d");
  cx.imageSmoothingEnabled = true;
  cx.clearRect(0, 0, COVER_PX, COVER_PX);
  cx.drawImage(img, 0, 0, COVER_PX, COVER_PX);
  canvas.style.filter = `blur(${blur}px) saturate(${saturate})`;
  releaseInitialSnap(canvas);
}

function advanceCover() {
  const c = handle.round.cover;
  if (c.step >= LAST_STEP) {
    announce("Portada ya revelada del todo");
    return;
  }
  c.step += 1;
  drawCover();
  updateCoverHint();
  announce("Portada un paso más nítida");
}

function updateCoverHint() {
  const c = handle.round.cover;
  if (!c.hintEl) return;
  const remaining = LAST_STEP - c.step;
  c.hintEl.textContent = remaining > 0 ? `Clics restantes: ${remaining}` : "Portada revelada";
}

function revealCoverFull() {
  const c = handle.round.cover;
  c.step = LAST_STEP;
  drawCover();
  updateCoverHint();
  if (c.canvas) c.canvas.setAttribute("aria-label", "Portada del álbum revelada");
}

// --- shared audio bar (the round's single player) ----------------------------

function renderAudioBar(track) {
  if (!handle.ctx.player.isPremium()) {
    return ui.el("div", {
      class: "round__audio-note muted-note",
      text: "El audio necesita Spotify Premium.",
    });
  }
  const duration = Number(track.duration_ms);
  const st = {
    playing: false,
    primed: false,
    stepIndex: 0,
    targetMs: CLIP_STEPS_MS[0],
    // Where the clip starts. Independent ladder: a silent intro is a "move the
    // window", not a "make the window longer" problem.
    fromMs: 0,
    offsetStep: 0,
    priming: null,
    maxMs: Number.isFinite(duration) && duration > 0 ? duration : Infinity,
  };
  st.priming = handle.ctx.player.prime(track.uri);
  st.priming.then((ok) => { st.primed = ok; });
  return clipBlock(track, st);
}

// Reused verbatim: prime, in-flight prime guard, ctx.player.playClip, progress.
// +0,1s doubles the jump on every tap (CLIP_STEPS_MS) and the label always
// announces the next tap's jump, so the clip can be stretched coarsely once the
// first seconds are not enough. Reproducir toggles into Detener while it plays.
//
// Two separate dimensions, two separate ladders: «+» makes the window LONGER,
// «Saltar» moves WHERE it starts. Conflating them meant a silent intro could
// only be escaped by stretching the clip until it was coarse and useless.
function clipBlock(track, st) {
  const { ctx } = handle;
  const fill = ui.el("div", { class: "clip__fill" });
  const bar = ui.el("div", { class: "clip__bar", "aria-hidden": "true" }, fill);
  const label = ui.el("span", { class: "clip__label display--num", text: ui.formatMs(st.targetMs) });
  const fromLabel = ui.el("span", { class: "clip-card__from", hidden: true });

  const stopPlayback = () => {
    if (st.playing) ctx.player.stop();
  };

  // Room the window has left before the track ends. The clip may grow up to
  // `maxMs − fromMs`, and the start may move up to `maxMs − targetMs`.
  const clipCap = () => (Number.isFinite(st.maxMs) ? Math.max(0, st.maxMs - st.fromMs) : Infinity);
  const offsetCap = () => (Number.isFinite(st.maxMs) ? Math.max(0, st.maxMs - st.targetMs) : Infinity);

  const syncClip = () => {
    label.textContent = ui.formatMs(st.targetMs);
    fromLabel.hidden = st.fromMs <= 0;
    if (st.fromMs > 0) fromLabel.textContent = `desde ${ui.formatMs(st.fromMs)}`;
    // The button always announces the NEXT tap's jump (the doubling ladder).
    addBtn.textContent = `+${ui.formatMs(clipIncrement(st.stepIndex))}`;
    addBtn.disabled = st.fromMs + st.targetMs >= st.maxMs;
    // Same convention for the start: the label is the next tap's jump.
    skipBtn.textContent = `Saltar +${ui.formatMs(offsetIncrement(st.offsetStep))}`;
    skipBtn.disabled = st.fromMs >= offsetCap();
    resetBtn.disabled =
      st.stepIndex === 0 && st.targetMs === CLIP_STEPS_MS[0] && st.offsetStep === 0 && st.fromMs === 0;
  };

  const playBtn = ui.el("button", {
    class: "btn btn--primary",
    text: "Reproducir",
    on: {
      click: async () => {
        if (st.playing) {
          stopPlayback();
          return;
        }
        if (!st.primed && st.priming) await st.priming;
        // A tracklist preview (album card) may have loaded another song onto
        // the device: re-prime the round's track before playing.
        if (!ctx.player.isPrimed(track.uri)) {
          st.priming = ctx.player.prime(track.uri);
          st.primed = await st.priming;
        }
        if (!st.primed) {
          ui.toast("El reproductor todavía no está listo. Probá de nuevo.", "error");
          return;
        }
        st.playing = true;
        playBtn.textContent = "Detener";
        fill.style.transition = `width ${st.targetMs}ms linear`;
        fill.style.width = "100%";
        ctx.player.playClip(st.targetMs, {
          fromMs: st.fromMs,
          onEnd: () => {
            st.playing = false;
            playBtn.textContent = "Reproducir";
            fill.style.transition = "width 120ms ease-out";
            fill.style.width = "0%";
          },
        });
      },
    },
  });

  const addBtn = ui.el("button", {
    class: "btn btn--ghost",
    text: `+${ui.formatMs(CLIP_STEPS_MS[0])}`,
    "aria-label": "Sumar tiempo al clip",
    on: {
      click: () => {
        stopPlayback();
        const next = growClip(st.targetMs, st.stepIndex, clipCap());
        st.targetMs = next.targetMs;
        st.stepIndex = next.stepIndex;
        syncClip();
        announce(`Clip de ${ui.formatMs(st.targetMs)}`);
      },
    },
  });

  const skipBtn = ui.el("button", {
    class: "btn btn--ghost",
    text: `Saltar +${ui.formatMs(OFFSET_STEPS_MS[0])}`,
    title: "Correr el arranque del clip",
    "aria-label": "Saltar el inicio de la canción",
    on: {
      click: () => {
        stopPlayback();
        const next = growOffset(st.fromMs, st.offsetStep, offsetCap());
        st.fromMs = next.fromMs;
        st.offsetStep = next.stepIndex;
        syncClip();
        announce(`Clip de ${ui.formatMs(st.targetMs)} desde ${ui.formatMs(st.fromMs)}`);
      },
    },
  });

  const resetBtn = ui.el("button", {
    class: "btn btn--ghost",
    text: "Reiniciar",
    "aria-label": "Volver el clip a 0,1 s desde el arranque",
    on: {
      click: () => {
        stopPlayback();
        st.stepIndex = 0;
        st.targetMs = CLIP_STEPS_MS[0];
        st.offsetStep = 0;
        st.fromMs = 0;
        syncClip();
        announce("Clip de 0,1 s desde el arranque");
      },
    },
  });
  const hint = ui.el("p", {
    class: "clip-card__hint",
    text: "«+» alarga el clip; «Saltar» corre el arranque para saltear el silencio del principio. Reiniciar vuelve a 0,1 s desde cero.",
  });

  syncClip();

  // Volume lives with the audio, not on the hub: changing it used to cost a
  // trip out of the round. Same factory the hub uses, same shared state value.
  // Only reachable when Premium, since the non-Premium path returns the notice
  // before ever building this card.
  return ui.el("div", { class: "card clip-card" },
    ui.el("div", { class: "clip-card__head" },
      ui.el("span", { class: "clip-card__caption", text: "Clip" }),
      ui.el("span", { class: "clip-card__readout" }, fromLabel, label),
    ),
    ui.el("div", { class: "clip" }, bar),
    ui.el("div", { class: "clip__actions" }, playBtn, addBtn, skipBtn, resetBtn),
    ui.volumeControl(handle.ctx),
    hint,
  );
}

// --- card shell -------------------------------------------------------------

// Which card is open on arrival. Only one, so the round opens as a short menu
// instead of an endless scroll: the player picks the challenge they want.
// "La canción" is the natural first stop, but it is Premium-gated, so a free
// account opens on the album card instead of on a locked one.
function defaultCardOpen(id) {
  return handle.ctx.player.isPremium() ? id === "song" : id === "album";
}

// Native <details>/<summary>: keyboard toggling, Enter/Space, and the
// aria-expanded semantics come from the browser instead of hand-rolled ARIA.
// The summary keeps the `card__head` class — the album card appends its
// tracklist chip through that selector.
function makeCard(id) {
  const chip = ui.el("span", { class: "chip chip--muted", hidden: true });
  handle.cardChips[id] = chip;
  const head = ui.el("summary", { class: "card__head round-sec__head" },
    // A collapsed row is a menu entry, not a page title: it must read as a
    // strong UI label, below the round's own heading in the type scale.
    ui.el("h2", { class: "round-sec__title", text: CARD_TITLES[id] }),
    chip,
  );
  const body = ui.el("div", { class: "stack round-sec__body" });
  // The per-id modifier is what lets the stylesheet reorder the sections
  // against the clue blocks on narrow viewports.
  const cardEl = ui.el("details", { class: `card round-sec round-sec--${id}` }, head, body);
  cardEl.open = defaultCardOpen(id);
  handle.cardEls[id] = cardEl;
  return { cardEl, body };
}

// --- card: La canción (title + credited artists, Premium) -------------------

function renderSongCard(track, premium) {
  const id = "song";
  const { cardEl, body } = makeCard(id);
  if (!premium) {
    body.append(ui.el("p", { class: "muted-note", text: "Requiere Spotify Premium." }));
    const chip = handle.cardChips[id];
    chip.hidden = false;
    chip.textContent = "Requiere Premium";
    chip.className = "chip chip--muted";
    return cardEl;
  }

  const auto = createAutoGuess();
  handle.autos.push(auto);

  const artists = track.artists ?? [];
  const artistNames = artists.map((a) => (typeof a === "string" ? a : (a.name ?? "")));
  const st = { titleSolved: false, artistsSolved: artists.length === 0 };

  const bannerText = ui.el("span", { text: "¡Correcto! Canción resuelta." });
  const solvedBanner = ui.el("div", { class: "solved-banner", hidden: true },
    ui.icon("check"), bannerText);

  const checkSolved = () => {
    if (st.titleSolved && st.artistsSolved) {
      solvedBanner.hidden = false;
      announce("Canción y artistas correctos");
      revealCoverWhenAlbumAbsent();
      setCardState(id, "solved");
    }
  };

  const input = ui.el("input", {
    class: "guess__input", type: "text", placeholder: "Escribe el título",
    "aria-label": "Adivina el título", autocomplete: "off",
  });
  const group = ui.el("div", { class: "guess" }, input);

  const evaluate = () => {
    const v = input.value;
    if (!v.trim()) { group.classList.remove("guess--correct", "guess--incorrect"); return; }
    if (match.matchTitle(v, track.name)) {
      st.titleSolved = true;
      input.disabled = true;
      input.value = track.name;
      group.classList.remove("guess--incorrect");
      group.classList.add("guess--correct");
      announce(`Título correcto: ${track.name}`);
      checkSolved();
      publishTitle(track.name);
    } else {
      group.classList.remove("guess--correct");
      group.classList.add("guess--incorrect");
      announce("Título incorrecto, probá de nuevo");
    }
  };
  const instant = () =>
    match.normalize(input.value) === match.normalize(track.name) ||
    match.normalize(input.value) === match.normalize(match.stripAliases(track.name));
  auto.bind(group, input, instant, evaluate);

  // Artist slots: one per credited artist, order-free, each correct guess
  // relocates to the artist's own slot (same contract as the album card).
  const slotInputs = [];
  const slotGroups = [];
  const evaluateArtists = () => {
    const focused = document.activeElement;
    const focusPrev = focused && slotInputs.includes(focused) ? focused.value : null;

    const values = slotInputs.map((i) => i.value);
    const result = match.assignArtistSlots(values, artists);
    const lockedBefore = slotInputs.filter((i) => i.disabled).length;

    slotInputs.forEach((slotInput, j) => {
      const slotGroup = slotGroups[j];
      const val = result.values[j];
      slotGroup.classList.remove("guess--correct", "guess--incorrect");
      if (result.locked[j]) {
        slotInput.disabled = true;
        if (slotInput.value !== val) slotInput.value = val;
        slotGroup.classList.add("guess--correct");
      } else if (val !== "") {
        slotGroup.classList.add("guess--incorrect");
      } else if (slotInput.value !== "") {
        slotInput.value = "";
      }
    });

    st.artistsSolved = result.solved;
    if (result.solved) {
      announce("Artistas de la canción correctos");
      checkSolved();
    } else {
      const lockedAfter = slotInputs.filter((i) => i.disabled).length;
      const hasWrong = result.values.some((v, j) => v !== "" && !result.locked[j]);
      if (lockedAfter > lockedBefore) announce("Artista correcto");
      else if (hasWrong) announce("Artista incorrecto, probá de nuevo");
    }

    // Focus preservation: keep the keyboard flow on the first empty open slot.
    if (focused && slotInputs.includes(focused)) {
      const movedAway =
        focused.disabled || (focusPrev !== null && focusPrev !== "" && focused.value === "");
      if (movedAway) {
        const next = slotInputs.find((i) => !i.disabled && i.value === "");
        if (next && next !== focused) next.focus();
      }
    }

    // Published last: a subscriber may move focus (the album card fills rows),
    // and this card's own focus flow must settle first.
    // `locked` is indexed by the CREDITED artist, not by the slot that guessed.
    artists.forEach((artist, j) => {
      if (result.locked[j]) publishArtist(artist);
    });
  };
  artists.forEach((artist) => {
    const slotInput = ui.el("input", {
      class: "guess__input", type: "text", placeholder: "Escribe un artista",
      "aria-label": "Adivina el artista de la canción", autocomplete: "off",
    });
    slotInputs.push(slotInput);
    const slotGroup = ui.el("div", { class: "guess" }, slotInput);
    const slotInstant = () =>
      artistNames.some(
        (n) =>
          match.normalize(slotInput.value) === match.normalize(n) ||
          match.normalize(slotInput.value) === match.normalize(match.stripAliases(n)),
      );
    auto.bind(slotGroup, slotInput, slotInstant, evaluateArtists);
    slotGroups.push(slotGroup);
  });

  handle.cardReveal[id] = () => {
    st.titleSolved = true;
    st.artistsSolved = true;
    input.disabled = true;
    input.value = track.name;
    group.classList.add("guess--correct");
    artists.forEach((artist, j) => {
      const n = typeof artist === "string" ? artist : artist.name;
      slotInputs[j].disabled = true;
      slotInputs[j].value = n;
      slotGroups[j].classList.add("guess--correct");
    });
    solvedBanner.hidden = false;
    bannerText.textContent = "Canción revelada.";
    revealCoverWhenAlbumAbsent();
    setCardState(id, "revealed");
    publishTitle(track.name);
    artists.forEach((artist) => publishArtist(artist));
  };

  // --- bus subscriptions -----------------------------------------------------

  onTitle((name) => {
    if (st.titleSolved || !match.matchTitle(name, track.name)) return;
    st.titleSolved = true;
    input.disabled = true;
    input.value = track.name;
    group.classList.remove("guess--incorrect");
    group.classList.add("guess--correct");
    checkSolved();
  });

  onArtist((a) => {
    const key = artistKeyOf(a);
    if (key == null) return;
    const j = artists.findIndex((x) => artistKeyOf(x) === key);
    if (j === -1) return;
    const slotInput = slotInputs[j];
    if (!slotInput || slotInput.disabled) return;
    slotInput.value = artistNames[j];
    slotInput.disabled = true;
    slotGroups[j].classList.remove("guess--incorrect");
    slotGroups[j].classList.add("guess--correct");
    st.artistsSolved = slotInputs.every((i) => i.disabled);
    checkSolved();
  });

  body.append(
    ui.el("div", { class: "round-fields" },
      ui.el("div", { class: "round-field" },
        ui.el("p", { class: "guess-panel__title", text: "Adivina el título" }),
        group,
      ),
      artists.length > 0
        ? ui.el("div", { class: "round-field" },
            ui.el("p", { class: "guess-panel__title", text: "Adivina los artistas" }),
            ...slotGroups,
          )
        : null,
    ),
    solvedBanner,
  );
  return cardEl;
}

// --- card: El álbum y los artistas (no Premium needed) ----------------------

// --- card: El álbum y los artistas (no Premium needed) ----------------------
// Album-level guess (name + artist slots) plus an always-visible tracklist
// guessing game: one row per album track (song, in album order, + its credited
// artists), a free-order song input, and a "Temas: N/M" progress chip.

function renderAlbumCard(track, premium) {
  const id = "album";
  const { cardEl, body } = makeCard(id);
  cardEl.classList.add("album-card");
  // The canonical album record lives in the library's albums map; the track's
  // embedded copy only carries full metadata after the first reload. Either way
  // the card needs the album artists: they are the album-level slots.
  const album = handle.ctx.library.getLibrary().albums?.[track.album?.id] ?? track.album;
  const myRound = handle.round;
  const st = {
    albumCorrect: false,
    artistSolved: (album?.artists?.length ?? 0) === 0,
  };
  const auto = createAutoGuess();
  handle.autos.push(auto);
  // Filled by the bus subscriptions at the bottom of this function. The drop
  // path needs them: a removed section must stop reacting to names and artists
  // solved in the cards that are still on screen.
  const unsubs = [];

  // Artists solved anywhere in this card (album-level slots or a track row) are
  // known for the whole album: the owner is credited on every track, so typing
  // it once must fill every row instead of asking again per song.
  const knownArtists = new Set();
  const artistKey = (a) => (typeof a === "string" ? a : (a?.id ?? a?.name ?? null));
  const artistName = (a) => (typeof a === "string" ? a : (a?.name ?? ""));
  const isKnownArtist = (a) => knownArtists.has(artistKey(a));

  // Tracklist game state — the grid is always visible; rows are state-driven so
  // chip syncs and the reveal re-render stay lossless (no typed text is dropped).
  const ac = {
    tracks: null,
    tracklistLoaded: false,
    loadError: false,
    // A single-track album has nothing this section can ask that the song card
    // does not already cover, so the whole section removes itself in that case.
    singleTrack: false,
    rowState: [],
    rowEls: [],
  };

  const albumInput = ui.el("input", {
    class: "guess__input", type: "text", placeholder: "Escribe el álbum",
    "aria-label": "Adivina el álbum", autocomplete: "off", disabled: st.albumCorrect,
  });
  const albumGroup = ui.el("div", { class: "guess" }, albumInput);
  const albumBannerText = ui.el("span", { text: "¡Correcto! Álbum resuelto." });
  const solvedBanner = ui.el("div", { class: "solved-banner", hidden: true },
    ui.icon("check"), albumBannerText);
  const tracklistBox = ui.el("div", { class: "stack" });
  const tracklistChip = ui.el("span", { class: "chip chip--muted", hidden: true });
  cardEl.querySelector(".card__head").append(tracklistChip);

  const checkSolved = () => {
    if (st.albumCorrect && st.artistSolved) {
      solvedBanner.hidden = false;
      revealCoverFull();
      setCardState(id, "solved");
    }
  };

  const lockAlbum = (name) => {
    st.albumCorrect = true;
    albumInput.disabled = true;
    albumInput.value = name;
    albumGroup.classList.remove("guess--incorrect");
    albumGroup.classList.add("guess--correct");
    checkSolved();
    publishTitle(name);
  };

  // A solved name fills every row that expects the same name: repeated titles
  // fill all of their rows at once. Rows match by expected name, never by
  // position. The album-level half of the old propagateTitle now lives in the
  // bus subscriber, so a title solved in ANY card reaches here too.
  function applyTitleToRows(name) {
    if (!ac.tracklistLoaded) return;
    const filled = [];
    for (let i = 0; i < ac.tracks.length; i++) {
      if (ac.rowState[i].songLocked) continue;
      if (!match.matchTitle(name, ac.tracks[i].name)) continue;
      lockRowSong(i, ac.tracks[i].name);
      filled.push(i + 1);
    }
    if (filled.length === 0) return;
    updateTracklistChip();
    if (ac.singleTrack) return; // nothing on screen to describe
    announce(`Se completaron por nombre repetido: tema${filled.length > 1 ? "s" : ""} ${filled.join(", ")}`);
  }

  const evaluateAlbum = () => {
    const v = albumInput.value;
    if (!v.trim()) { albumGroup.classList.remove("guess--correct", "guess--incorrect"); return; }
    if (match.matchAlbum(v, album.name)) {
      lockAlbum(album.name);
      announce(`Álbum correcto: ${album.name}`);
    } else {
      albumGroup.classList.remove("guess--correct");
      albumGroup.classList.add("guess--incorrect");
      announce("Álbum incorrecto, probá de nuevo");
    }
  };
  const albumInstant = () =>
    match.normalize(albumInput.value) === match.normalize(album.name) ||
    match.normalize(albumInput.value) === match.normalize(match.stripAliases(album.name));
  auto.bind(albumGroup, albumInput, albumInstant, evaluateAlbum);

  const slotInputs = [];
  let slotGroups = [];
  const evaluateArtists = () => {
    const values = slotInputs.map((i) => i.value);
    const result = match.assignArtistSlots(values, album.artists ?? []);
    slotInputs.forEach((input, j) => {
      const group = slotGroups[j];
      const val = result.values[j];
      const isLocked = result.locked[j];
      group.classList.remove("guess--correct", "guess--incorrect");
      if (isLocked) {
        input.disabled = true;
        if (input.value !== val) input.value = val;
        group.classList.add("guess--correct");
      } else if (val !== "") {
        group.classList.add("guess--incorrect");
      } else if (input.value !== "") {
        input.value = "";
      }
    });
    st.artistSolved = result.solved;
    // Per-artist propagation: each solved album artist is known for every
    // track, even before the whole album slot set is solved.
    if (markKnownArtists(album.artists ?? [], result.locked)) syncKnownArtists();
    if (result.solved) {
      announce("Artistas del álbum correctos");
      checkSolved();
    }
    (album.artists ?? []).forEach((artist, j) => {
      if (result.locked[j]) publishArtist(artist);
    });
  };
  slotGroups = (album.artists ?? []).map((artist) => {
    const input = ui.el("input", {
      class: "guess__input", type: "text", placeholder: "Escribe un artista",
      "aria-label": "Adivina el artista del álbum", autocomplete: "off",
    });
    slotInputs.push(input);
    const group = ui.el("div", { class: "guess" }, input);
    const n = typeof artist === "string" ? artist : artist.name;
    const instant = () =>
      match.normalize(input.value) === match.normalize(n) ||
      match.normalize(input.value) === match.normalize(match.stripAliases(n));
    auto.bind(group, input, instant, evaluateArtists);
    return group;
  });

  // --- free-order song input (no order required) -----------------------------
  const freeGroup = ui.el("div", { class: "guess" });
  const freeInput = ui.el("input", {
    class: "guess__input", type: "text", placeholder: "Escribí un tema del álbum…",
    "aria-label": "Adivina cualquier tema del álbum", autocomplete: "off",
  });
  freeGroup.append(freeInput);
  const freeNote = ui.el("p", {
    class: "muted-note",
    text: "Escribí cualquier tema del álbum, sin importar el orden",
  });
  // One container so a single-track album can hide the whole tracklist game.
  // It joins the other two fields in the grid, so a wide card lays all three
  // out in a row instead of leaving the free-order field alone on its own line.
  const freeBlock = ui.el("div", { class: "round-field" },
    ui.el("p", { class: "guess-panel__title", text: "O en cualquier orden" }),
    freeGroup,
    freeNote,
  );
  const evaluateFree = () => {
    if (!ac.tracklistLoaded) return;
    const v = freeInput.value.trim();
    if (!v) return;
    // First unfilled row (album order) whose name matches — fill & lock it.
    let hit = -1;
    for (let i = 0; i < ac.tracks.length; i++) {
      if (!ac.rowState[i].songLocked && match.matchTitle(v, ac.tracks[i].name)) {
        hit = i;
        break;
      }
    }
    if (hit === -1) return; // no error state: do nothing until it matches
    lockRowSong(hit, ac.tracks[hit].name);
    freeInput.value = "";
    announce(`Tema ${hit + 1} correcto: ${ac.tracks[hit].name}`);
    updateTracklistChip();
  };
  auto.bind(freeGroup, freeInput, () => true, evaluateFree);

  // --- tracklist grid --------------------------------------------------------

  async function loadAlbumTracklist() {
    if (ac.tracklistLoaded || ac.loadError) return;
    tracklistBox.append(ui.skeleton(4));
    let tracks;
    try {
      tracks = await handle.ctx.library.getAlbumTracklist(album.id);
    } catch {
      ac.loadError = true;
      tracklistBox.innerHTML = "";
      tracklistBox.append(ui.el("div", { class: "banner banner--error" },
        ui.icon("warn"),
        ui.el("span", { text: "No se pudo cargar la lista de temas." }),
        ui.el("button", {
          class: "btn btn--sm", text: "Reintentar",
          on: {
            click: () => {
              ac.loadError = false;
              tracklistBox.innerHTML = "";
              loadAlbumTracklist();
            },
          },
        }),
      ));
      return;
    }
    if (handle.round !== myRound) return; // stale response guard
    ac.tracks = tracks;
    ac.tracklistLoaded = true;
    ac.rowState = tracks.map(newRowState);
    // A single-track album: the track normally shares the album's name, so
    // solving the song already covers this whole section. The count is only
    // known now, after the fetch, so the card renders first and then removes
    // itself. Nothing below this point applies to a section that is gone.
    if (tracks.length <= 1) {
      ac.singleTrack = true;
      dropCard(id, { auto, unsubs });
      return;
    }
    // Names solved while this was loading never saw these rows. The bus set
    // holds NORMALIZED names, so replay the raw ones kept alongside it.
    const pending = [...handle.round.bus.rawTitles];
    renderAlbumTracklistGrid();
    updateTracklistChip();
    for (const name of pending) applyTitleToRows(name);
  }

  // One ladder per row edge (start / end), same doubling as the round clip.
  function newPreviewLadder() {
    return { stepIndex: 0, targetMs: CLIP_STEPS_MS[0] };
  }

  function newRowState(t) {
    return {
      songText: "",
      songLocked: false,
      artistVals: (t.artists ?? []).map(() => ""),
      artistLocked: (t.artists ?? []).map(() => false),
      // No credited artists to solve → the row's artist part is already done.
      artistSolved: (t.artists ?? []).length === 0,
      preview: { head: newPreviewLadder(), tail: newPreviewLadder() },
    };
  }

  function renderAlbumTracklistGrid() {
    if (!ac.tracklistLoaded) return;
    auto.clearAll(); // drop timers for inputs about to be detached
    tracklistBox.innerHTML = ""; // also clears the loading skeleton
    if (ac.singleTrack) return; // no grid for a single-track album
    const grid = ui.el("div", { class: "album-tracks" });
    ac.rowEls = [];
    for (let i = 0; i < ac.tracks.length; i++) grid.append(buildTrackRow(i));
    tracklistBox.append(grid);
    syncPreviewButtons(); // button labels/disabled come from the stored ladders
  }

  function artistChip(name) {
    return ui.el("span", { class: "chip chip--ok" },
      ui.el("span", { class: "dot" }),
      ui.el("span", { text: name }));
  }

  // Add the credited artists whose slots are locked to the known set. Returns
  // true when at least one artist was new (the grid then needs a sync).
  function markKnownArtists(credited, locked) {
    let gained = false;
    credited.forEach((artist, j) => {
      const key = artistKey(artist);
      if (!locked?.[j] || key == null || knownArtists.has(key)) return;
      knownArtists.add(key);
      gained = true;
    });
    return gained;
  }

  // Fill every row where a known artist is still an input with a chip, in place:
  // no grid re-render, so the field being typed in keeps focus. A row left with
  // no inputs counts its artist part as solved.
  function syncKnownArtists() {
    if (!ac.tracklistLoaded) return;
    const focused = document.activeElement;
    let stoleFocus = false;
    for (let i = 0; i < ac.tracks.length; i++) {
      const rs = ac.rowState[i];
      const els = ac.rowEls[i];
      if (!els) continue;
      const credited = ac.tracks[i].artists ?? [];
      for (let m = els.remIdx.length - 1; m >= 0; m--) {
        const k = els.remIdx[m];
        const artist = credited[k];
        if (!isKnownArtist(artist)) continue;
        const group = els.artistGroups[m];
        if (focused && group.contains(focused)) stoleFocus = true;
        group.replaceWith(artistChip(artistName(artist)));
        els.remIdx.splice(m, 1);
        els.artistInputs.splice(m, 1);
        els.artistGroups.splice(m, 1);
        rs.artistLocked[k] = true;
        rs.artistVals[k] = artistName(artist);
      }
      if (els.remIdx.length === 0) rs.artistSolved = true;
    }
    if (stoleFocus) {
      const next = ac.rowEls
        .flatMap((els) => els?.artistInputs ?? [])
        .find((input) => !input.disabled && input.value === "");
      if (next) next.focus();
    }
    updateTracklistChip();
  }

  function buildTrackRow(i) {
    const track = ac.tracks[i];
    const rs = ac.rowState[i];
    const num = ui.el("span", {
      class: "album-track__num",
      text: String(track.track_number ?? i + 1),
    });

    const songInput = ui.el("input", {
      class: "guess__input", type: "text", placeholder: "Canción",
      "aria-label": `Canción ${track.track_number ?? i + 1} del álbum`,
      autocomplete: "off", disabled: rs.songLocked,
    });
    if (rs.songLocked) songInput.value = track.name;
    else songInput.value = rs.songText;
    const songGroup = ui.el("div", { class: "guess" }, songInput);
    if (rs.songLocked) songGroup.classList.add("guess--correct");
    const songInstant = () =>
      match.normalize(songInput.value) === match.normalize(track.name) ||
      match.normalize(songInput.value) === match.normalize(match.stripAliases(track.name));
    auto.bind(songGroup, songInput, songInstant, () => evaluateRowSong(i));

    const main = ui.el("div", { class: "album-track__main" }, songGroup);

    const credited = track.artists ?? [];
    const artistWrap = ui.el("div", { class: "album-track__artists" });
    const artistInputs = [];
    const artistGroups = [];
    const remIdx = [];
    for (let k = 0; k < credited.length; k++) {
      const a = credited[k];
      // A known artist (solved at the album level or in another row) shows as a
      // chip; anything else stays a guessable input.
      if (isKnownArtist(a)) {
        artistWrap.append(artistChip(a.name));
      } else {
        const input = ui.el("input", {
          class: "guess__input", type: "text", placeholder: "Artista",
          "aria-label": `Artista de la canción ${track.track_number ?? i + 1}`,
          autocomplete: "off", disabled: rs.artistLocked[k],
        });
        if (rs.artistLocked[k]) input.value = a.name;
        else input.value = rs.artistVals[k] ?? "";
        const group = ui.el("div", { class: "guess" }, input);
        if (rs.artistLocked[k]) group.classList.add("guess--correct");
        const inst = () =>
          match.normalize(input.value) === match.normalize(a.name) ||
          match.normalize(input.value) === match.normalize(match.stripAliases(a.name));
        auto.bind(group, input, inst, () => evaluateRowArtists(i));
        artistWrap.append(group);
        artistInputs.push(input);
        artistGroups.push(group);
        remIdx.push(k);
      }
    }
    if (credited.length > 0) main.append(artistWrap);

    // Every credit is auto-known (or there are none) → nothing left to guess,
    // so the row's artist part is complete even though no input triggered it.
    if (remIdx.length === 0) rs.artistSolved = true;

    // Audio previews: no track name in the labels — the row is still a guess.
    const n = track.track_number ?? i + 1;
    const previewBtn = (part) =>
      ui.el("button", {
        class: "btn btn--sm btn--ghost", type: "button",
        text: part === "tail" ? "Final" : "Inicio",
        title: `Reproducir el ${part === "tail" ? "final" : "inicio"} del tema`,
        "aria-label": `Reproducir el ${part === "tail" ? "final" : "inicio"} de la canción ${n}`,
        on: { click: () => togglePreview(i, part) },
      });
    const previewAddBtn = (part) =>
      ui.el("button", {
        class: "btn btn--sm btn--ghost", type: "button", text: `+${ui.formatMs(CLIP_STEPS_MS[0])}`,
        title: `Sumar tiempo al ${part === "tail" ? "final" : "inicio"}`,
        "aria-label": `Sumar tiempo al ${part === "tail" ? "final" : "inicio"} de la canción ${n}`,
        on: { click: () => growPreview(i, part) },
      });

    const headPlay = premium ? previewBtn("head") : null;
    const headAdd = premium ? previewAddBtn("head") : null;
    const tailPlay = premium ? previewBtn("tail") : null;
    const tailAdd = premium ? previewAddBtn("tail") : null;
    const audioCol = premium
      ? ui.el("div", { class: "album-track__audio" },
          ui.el("div", { class: "album-track__audio-line" }, headPlay, headAdd),
          ui.el("div", { class: "album-track__audio-line" }, tailPlay, tailAdd),
        )
      : null;

    ac.rowEls[i] = {
      songInput, songGroup, artistInputs, artistGroups, remIdx,
      headPlay, headAdd, tailPlay, tailAdd,
    };
    return ui.el("div", { class: "album-track" }, num, main, audioCol);
  }

  function evaluateRowSong(i) {
    const rs = ac.rowState[i];
    const els = ac.rowEls[i];
    const v = els.songInput.value;
    if (!v.trim()) {
      els.songGroup.classList.remove("guess--correct", "guess--incorrect");
      rs.songText = "";
      return;
    }
    if (match.matchTitle(v, ac.tracks[i].name)) {
      lockRowSong(i, ac.tracks[i].name);
      announce(`Tema ${i + 1} correcto: ${ac.tracks[i].name}`);
      updateTracklistChip();
    } else {
      els.songGroup.classList.remove("guess--correct");
      els.songGroup.classList.add("guess--incorrect");
      rs.songText = v;
      announce("Tema incorrecto, probá de nuevo");
    }
  }

  function evaluateRowArtists(i) {
    const rs = ac.rowState[i];
    const els = ac.rowEls[i];
    const credited = ac.tracks[i].artists ?? [];
    // Only the credits that still need a guess are inputs (auto-known album
    // artists are rendered as chips). Evaluate against that reduced set.
    const remArtists = els.remIdx.map((k) => credited[k]);
    const values = els.artistInputs.map((inp) => inp.value);
    const result = match.assignArtistSlots(values, remArtists);

    const focused = document.activeElement;
    const focusPrev = focused && els.artistInputs.includes(focused) ? focused.value : null;

    for (let m = 0; m < els.remIdx.length; m++) {
      const k = els.remIdx[m];
      const group = els.artistGroups[m];
      const input = els.artistInputs[m];
      const val = result.values[m];
      group.classList.remove("guess--correct", "guess--incorrect");
      if (result.locked[m]) {
        rs.artistLocked[k] = true;
        rs.artistVals[k] = remArtists[m].name;
        input.disabled = true;
        if (input.value !== remArtists[m].name) input.value = remArtists[m].name;
        group.classList.add("guess--correct");
      } else if (val !== "") {
        group.classList.add("guess--incorrect");
        rs.artistVals[k] = input.value;
      } else if (input.value !== "") {
        input.value = "";
        rs.artistVals[k] = "";
      } else {
        rs.artistVals[k] = input.value;
      }
    }

    rs.artistSolved = result.solved;
    if (result.solved) {
      announce(`Artistas del tema ${i + 1} correctos`);
    } else {
      const hasWrong = result.values.some((v, m) => v !== "" && !result.locked[m]);
      if (hasWrong) announce("Artista incorrecto, probá de nuevo");
    }
    updateTracklistChip();

    // Focus preservation: if the focused field got locked or its text moved
    // away, jump to the first enabled empty input in this row.
    if (focused && els.artistInputs.includes(focused)) {
      const movedAway =
        focused.disabled || (focusPrev !== null && focusPrev !== "" && focused.value === "");
      if (movedAway) {
        const next = els.artistInputs.find((inp) => !inp.disabled && inp.value === "");
        if (next && next !== focused) next.focus();
      }
    }

    // A solved artist is known for the whole album: fill it in every other row
    // that credits it instead of asking again.
    if (markKnownArtists(remArtists, result.locked)) syncKnownArtists();
    remArtists.forEach((artist, m) => {
      if (result.locked[m]) publishArtist(artist);
    });
  }

  function lockRowSong(i, name) {
    const rs = ac.rowState[i];
    rs.songLocked = true;
    rs.songText = name;
    const els = ac.rowEls[i];
    if (els) {
      els.songInput.disabled = true;
      els.songInput.value = name;
      els.songGroup.classList.remove("guess--incorrect");
      els.songGroup.classList.add("guess--correct");
    }
    publishTitle(name);
  }

  function updateTracklistChip() {
    if (!ac.tracklistLoaded || ac.singleTrack) return;
    const M = ac.tracks.length;
    const N = ac.rowState.filter((r) => r.songLocked).length;
    const allComplete = ac.rowState.every((r) => r.songLocked && r.artistSolved);
    tracklistChip.hidden = false;
    if (allComplete) {
      tracklistChip.textContent = "Tracklist completa";
      tracklistChip.className = "chip chip--ok";
    } else {
      tracklistChip.textContent = `Temas: ${N}/${M}`;
      tracklistChip.className = "chip chip--muted";
    }
  }

  // --- per-row audio previews (Premium) --------------------------------------
  // Hear the start / end of any album track without leaving the round. Each row
  // keeps its own clip ladder per edge (same doubling as the round's clip bar:
  // 0,1 → 0,2 → 0,4…), so a tap adds the next step; «Final» plays the last N
  // seconds of the song. Playback goes through the shared Spotify device, so a
  // preview stops the round's clip (and vice versa) and the clip bar re-primes.
  const preview = { row: -1, part: null, playing: false };

  function previewCap(track) {
    const duration = Number(track.duration_ms);
    return Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  }

  function syncPreviewButtons() {
    for (let i = 0; i < ac.rowEls.length; i++) {
      const els = ac.rowEls[i];
      if (!els?.headPlay) continue;
      const state = ac.rowState[i].preview;
      const cap = previewCap(ac.tracks[i]);
      const canTail = Number.isFinite(cap);
      const on = preview.playing && preview.row === i;
      els.headPlay.textContent = on && preview.part === "head" ? "Detener" : "Inicio";
      els.tailPlay.textContent = on && preview.part === "tail" ? "Detener" : "Final";
      els.headAdd.textContent = `+${ui.formatMs(clipIncrement(state.head.stepIndex))}`;
      els.tailAdd.textContent = `+${ui.formatMs(clipIncrement(state.tail.stepIndex))}`;
      els.tailPlay.disabled = !canTail;
      els.tailAdd.disabled = !canTail || state.tail.targetMs >= cap;
      els.headAdd.disabled = state.head.targetMs >= cap;
    }
  }

  function growPreview(i, part) {
    const state = ac.rowState[i].preview[part];
    handle.ctx.player.stop(); // same as the clip bar: a tap stops the clip first
    const next = growClip(state.targetMs, state.stepIndex, previewCap(ac.tracks[i]));
    state.targetMs = next.targetMs;
    state.stepIndex = next.stepIndex;
    syncPreviewButtons();
    announce(
      `Clip de ${ui.formatMs(state.targetMs)} del ${part === "tail" ? "final" : "inicio"} del tema ${i + 1}`
    );
  }

  async function togglePreview(i, part) {
    const rowTrack = ac.tracks[i];
    const wasOn = preview.playing && preview.row === i && preview.part === part;
    handle.ctx.player.stop(); // stops the round clip or a previous preview
    if (wasOn) return;
    const cap = previewCap(rowTrack);
    if (part === "tail" && !Number.isFinite(cap)) return;
    const state = ac.rowState[i].preview[part];
    const targetMs = Math.min(state.targetMs, cap);
    const fromMs = part === "tail" ? Math.max(0, cap - targetMs) : 0;
    const uri = rowTrack.uri ?? `spotify:track:${rowTrack.id}`;
    const player = handle.ctx.player;
    if (!player.isPrimed(uri)) {
      // Prime inside the window being previewed, so the pre-roll stays there.
      const ok = await player.prime(uri, { positionMs: fromMs });
      if (!ok) {
        ui.toast("El reproductor todavía no está listo. Probá de nuevo.", "error");
        return;
      }
      if (!handle || handle.round !== myRound) return; // navigated away mid-prime
    }
    preview.row = i;
    preview.part = part;
    preview.playing = true;
    syncPreviewButtons();
    announce(
      `Reproduciendo ${ui.formatMs(targetMs)} del ${part === "tail" ? "final" : "inicio"} del tema ${i + 1}`
    );
    player.playClip(targetMs, {
      fromMs,
      onEnd: () => {
        preview.playing = false;
        preview.row = -1;
        preview.part = null;
        syncPreviewButtons();
      },
    });
  }

  async function revealAlbumTracklistAll() {
    if (!ac.tracklistLoaded) {
      try {
        const tracks = await handle.ctx.library.getAlbumTracklist(album.id);
        if (handle.round === myRound) {
          ac.tracks = tracks;
          ac.tracklistLoaded = true;
          ac.rowState = tracks.map(newRowState);
        }
      } catch {
        // Leave the grid untouched on network failure.
      }
    }
    if (!ac.tracks) return;
    for (let i = 0; i < ac.tracks.length; i++) {
      const rs = ac.rowState[i];
      rs.songLocked = true;
      rs.songText = ac.tracks[i].name;
      const credited = ac.tracks[i].artists ?? [];
      for (let k = 0; k < credited.length; k++) {
        rs.artistLocked[k] = true;
        rs.artistVals[k] = credited[k].name;
      }
      rs.artistSolved = true;
    }
    renderAlbumTracklistGrid();
    updateTracklistChip();
  }

  handle.cardReveal[id] = () => {
    st.albumCorrect = true;
    st.artistSolved = true;
    albumInput.disabled = true;
    albumInput.value = album.name;
    albumGroup.classList.add("guess--correct");
    (album.artists ?? []).forEach((artist, j) => {
      const n = typeof artist === "string" ? artist : artist.name;
      if (n) {
        slotInputs[j].disabled = true;
        slotInputs[j].value = n;
        slotGroups[j].classList.add("guess--correct");
      }
    });
    solvedBanner.hidden = false;
    albumBannerText.textContent = "Álbum revelado.";
    revealCoverFull();
    revealAlbumTracklistAll();
    setCardState(id, "revealed");
  };

  // --- bus subscriptions -----------------------------------------------------

  unsubs.push(onTitle((name) => {
    if (!st.albumCorrect && match.matchAlbum(name, album.name)) {
      lockAlbum(album.name);
      announce(`Álbum correcto: ${album.name}`);
    }
    applyTitleToRows(name);
  }));

  unsubs.push(onArtist((a) => {
    const key = artistKeyOf(a);
    if (key == null) return;
    if (!knownArtists.has(key)) {
      knownArtists.add(key);
      syncKnownArtists();
    }
    const credited = album.artists ?? [];
    const j = credited.findIndex((x) => artistKeyOf(x) === key);
    if (j === -1) return;
    const slotInput = slotInputs[j];
    if (!slotInput || slotInput.disabled) return;
    slotInput.value = artistName(credited[j]);
    slotInput.disabled = true;
    slotGroups[j].classList.remove("guess--incorrect");
    slotGroups[j].classList.add("guess--correct");
    st.artistSolved = slotInputs.every((i) => i.disabled);
    checkSolved();
  }));

  body.append(
    ui.el("div", { class: "round-fields" },
      ui.el("div", { class: "round-field" },
        ui.el("p", { class: "guess-panel__title", text: "Adivina el álbum" }),
        albumGroup,
      ),
      (album.artists?.length ?? 0) > 0
        ? ui.el("div", { class: "round-field" },
            ui.el("p", { class: "guess-panel__title", text: "Adivina el artista" }),
            ...slotGroups,
          )
        : null,
      freeBlock,
    ),
    solvedBanner,
    tracklistBox,
  );

  loadAlbumTracklist();
  return cardEl;
}

// --- card: La letra (ported verbatim behavior) ------------------------------

function renderLyricsCard(track) {
  const id = "lyrics";
  const { cardEl, body } = makeCard(id);
  const st = { engine: null, wordEls: [], done: false, lastCursor: null, forceReveal: false };
  const round = handle.round;

  const helpLine = ui.el("p", { class: "muted-note lyrics__help", text: "Espacio coloca la palabra en el cursor; Enter completa todas las apariciones de esa palabra." });
  const area = ui.el("div", { class: "lyrics", "aria-label": "Letra" });
  const hintLine = ui.el("p", { class: "muted-note lyrics__hintline" });
  const input = ui.el("input", {
    class: "input lyrics__input", type: "text", placeholder: "Escribí una palabra…",
    "aria-label": "Escribí una palabra", autocomplete: "off",
  });
  const inputWrap = ui.el("div", { class: "guess" }, input);

  const pistaBtn = ui.el("button", { class: "btn btn--ghost", text: "Pista" });
  const revealBtn = ui.el("button", { class: "btn btn--ghost", text: "Revelar todo" });
  const controls = ui.el("div", { class: "lyrics__controls" }, pistaBtn, revealBtn);

  body.append(helpLine, area, controls, hintLine, inputWrap);
  area.append(ui.skeleton(6));

  const finish = (outcomeOverride) => {
    if (st.done) return;
    st.done = true;
    input.disabled = true;
    const outcome = outcomeOverride ?? (st.engine && st.engine.hintCount() > 0 ? "hinted" : "solved");
    setCardState(id, outcome === "revealed" ? "revealed" : outcome === "hinted" ? "hinted" : "solved");
  };
  const revealLyrics = () => {
    if (st.engine) { st.engine.revealAll(); refreshAll(); }
    finish("revealed");
  };
  handle.cardReveal[id] = revealLyrics;

  const refreshWord = (gi) => {
    const w = st.engine.words[gi];
    const btn = st.wordEls[gi];
    if (st.engine.isRevealed(gi)) {
      btn.textContent = w.text;
      btn.className = "lyrics__w lyrics__w--revealed";
    } else {
      btn.textContent = maskWord(w.text, st.engine.hintLevel(gi));
      btn.className = "lyrics__w";
    }
  };
  const refreshAll = () => {
    for (let gi = 0; gi < st.engine.words.length; gi++) refreshWord(gi);
  };
  const syncCursor = () => {
    const cur = st.engine.cursor();
    st.wordEls.forEach((btn, gi) => {
      btn.classList.toggle("lyrics__w--cursor", gi === cur);
      btn.classList.toggle("lyrics__w--known", gi === cur && st.engine.isDiscovered(st.engine.words[gi].normalized));
    });
  };
  const scrollCursor = () => {
    // Scrolling a collapsed section yanks the page: the card is a <details>
    // and its body is not rendered while closed.
    if (!cardEl.open) return;
    const cur = st.engine.cursor();
    if (cur != null && st.wordEls[cur]) st.wordEls[cur].scrollIntoView({ block: "nearest" });
  };
  const updateHintCounter = () => {
    const n = st.engine.hintCount();
    hintLine.textContent = n > 0 ? `Pistas: ${n}` : "";
  };
  const clearInputError = () => {
    inputWrap.classList.remove("guess--incorrect");
    if (st.errTimer) clearTimeout(st.errTimer);
  };
  const applyResult = (res) => {
    if (res.revealedIndex != null) {
      refreshWord(res.revealedIndex);
      st.wordEls[res.revealedIndex].classList.add("lyrics__w--enter");
    }
    syncCursor();
    scrollCursor();
    updateHintCounter();
    clearInputError();
    if (st.engine.isComplete()) finish();
  };
  const lastToken = (value) => {
    const t = String(value ?? "").trim();
    if (!t) return "";
    return t.split(/\s+/).pop();
  };
  const onWordClick = (gi) => {
    if (st.done || st.engine.isRevealed(gi)) return;
    st.engine.moveCursor(gi);
    syncCursor();
    scrollCursor();
    input.focus();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key !== " " && e.key !== "Enter") return;
    e.preventDefault();
    if (st.done) return;
    const tok = lastToken(input.value);
    if (e.key === " ") {
      if (tok === "") {
        const res = st.engine.revealKnownAtCursor();
        if (res.ok) applyResult(res);
      } else {
        const res = st.engine.placeAtCursor(tok);
        if (res.ok) { applyResult(res); input.value = ""; }
        else {
          ui.toast("No es la palabra del cursor", "info");
          inputWrap.classList.add("guess--incorrect");
          input.value = "";
          st.errTimer = setTimeout(() => inputWrap.classList.remove("guess--incorrect"), 700);
          handle.timers.push(st.errTimer);
        }
      }
    } else {
      if (tok === "") return;
      // Enter completes EVERY occurrence. revealAnywhere reveals one hit per
      // call, so drain it: a chorus word used to cost one Enter per repetition.
      // (lyrics-engine.js is shared and covered by tests — looped here, not
      // changed there.)
      const hits = [];
      let res = st.engine.revealAnywhere(tok);
      while (res.ok) {
        hits.push(res.revealedIndex);
        res = st.engine.revealAnywhere(tok);
      }
      if (hits.length === 0) {
        const norm = match.normalize(tok);
        ui.toast(st.engine.discoveredWords().includes(norm) ? "Esa palabra ya está descubierta" : "No encontré esa palabra acá", "info");
        input.value = "";
      } else {
        for (const gi of hits) {
          if (gi == null) continue;
          refreshWord(gi);
          st.wordEls[gi].classList.add("lyrics__w--enter");
        }
        syncCursor();
        scrollCursor();
        updateHintCounter();
        clearInputError();
        input.value = "";
        if (hits.length > 1) ui.toast(`Se completaron ${hits.length} apariciones`, "info");
        if (st.engine.isComplete()) finish();
      }
    }
    input.focus();
  });

  pistaBtn.addEventListener("click", () => {
    if (st.done) return;
    const res = st.engine.hint();
    if (res.revealedIndex != null) {
      refreshWord(res.revealedIndex);
      st.wordEls[res.revealedIndex].classList.add("lyrics__w--enter");
    } else if (res.cursor != null) {
      refreshWord(res.cursor);
    }
    syncCursor();
    scrollCursor();
    updateHintCounter();
    if (st.engine.isComplete()) finish();
  });

  revealBtn.addEventListener("click", () => revealLyrics());

  const startLyrics = (text) => {
    area.innerHTML = "";
    const engine = createLyricsGame(text);
    st.engine = engine;
    const wordEls = new Array(engine.words.length);
    st.wordEls = wordEls;
    const { lines } = tokenize(text);
    lines.forEach((lineTokens) => {
      const lineEl = ui.el("div", { class: "lyrics__line" });
      if (lineTokens.length === 0) lineEl.append(ui.el("span", { class: "lyrics__gap", "aria-hidden": "true" }));
      for (const tok of lineTokens) {
        if (tok.isWord) {
          const gi = tok.wordIndex;
          const btn = ui.el("button", {
            class: "lyrics__w", type: "button",
            "aria-label": `Palabra ${gi + 1}`,
            on: { click: () => onWordClick(gi) },
          });
          wordEls[gi] = btn;
          lineEl.append(btn);
        } else {
          lineEl.append(ui.el("span", { class: "lyrics__punct", text: tok.text }));
        }
      }
      area.append(lineEl);
    });
    refreshAll();
    syncCursor();
    // The lyrics card starts collapsed: focusing an input inside a closed
    // <details> makes the browser jump the page open. Only steal focus when
    // the section is actually on screen.
    if (cardEl.open) input.focus();
    if (st.forceReveal) revealLyrics();
  };

  const showManualFallback = (msg) => {
    area.innerHTML = "";
    const ta = ui.el("textarea", { class: "input lyrics__manual", rows: "8", placeholder: "Pegá la letra acá…", "aria-label": "Letra manual" });
    area.append(ui.el("div", { class: "lyrics__empty stack" },
      ui.el("p", { text: msg }),
      ui.el("p", { class: "muted-note", text: "Si la tenés, podés pegarla y guardarla para esta canción." }),
      ta,
      ui.el("button", {
        class: "btn btn--primary",
        text: "Guardar letra",
        on: {
          click: () => {
            const text = ta.value.trim();
            if (!text) return;
            saveManualLyrics(track.id, text);
            startLyrics(text);
          },
        },
      }),
    ));
  };

  const showInstrumental = () => {
    area.innerHTML = "";
    area.append(ui.el("div", { class: "lyrics__empty stack" },
      ui.el("p", { text: "Es instrumental — no tiene letra." })));
    finish("revealed");
  };

  const showError = () => {
    area.innerHTML = "";
    area.append(ui.el("div", { class: "lyrics__empty stack" },
      ui.el("p", { text: "No pude cargar la letra (problema de red)." }),
      ui.el("button", {
        class: "btn btn--primary",
        text: "Reintentar",
        on: {
          click: () => {
            area.innerHTML = "";
            area.append(ui.skeleton(6));
            fetchLyrics();
          },
        },
      }),
    ));
  };

  const fetchLyrics = () => {
    handle.abort = new AbortController();
    getLyrics(track, { signal: handle.abort.signal }).then((res) => {
      if (!handle || handle.round !== round) return; // stale response guard
      if (res.status === "ok") startLyrics(res.text);
      else if (res.status === "not-found") showManualFallback("No encontré la letra de esta canción.");
      else if (res.status === "instrumental") showInstrumental();
      else showError();
    });
  };

  fetchLyrics();
  return cardEl;
}

// --- footer + reveal-all -----------------------------------------------------

// "Otra canción" and "Ver respuestas" moved to the sticky bar: repeating them
// here would be two buttons with one intent each, at opposite ends of a long
// page. Only the exit link stays.
function renderFooter() {
  return ui.el("div", { class: "round__footer" },
    ui.el("a", { class: "ghost-link", href: "#/juegos", text: "Volver a Juegos" }),
  );
}

function revealAll() {
  revealCoverFull();
  for (const id of ["song", "album", "lyrics"]) {
    // Revealed answers behind a collapsed section are not an answer: open it.
    const cardEl = handle.cardEls[id];
    if (cardEl) cardEl.open = true;
    const fn = handle.cardReveal[id];
    if (fn) fn();
  }
}

function announce(msg) {
  if (handle.live) handle.live.textContent = msg;
}
