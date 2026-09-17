// Round game — the merged mode: one random track, ALL FOUR challenges alive on a
// single screen at once (no stages, no forced order). A single shared, obscured
// album cover sits at the top; a single shared audio bar powers both the song
// and the year challenges; four independent cards track their own progress.
//
// Cleanup contract (design "Cleanup"): unmount() stops audio, clears every
// createAutoGuess timer, aborts the lyrics fetch, and drops the round so no
// timer/listener outlives a route change.

import * as ui from "../ui.js";
import * as match from "../match.js";
import { createAutoGuess } from "../guess-auto.js";
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

const DIRECTION_COPY = { newer: "Más nuevo", older: "Más viejo", equal: "¡Correcto!" };
const CLOSENESS_COPY = { "very-close": "Muy cerca", close: "Cerca", far: "Lejos" };

const CARD_TITLES = { song: "La canción", album: "El álbum y los artistas", year: "¿De qué año?", lyrics: "La letra" };

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

  const track = handle.ctx.library.getRandomTrack();
  handle.round = { track };

  view.replaceChildren(live, renderHeader(), buildLayout(track), renderFooter());
  updateProgress();
}

// --- header + progress ------------------------------------------------------

function renderHeader() {
  const progress = ui.el("span", { class: "chip chip--muted", id: "round-progress" });
  handle.progressChip = progress;
  const ver = ui.el("button", {
    class: "btn btn--ghost",
    text: "Ver respuestas",
    on: { click: () => revealAll() },
  });
  return ui.el("div", { class: "round__header" },
    ui.el("span", { class: "round__title", text: "Ronda" }),
    progress,
    ver,
  );
}

function updateProgress() {
  if (!handle.progressChip) return;
  const premium = handle.ctx.player.isPremium();
  // Only playable cards count toward the denominator.
  const ids = premium ? ["song", "album", "year", "lyrics"] : ["album", "lyrics"];
  const done = ids.filter((id) => {
    const s = handle.cardState[id];
    return s === "solved" || s === "hinted" || s === "revealed";
  }).length;
  handle.progressChip.textContent = `${done}/${ids.length} resueltos`;
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
    renderYearCard(track, premium),
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

  return ui.el("div", { class: "cover-block" }, modes, stage, hint);
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

// --- shared audio bar (single player for song + year) ------------------------

function renderAudioBar(track) {
  if (!handle.ctx.player.isPremium()) {
    return ui.el("div", {
      class: "round__audio-note muted-note",
      text: "El audio necesita Spotify Premium.",
    });
  }
  const st = { playing: false, primed: false, taps: 1, targetMs: 100, priming: null };
  st.priming = handle.ctx.player.prime(track.uri);
  st.priming.then((ok) => { st.primed = ok; });
  return clipBlock(track, st);
}

// Reused verbatim: prime, in-flight prime guard, ctx.player.playClip, progress.
function clipBlock(track, st) {
  const { ctx } = handle;
  const fill = ui.el("div", { class: "clip__fill" });
  const bar = ui.el("div", { class: "clip__bar", "aria-hidden": "true" }, fill);
  const label = ui.el("span", { class: "clip__label display--num", text: ui.formatMs(st.targetMs) });

  const playBtn = ui.el("button", {
    class: "btn btn--primary",
    text: "Reproducir",
    on: {
      click: async () => {
        if (st.playing) return;
        if (!st.primed && st.priming) await st.priming;
        if (!st.primed) {
          st.priming = ctx.player.prime(track.uri);
          st.primed = await st.priming;
        }
        if (!st.primed) {
          ui.toast("El reproductor todavía no está listo. Probá de nuevo.", "error");
          return;
        }
        st.playing = true;
        fill.style.transition = `width ${st.targetMs}ms linear`;
        fill.style.width = "100%";
        ctx.player.playClip(st.targetMs, {
          onEnd: () => {
            st.playing = false;
            fill.style.transition = "width 120ms ease-out";
            fill.style.width = "0%";
          },
        });
      },
    },
  });

  const addBtn = ui.el("button", {
    class: "btn btn--ghost",
    text: "+0,1 s",
    on: {
      click: () => {
        st.taps += 1;
        st.targetMs = 100 * st.taps;
        label.textContent = ui.formatMs(st.targetMs);
      },
    },
  });

  return ui.el("div", { class: "stack" },
    ui.el("div", { class: "clip" }, bar, label),
    ui.el("div", { class: "clip__actions" }, playBtn, addBtn),
  );
}

// --- card shell -------------------------------------------------------------

function makeCard(id) {
  const chip = ui.el("span", { class: "chip chip--muted", hidden: true });
  handle.cardChips[id] = chip;
  const head = ui.el("div", { class: "card__head" },
    ui.el("h2", { class: "display display--md", text: CARD_TITLES[id] }),
    chip,
  );
  const body = ui.el("div", { class: "stack" });
  const cardEl = ui.el("div", { class: "card stack" }, head, body);
  return { cardEl, body };
}

// --- card: La canción (title only, Premium) ---------------------------------

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

  const input = ui.el("input", {
    class: "guess__input", type: "text", placeholder: "Escribe el título",
    "aria-label": "Adivina el título", autocomplete: "off",
  });
  const group = ui.el("div", { class: "guess" }, input);

  const evaluate = () => {
    const v = input.value;
    if (!v.trim()) { group.classList.remove("guess--correct", "guess--incorrect"); return; }
    if (match.matchTitle(v, track.name)) {
      input.disabled = true;
      input.value = track.name;
      group.classList.remove("guess--incorrect");
      group.classList.add("guess--correct");
      announce(`Título correcto: ${track.name}`);
      setCardState(id, "solved");
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

  handle.cardReveal[id] = () => {
    input.disabled = true;
    input.value = track.name;
    group.classList.add("guess--correct");
    setCardState(id, "revealed");
  };

  body.append(
    ui.el("p", { class: "guess-panel__title", text: "Adivina el título" }),
    group,
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
  const album = track.album;
  const myRound = handle.round;
  const st = {
    albumCorrect: false,
    artistSolved: (album?.artists?.length ?? 0) === 0,
  };
  const auto = createAutoGuess();
  handle.autos.push(auto);

  const albumArtistSet = new Set((album?.artists ?? []).map((a) => a.id ?? a.name));
  const isAlbumArtist = (a) => albumArtistSet.has(a.id ?? a.name);

  // Tracklist game state — the grid is always visible; rows are state-driven so
  // the album-artist-solve re-render stays lossless (no typed text is dropped).
  const ac = {
    tracks: null,
    tracklistLoaded: false,
    loadError: false,
    rowState: [],
    rowEls: [],
  };

  const albumInput = ui.el("input", {
    class: "guess__input", type: "text", placeholder: "Escribe el álbum",
    "aria-label": "Adivina el álbum", autocomplete: "off", disabled: st.albumCorrect,
  });
  const albumGroup = ui.el("div", { class: "guess" }, albumInput);
  const solvedBanner = ui.el("div", { class: "solved-banner", hidden: true },
    ui.icon("check"), ui.el("span", { text: "¡Correcto! Álbum resuelto." }));
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

  const evaluateAlbum = () => {
    const v = albumInput.value;
    if (!v.trim()) { albumGroup.classList.remove("guess--correct", "guess--incorrect"); return; }
    if (match.matchAlbum(v, album.name)) {
      st.albumCorrect = true;
      albumInput.disabled = true;
      albumInput.value = album.name;
      albumGroup.classList.remove("guess--incorrect");
      albumGroup.classList.add("guess--correct");
      announce(`Álbum correcto: ${album.name}`);
      checkSolved();
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
    if (result.solved) {
      announce("Artistas del álbum correctos");
      renderAlbumTracklistGrid();
      checkSolved();
    }
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
    ac.rowState = tracks.map((t) => ({
      songText: "",
      songLocked: false,
      artistVals: (t.artists ?? []).map(() => ""),
      artistLocked: (t.artists ?? []).map(() => false),
      // No credited artists to solve → the row's artist part is already done.
      artistSolved: (t.artists ?? []).length === 0,
    }));
    renderAlbumTracklistGrid();
    updateTracklistChip();
  }

  function renderAlbumTracklistGrid() {
    if (!ac.tracklistLoaded) return;
    auto.clearAll(); // drop timers for inputs about to be detached
    tracklistBox.innerHTML = "";
    const grid = ui.el("div", { class: "album-tracks" });
    ac.rowEls = [];
    for (let i = 0; i < ac.tracks.length; i++) grid.append(buildTrackRow(i));
    tracklistBox.append(grid);
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
      // Album artists are known for free ONLY once the album-artist slots are
      // solved; otherwise they stay as guessable inputs like any other credit.
      if (isAlbumArtist(a) && st.artistSolved) {
        artistWrap.append(ui.el("span", { class: "chip chip--ok" },
          ui.el("span", { class: "dot" }),
          ui.el("span", { text: a.name })));
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

    ac.rowEls[i] = { songInput, songGroup, artistInputs, artistGroups, remIdx };
    return ui.el("div", { class: "album-track" }, num, main);
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
      rs.songLocked = true;
      rs.songText = ac.tracks[i].name;
      els.songInput.disabled = true;
      els.songInput.value = ac.tracks[i].name;
      els.songGroup.classList.remove("guess--incorrect");
      els.songGroup.classList.add("guess--correct");
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
  }

  function updateTracklistChip() {
    if (!ac.tracklistLoaded) return;
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

  async function revealAlbumTracklistAll() {
    if (!ac.tracklistLoaded) {
      try {
        const tracks = await handle.ctx.library.getAlbumTracklist(album.id);
        if (handle.round === myRound) {
          ac.tracks = tracks;
          ac.tracklistLoaded = true;
          ac.rowState = tracks.map((t) => ({
            songText: "",
            songLocked: false,
            artistVals: (t.artists ?? []).map(() => ""),
            artistLocked: (t.artists ?? []).map(() => false),
            artistSolved: (t.artists ?? []).length === 0,
          }));
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
    revealCoverFull();
    revealAlbumTracklistAll();
    setCardState(id, "revealed");
  };

  body.append(
    ui.el("p", { class: "guess-panel__title", text: "Adivina el álbum" }),
    albumGroup,
    ...((album.artists?.length ?? 0) > 0
      ? [ui.el("p", { class: "guess-panel__title", text: "Adivina el artista" }), ...slotGroups]
      : []),
    solvedBanner,
    ui.el("p", { class: "guess-panel__title", text: "O en cualquier orden" }),
    freeGroup,
    freeNote,
    tracklistBox,
  );

  loadAlbumTracklist();
  return cardEl;
}

// --- card: ¿De qué año? (Premium) -------------------------------------------

function yearOf(track) {
  const raw = track.album?.release_date ?? "";
  const year = Number.parseInt(raw.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

function renderYearCard(track, premium) {
  const id = "year";
  const { cardEl, body } = makeCard(id);
  if (!premium) {
    body.append(ui.el("p", { class: "muted-note", text: "Requiere Spotify Premium." }));
    const chip = handle.cardChips[id];
    chip.hidden = false;
    chip.textContent = "Requiere Premium";
    chip.className = "chip chip--muted";
    return cardEl;
  }

  const year = yearOf(track);
  if (year == null) {
    body.append(ui.el("p", { class: "muted-note", text: "Esta canción no tiene año de lanzamiento registrado." }));
    handle.cardReveal[id] = () => setCardState(id, "revealed");
    return cardEl;
  }

  const auto = createAutoGuess();
  handle.autos.push(auto);
  const st = { year, solved: false };

  const solvedBanner = ui.el("div", { class: "solved-banner", hidden: true },
    ui.icon("check"), ui.el("span", { text: `¡Correcto! ${year}.` }));
  const hintArrow = ui.el("span", { class: "hint-arrow" });
  const hintClose = ui.el("span", { class: "muted-note" });
  const hintRow = ui.el("div", { class: "hint-row", hidden: true }, hintArrow, hintClose);
  const answerRow = ui.el("p", { class: "muted-note", hidden: true });

  const input = ui.el("input", {
    class: "guess__input", type: "number", inputmode: "numeric", min: "1950", max: "2035",
    placeholder: "Año", "aria-label": "Adivina el año", disabled: st.solved,
  });
  const group = ui.el("div", { class: "guess" }, input);

  const evaluate = () => {
    const digits = input.value.replace(/\D/g, "");
    if (st.solved || digits.length !== 4) return;
    const guess = Number.parseInt(digits, 10);
    const hint = match.yearHint(guess, year);
    hintRow.hidden = false;
    if (hint.direction === "equal") {
      hintArrow.textContent = "¡Correcto!";
      hintClose.textContent = "";
      st.solved = true;
      input.disabled = true;
      solvedBanner.hidden = false;
      answerRow.hidden = false;
      answerRow.textContent = `${artistString(track)} · ${track.album.name} · ${year}`;
      announce(`¡Correcto! El año es ${year}`);
      setCardState(id, "solved");
    } else {
      hintArrow.textContent = DIRECTION_COPY[hint.direction];
      hintClose.textContent = CLOSENESS_COPY[hint.closeness];
      announce(`${DIRECTION_COPY[hint.direction]}, ${CLOSENESS_COPY[hint.closeness]}`);
    }
  };
  input.addEventListener("input", () => { hintRow.hidden = true; });
  const shouldInstant = () => {
    const digits = input.value.replace(/\D/g, "");
    return digits.length === 4 && Number.parseInt(digits, 10) === year;
  };
  auto.bind(group, input, shouldInstant, evaluate);

  handle.cardReveal[id] = () => {
    st.solved = true;
    input.disabled = true;
    input.value = String(year);
    solvedBanner.hidden = false;
    hintRow.hidden = true;
    answerRow.hidden = false;
    answerRow.textContent = `${artistString(track)} · ${track.album.name} · ${year}`;
    setCardState(id, "revealed");
  };

  body.append(
    ui.el("p", { class: "guess-panel__title", text: "Adivina el año" }),
    group,
    hintRow,
    solvedBanner,
    answerRow,
  );
  return cardEl;
}

function artistString(track) {
  return (track.artists ?? []).map((a) => (typeof a === "string" ? a : a.name)).join(", ");
}

// --- card: La letra (ported verbatim behavior) ------------------------------

function renderLyricsCard(track) {
  const id = "lyrics";
  const { cardEl, body } = makeCard(id);
  const st = { engine: null, wordEls: [], done: false, lastCursor: null, forceReveal: false };
  const round = handle.round;

  const helpLine = ui.el("p", { class: "muted-note lyrics__help", text: "Espacio coloca la palabra en el cursor; Enter busca esa palabra en toda la letra." });
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
      const res = st.engine.revealAnywhere(tok);
      if (res.ok) { applyResult(res); input.value = ""; }
      else {
        const norm = match.normalize(tok);
        ui.toast(st.engine.discoveredWords().includes(norm) ? "Esa palabra ya está descubierta" : "No encontré esa palabra acá", "info");
        input.value = "";
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
    input.focus();
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

function renderFooter() {
  return ui.el("div", { class: "round__footer" },
    ui.el("button", {
      class: "btn btn--primary",
      text: "Otra canción",
      on: { click: () => drawRound(handle.view, handle.live) },
    }),
    ui.el("button", {
      class: "btn btn--ghost",
      text: "Ver respuestas",
      on: { click: () => revealAll() },
    }),
    ui.el("a", { class: "ghost-link", href: "#/juegos", text: "Volver a Juegos" }),
  );
}

function revealAll() {
  revealCoverFull();
  for (const id of ["song", "album", "year", "lyrics"]) {
    const fn = handle.cardReveal[id];
    if (fn) fn();
  }
}

function announce(msg) {
  if (handle.live) handle.live.textContent = msg;
}
