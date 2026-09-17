// Game 2 — blurred album cover: 6 blur steps (30→0px), album + artist guess,
// full tracklist reveal with featured artists and library-membership marks
// (games spec: Game 2). Metadata only — works on Free accounts.

import * as ui from "../ui.js";
import * as match from "../match.js";
import { isStaleCover } from "../storage.js";
import { createAutoGuess } from "../guess-auto.js";

const BLUR_STEPS = [30, 24, 18, 12, 6, 0]; // px, per step click

let handle = null;
const auto = createAutoGuess();

export function mount(container, ctx) {
  handle = { container, ctx };
  render();
}

export function unmount() {
  auto.clearAll();
  handle = null;
}

// ---------------------------------------------------------------------------

function render() {
  const { container, ctx } = handle;
  container.innerHTML = "";

  if (ctx.library.getAlbums().length === 0) {
    container.append(ui.emptyGuide({
      body: "Añade canciones a «Lo que sé» para jugar a las portadas.",
      actionLabel: "Ir a la biblioteca",
      onAction: () => ctx.navigate("#/library"),
    }));
    return;
  }

  const view = ui.el("section", { class: "view stack--lg" });
  const live = ui.liveRegion();
  view.append(live);
  container.append(view);
  drawAlbum(view, live);
}

function drawAlbum(view, live) {
  // A pending timer must never act on a detached previous round.
  auto.clearAll();
  const { ctx } = handle;

  const album = ctx.library.getRandomAlbum();
  const round = {
    album,
    step: 0,
    albumCorrect: false,
    // With no credited artists there is nothing to solve for the artist block.
    artistSolved: album.artists.length === 0,
    tracklist: null,
    coverRetries: 0,
  };
  handle.round = round;

  const card = ui.el("div", { class: "card stack--lg" });
  card.append(coverBlock(round, live));
  card.append(guessBlock(round, live));

  // Cover freshness: re-fetch when stale (perishable covers, design D6).
  if (isStaleCover(album.fetchedAt)) {
    ctx.library.refreshAlbum(album.id).then((fresh) => {
      if (fresh) {
        const img = handle.container.querySelector(".cover--game2");
        if (img && fresh.images?.[0]?.url) img.src = fresh.images[0].url;
      }
    });
  }

  view.replaceChildren(live, card);
}

function uiStale(album) {
  return isStaleCover(album.fetchedAt);
}

// --- cover with blur steps -----------------------------------------------------

function coverBlock(round, live) {
  const { ctx } = handle;
  const album = round.album;
  const url = album.images?.[0]?.url;
  const box = ui.el("div", { class: "cover-wrap stack" });

  let coverEl;
  if (url) {
    coverEl = ui.el("img", {
      class: `cover cover--game2 cover--blur-${round.step}`,
      alt: `Portada borrosa de ${album.name}`,
      loading: "lazy",
      on: {
        error: () => {
          if (round.coverRetries >= 1) return;
          round.coverRetries += 1;
          ctx.library.refreshAlbum(album.id).then((fresh) => {
            const freshUrl = fresh?.images?.[0]?.url;
            if (freshUrl) coverEl.src = freshUrl;
          });
        },
      },
    });
    coverEl.src = url;
  } else {
    coverEl = ui.el("div", { class: "cover-placeholder cover--game2" }, ui.icon("cover"));
  }
  box.append(coverEl);

  // Click to focus: one blur step per click (the mechanic is the reveal).
  const focusBtn = ui.el("button", {
    class: "cover-focus",
    "aria-label": "Enfocar portada",
    on: {
      click: () => {
        if (round.step >= BLUR_STEPS.length - 1) return;
        round.step += 1;
        const img = box.querySelector(".cover--game2");
        if (img) img.className = `cover cover--game2 cover--blur-${round.step}`;
        announce(live, `Portada más enfocada, paso ${round.step} de 5`);
      },
    },
  },
    ui.el("span", { class: "cover-focus__chip", text: "Clic para enfocar" }),
  );
  box.append(focusBtn);

  return ui.el("div", { class: "stack" },
    ui.el("h2", { class: "display display--md", text: "¿De qué álbum es?" }),
    box,
  );
}

// --- guesses + tracklist ---------------------------------------------------------

function guessBlock(round, live) {
  const { ctx } = handle;
  const album = round.album;

  const solvedBanner = ui.el("div", { class: "solved-banner", hidden: true },
    ui.icon("check"),
    ui.el("span", { text: "¡Correcto! Álbum resuelto." }),
  );

  const checkSolved = () => {
    if (round.albumCorrect && round.artistSolved) {
      solvedBanner.hidden = false;
      revealTracklist(round, live);
    }
  };

  // --- album name guess ---
  const albumInput = ui.el("input", {
    class: "guess__input",
    type: "text",
    placeholder: "Escribe el álbum",
    "aria-label": "Adivina el álbum",
    autocomplete: "off",
    disabled: round.albumCorrect,
  });
  if (round.albumCorrect) albumInput.value = album.name;
  const albumGroup = ui.el("div", { class: "guess" }, albumInput);
  if (round.albumCorrect) albumGroup.classList.add("guess--correct");

  const evaluateAlbum = () => {
    const value = albumInput.value;
    if (!value.trim()) {
      // Neutral: no announcement, leave the field editable.
      albumGroup.classList.remove("guess--correct", "guess--incorrect");
      return;
    }
    if (match.matchAlbum(value, album.name)) {
      round.albumCorrect = true;
      albumInput.disabled = true;
      albumInput.value = album.name;
      albumGroup.classList.remove("guess--incorrect");
      albumGroup.classList.add("guess--correct");
      announce(live, "Álbum correcto");
      unblur(round);
      checkSolved();
    } else {
      albumGroup.classList.remove("guess--correct");
      albumGroup.classList.add("guess--incorrect");
      announce(live, "Álbum incorrecto, prueba de nuevo");
    }
  };

  const albumInstant = () =>
    match.normalize(albumInput.value) === match.normalize(album.name) ||
    match.normalize(albumInput.value) === match.normalize(match.stripAliases(album.name));
  auto.bind(albumGroup, albumInput, albumInstant, evaluateAlbum);

  // --- owner artist slots ---
  const artistNames = album.artists.map((a) => (typeof a === "string" ? a : (a.name ?? "")));
  const slotInputs = [];
  let slotGroups = [];

  const evaluateArtists = () => {
    const focusedInput = document.activeElement;
    const focusPrev =
      focusedInput && slotInputs.includes(focusedInput) ? focusedInput.value : null;

    const values = slotInputs.map((i) => i.value);
    const result = match.assignArtistSlots(values, album.artists);

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
      announce(live, "Artistas del álbum correctos");
      unblur(round);
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

  slotGroups = album.artists.map((artist) => {
    const input = ui.el("input", {
      class: "guess__input",
      type: "text",
      placeholder: "Escribe un artista",
      "aria-label": "Adivina el artista del álbum",
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

  // --- tracklist (revealed on solve) ---
  const tracklistBox = ui.el("div", { class: "stack", hidden: true });

  const nextBtn = ui.el("button", {
    class: "btn btn--primary",
    text: "Siguiente álbum",
    on: {
      click: () => {
        drawAlbum(handle.container.querySelector(".view"), live);
      },
    },
  });

  const panelChildren = [
    ui.el("p", { class: "guess-panel__title", text: "Adivina el álbum" }),
    albumGroup,
  ];
  if (album.artists.length > 0) {
    panelChildren.push(
      ui.el("p", { class: "guess-panel__title", text: "Adivina el artista" }),
      ...slotGroups,
    );
  }
  panelChildren.push(solvedBanner, tracklistBox, nextBtn);

  return ui.el("div", { class: "guess-panel" }, ...panelChildren);
}

function unblur(round) {
  if (!round.albumCorrect || !round.artistSolved) return;
  const img = handle.container.querySelector(".cover--game2");
  if (img) img.className = "cover cover--game2 cover--blur-5";
  announce(handle.container.querySelector(".live-region"), "Portada revelada");
}

// --- tracklist reveal -------------------------------------------------------------

async function revealTracklist(round, live) {
  const { ctx } = handle;
  const album = round.album;
  const box = handle.container.querySelector(".guess-panel .stack[hidden]");
  if (!box || round.tracklist) return;
  box.hidden = false;
  box.append(ui.skeleton(4));

  let tracks;
  try {
    tracks = await ctx.library.getAlbumTracklist(album.id);
  } catch {
    box.innerHTML = "";
    box.append(ui.el("div", { class: "banner banner--error" },
      ui.icon("warn"),
      ui.el("span", { text: "No se pudo cargar la lista de temas. " }),
      ui.el("button", {
        class: "btn btn--sm",
        text: "Reintentar",
        on: { click: () => revealTracklist(round, live) },
      }),
    ));
    return;
  }
  round.tracklist = tracks;
  box.innerHTML = "";
  box.append(tracklistElement(tracks, album));
  announce(live, `${tracks.length} temas revelados`);
}

function tracklistElement(tracks, album) {
  const { ctx } = handle;
  const albumArtistIds = new Set((album.artists ?? []).map((a) => a.id));
  const list = ui.el("ul", { class: "tracklist" });

  for (const track of tracks) {
    // Featured artists = track artists − album artists, compared by artist.id.
    const featured = (track.artists ?? []).filter((a) => !albumArtistIds.has(a.id));
    const featuredText =
      featured.length > 0 ? `feat. ${featured.map((a) => a.name).join(", ")}` : "";
    const inLibrary = ctx.library.isInPool(track.id);

    list.append(ui.el("li", { class: "tracklist__row" },
      ui.el("span", { class: "tracklist__num", text: String(track.track_number ?? "") }),
      ui.el("div", { class: "stack", style: "gap:2px" },
        ui.el("span", { class: "tracklist__name", text: track.name }),
        featuredText
          ? ui.el("span", { class: "tracklist__featured", text: featuredText })
          : null,
      ),
      ui.el("span", { class: `chip ${inLibrary ? "chip--ok" : "chip--muted"}` },
        ui.el("span", { class: "dot" }),
        ui.el("span", { text: inLibrary ? "en tu biblioteca" : "no está" }),
      ),
    ));
  }
  return list;
}

// --- helpers ----------------------------------------------------------------------

function announce(live, msg) {
  if (live) live.textContent = msg;
}
