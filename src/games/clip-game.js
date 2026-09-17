// Game 1 — clip guessing: title + all artist slots + album, cover revealed
// on album solve (games spec: Game 1, playback spec: clip control).

import * as ui from "../ui.js";
import * as match from "../match.js";
import { isStaleCover } from "../storage.js";
import { createAutoGuess } from "../guess-auto.js";

let handle = null;
const auto = createAutoGuess();

export function mount(container, ctx) {
  handle = { container, ctx };
  render();
}

export function unmount() {
  auto.clearAll();
  if (handle?.ctx) handle.ctx.player.stop();
  handle = null;
}

// ---------------------------------------------------------------------------

function render() {
  const { container, ctx } = handle;
  container.innerHTML = "";

  if (!ctx.player.isPremium()) {
    container.append(ui.premiumGate({ onBack: () => ctx.navigate("#/juegos") }));
    return;
  }

  if (ctx.library.getPoolTracks().length === 0) {
    container.append(ui.emptyGuide({
      body: "Añade canciones a «Lo que sé» para jugar al clip.",
      actionLabel: "Ir a la biblioteca",
      onAction: () => ctx.navigate("#/library"),
    }));
    return;
  }

  const view = ui.el("section", { class: "view stack--lg" });
  const live = ui.liveRegion();
  view.append(live);
  container.append(view);
  drawRound(view, live);
}

/** Pick a track, prime it, and rebuild the round UI. */
function drawRound(view, live) {
  // A pending timer must never act on a detached previous round.
  auto.clearAll();
  const { ctx } = handle;

  const track = ctx.library.getRandomTrack();
  const round = {
    track,
    taps: 1,
    targetMs: 100,
    titleCorrect: false,
    albumCorrect: false,
    artistSolved: track.artists.length === 0,
    playing: false,
    primed: false,
    coverRevealed: false,
    coverRetries: 0,
  };
  handle.round = round;

  // Keep the prime promise: Play may be clicked before priming finishes.
  round.priming = ctx.player.prime(round.track.uri);
  round.priming.then((ok) => {
    round.primed = ok;
  });

  view.replaceChildren(live, roundPanel(round, live));
}

// --- panels -------------------------------------------------------------------

function roundPanel(round, live) {
  const panel = ui.el("div", { class: "stack--lg" });
  panel.append(clipCard(round, live));
  panel.append(guessCard(round, live));
  return panel;
}

function clipCard(round, live) {
  const { ctx } = handle;
  const fill = ui.el("div", { class: "clip__fill" });
  const bar = ui.el("div", { class: "clip__bar", "aria-hidden": "true" }, fill);
  const label = ui.el("span", {
    class: "clip__label display--num",
    text: ui.formatMs(round.targetMs),
  });

  const playBtn = ui.el("button", {
    class: "btn btn--primary",
    text: "Reproducir",
    on: {
      click: async () => {
        if (round.playing) return;
        // Prime race: wait for an in-flight prime instead of dropping the tap.
        if (!round.primed && round.priming) {
          await round.priming;
        }
        if (!round.primed) {
          // Play must never stay dead: retry once with a fresh prime.
          round.priming = ctx.player.prime(round.track.uri);
          round.primed = await round.priming;
        }
        if (!round.primed) {
          ui.toast("El reproductor todavía no está listo. Probá de nuevo.", "error");
          return;
        }
        round.playing = true;
        fill.style.transition = `width ${round.targetMs}ms linear`;
        fill.style.width = "100%";
        ctx.player.playClip(round.targetMs, {
          onEnd: () => {
            round.playing = false;
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
        round.taps += 1;
        round.targetMs = 100 * round.taps;
        label.textContent = ui.formatMs(round.targetMs);
      },
    },
  });

  const nextBtn = ui.el("button", {
    class: "btn btn--ghost",
    text: "Siguiente",
    on: {
      click: () => {
        ctx.player.stop();
        drawRound(handle.container.querySelector(".view"), live);
      },
    },
  });

  return ui.el("div", { class: "card stack" },
    ui.el("div", { class: "clip" }, bar, label),
    ui.el("div", { class: "clip__actions" }, playBtn, addBtn, nextBtn),
  );
}

function guessCard(round, live) {
  const { ctx } = handle;
  const track = round.track;

  const solvedBanner = ui.el("div", { class: "solved-banner", hidden: true },
    ui.icon("check"),
    ui.el("span", { text: "¡Correcto! Resuelta." }),
  );

  const checkSolved = () => {
    if (round.titleCorrect && round.albumCorrect && round.artistSolved) {
      solvedBanner.hidden = false;
      announce(live, "¡Correcto! Resuelta");
    }
  };

  // --- title ---
  const titleInput = ui.el("input", {
    class: "guess__input",
    type: "text",
    placeholder: "Escribe el título",
    "aria-label": "Adivina el título",
    autocomplete: "off",
    disabled: round.titleCorrect,
  });
  if (round.titleCorrect) titleInput.value = track.name;
  const titleGroup = ui.el("div", { class: "guess" }, titleInput);
  if (round.titleCorrect) titleGroup.classList.add("guess--correct");

  const evaluateTitle = () => {
    const value = titleInput.value;
    if (!value.trim()) {
      // Neutral: no announcement, leave the field editable.
      titleGroup.classList.remove("guess--correct", "guess--incorrect");
      return;
    }
    if (match.matchTitle(value, track.name)) {
      round.titleCorrect = true;
      titleInput.disabled = true;
      titleInput.value = track.name;
      titleGroup.classList.remove("guess--incorrect");
      titleGroup.classList.add("guess--correct");
      announce(live, "Título correcto");
      checkSolved();
    } else {
      titleGroup.classList.remove("guess--correct");
      titleGroup.classList.add("guess--incorrect");
      announce(live, "Título incorrecto, prueba de nuevo");
    }
  };

  const titleInstant = () =>
    match.normalize(titleInput.value) === match.normalize(track.name) ||
    match.normalize(titleInput.value) === match.normalize(match.stripAliases(track.name));
  auto.bind(titleGroup, titleInput, titleInstant, evaluateTitle);

  // --- artist slots (one per credited artist, order-free, relocated on solve) ---
  const artistNames = track.artists.map((a) => (typeof a === "string" ? a : (a.name ?? "")));
  const slotInputs = [];
  let slotGroups = [];

  const evaluateArtists = () => {
    const focusedInput = document.activeElement;
    const focusPrev =
      focusedInput && slotInputs.includes(focusedInput) ? focusedInput.value : null;

    const values = slotInputs.map((i) => i.value);
    const result = match.assignArtistSlots(values, track.artists);

    const lockedBefore = slotInputs.filter((i) => i.disabled).length;

    slotInputs.forEach((input, j) => {
      const group = slotGroups[j];
      const val = result.values[j];
      const isLocked = result.locked[j];
      group.classList.remove("guess--correct", "guess--incorrect");
      if (isLocked) {
        input.disabled = true;
        if (input.value !== val) input.value = val; // canonical name
        group.classList.add("guess--correct");
      } else if (val !== "") {
        // Non-matching text: red, stays editable.
        group.classList.add("guess--incorrect");
      } else if (input.value !== "") {
        // Neutral: clear only when it actually differs (never clobber a
        // focused field whose value is unchanged).
        input.value = "";
      }
    });

    round.artistSolved = result.solved;
    if (result.solved) {
      announce(live, "Todos los artistas correctos");
      checkSolved();
      return;
    }

    const lockedAfter = slotInputs.filter((i) => i.disabled).length;
    const newLock = lockedAfter > lockedBefore;
    const hasWrong = result.values.some((v, j) => v !== "" && !result.locked[j]);

    if (newLock) {
      announce(live, "Artista correcto");
    } else if (hasWrong) {
      announce(live, "Artista incorrecto, prueba de nuevo");
    }

    // Focus preservation: when the focused field was locked or its text moved
    // away, keep keyboard flow alive by jumping to the first enabled empty slot.
    if (focusedInput && slotInputs.includes(focusedInput)) {
      const movedAway =
        focusedInput.disabled ||
        (focusPrev !== null && focusPrev !== "" && focusedInput.value === "");
      if (movedAway) {
        const next = slotInputs.find((i) => !i.disabled && i.value === "");
        if (next && next !== focusedInput) next.focus();
      }
    }
  };

  slotGroups = track.artists.map((artist) => {
    const input = ui.el("input", {
      class: "guess__input",
      type: "text",
      placeholder: "Escribe un artista",
      "aria-label": "Adivina el artista",
      autocomplete: "off",
    });
    slotInputs.push(input);
    const group = ui.el("div", { class: "guess" }, input);
    // Instant when the typed text exactly matches ANY credited artist (or its
    // alias-stripped form) — relocation to the correct slot is immediate;
    // a fuzzy (typo-tolerant) match is debounced instead.
    const instant = () =>
      artistNames.some(
        (n) =>
          match.normalize(input.value) === match.normalize(n) ||
          match.normalize(input.value) === match.normalize(match.stripAliases(n)),
      );
    auto.bind(group, input, instant, evaluateArtists);
    return group;
  });

  // --- album ---
  const albumInput = ui.el("input", {
    class: "guess__input",
    type: "text",
    placeholder: "Escribe el álbum",
    "aria-label": "Adivina el álbum",
    autocomplete: "off",
    disabled: round.albumCorrect,
  });
  if (round.albumCorrect) albumInput.value = track.album.name;
  const albumGroup = ui.el("div", { class: "guess" }, albumInput);
  if (round.albumCorrect) albumGroup.classList.add("guess--correct");

  const evaluateAlbum = () => {
    const value = albumInput.value;
    if (!value.trim()) {
      // Neutral: no announcement, leave the field editable.
      albumGroup.classList.remove("guess--correct", "guess--incorrect");
      return;
    }
    if (match.matchAlbum(value, track.album.name)) {
      round.albumCorrect = true;
      albumInput.disabled = true;
      albumInput.value = track.album.name;
      albumGroup.classList.remove("guess--incorrect");
      albumGroup.classList.add("guess--correct");
      announce(live, "Álbum correcto");
      revealCover(round, live);
      checkSolved();
    } else {
      albumGroup.classList.remove("guess--correct");
      albumGroup.classList.add("guess--incorrect");
      announce(live, "Álbum incorrecto, prueba de nuevo");
    }
  };

  const albumInstant = () =>
    match.normalize(albumInput.value) === match.normalize(track.album.name) ||
    match.normalize(albumInput.value) === match.normalize(match.stripAliases(track.album.name));
  auto.bind(albumGroup, albumInput, albumInstant, evaluateAlbum);

  // --- cover (hidden until album solved) ---
  const coverBox = coverElement(round, live);

  const panelChildren = [
    ui.el("p", { class: "guess-panel__title", text: "Adivina el título" }),
    titleGroup,
  ];
  if (track.artists.length > 0) {
    panelChildren.push(
      ui.el("p", { class: "guess-panel__title", text: "Adivina el artista" }),
      ...slotGroups,
    );
  }
  panelChildren.push(
    ui.el("p", { class: "guess-panel__title", text: "Adivina el álbum" }),
    albumGroup,
  );

  return ui.el("div", { class: "card stack" },
    ui.el("h2", { class: "display display--md", text: "¿Qué suena?" }),
    ui.el("div", { class: "guess-panel" }, ...panelChildren),
    coverBox,
    solvedBanner,
  );
}

// --- cover --------------------------------------------------------------------

function coverElement(round, live) {
  const { ctx } = handle;
  const album = round.track.album;
  const box = ui.el("div", { class: "cover-wrap stack" });
  const url = album.images?.[0]?.url;

  if (!url) {
    box.append(ui.el("div", { class: "cover-placeholder" }, ui.icon("cover")));
    return box;
  }

  const img = ui.el("img", {
    class: `cover ${round.coverRevealed ? "cover--revealed" : "cover--hidden"}`,
    // Neutral while hidden so alt text cannot spoil the answer.
    alt: round.coverRevealed ? `Portada de ${album.name}` : "Portada del álbum",
    loading: "lazy",
    on: {
      error: () => {
        if (round.coverRetries >= 1) return;
        round.coverRetries += 1;
        ctx.library.refreshAlbum(album.id).then((fresh) => {
          const freshUrl = fresh?.images?.[0]?.url;
          if (freshUrl) img.src = freshUrl;
        });
      },
    },
  });
  img.src = url;
  // Perishable covers: lazily re-fetch when the stored URL is stale (D6).
  if (isStaleCover(album.fetchedAt)) {
    ctx.library.refreshAlbum(album.id).then((fresh) => {
      const freshUrl = fresh?.images?.[0]?.url;
      if (freshUrl && !round.coverRevealed) img.src = freshUrl;
    });
  }
  box.append(img);
  return box;
}

function revealCover(round, live) {
  round.coverRevealed = true;
  const img = handle.container.querySelector(".cover--hidden");
  if (img) {
    img.alt = `Portada de ${round.track.album.name}`;
    img.classList.remove("cover--hidden");
    img.classList.add("cover--revealed");
  }
  announce(live, "Portada revelada");
}

// --- small helpers -------------------------------------------------------------

function announce(live, msg) {
  if (live) live.textContent = msg;
}