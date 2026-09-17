// Game 3 — release year: same clip mechanic plus a year guess with
// older/newer direction and close/far distance hints (games spec: Game 3).

import * as ui from "../ui.js";
import * as match from "../match.js";
import { createAutoGuess } from "../guess-auto.js";

const DIRECTION_COPY = { newer: "Más nuevo", older: "Más viejo", equal: "¡Correcto!" };
const CLOSENESS_COPY = { "very-close": "Muy cerca", close: "Cerca", far: "Lejos" };

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
      body: "Añade canciones a «Lo que sé» para jugar al año.",
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

function yearOf(track) {
  const raw = track.album?.release_date ?? "";
  const year = Number.parseInt(raw.slice(0, 4), 10);
  return Number.isNaN(year) ? null : year;
}

function drawRound(view, live) {
  // A pending timer must never act on a detached previous round.
  auto.clearAll();
  const { ctx } = handle;

  let track = ctx.library.getRandomTrack();
  // Tracks without a usable release year are skipped (draw again, bounded).
  for (let guard = 0; guard < 20 && yearOf(track) === null; guard++) {
    track = ctx.library.getRandomTrack();
  }
  const year = yearOf(track);

  if (year === null) {
    // No pool track carries a usable release date — never crash, show a way out.
    view.replaceChildren(live, ui.el("div", { class: "card stack" },
      ui.el("p", { text: "Ninguna canción de tu biblioteca tiene año de lanzamiento." }),
      ui.el("button", {
        class: "btn btn--ghost",
        text: "Siguiente",
        on: { click: () => drawRound(view, live) },
      }),
    ));
    return;
  }

  const round = {
    track,
    year,
    taps: 1,
    targetMs: 100,
    solved: false,
    playing: false,
    primed: false,
  };
  handle.round = round;

  // Keep the prime promise: Play may be clicked before priming finishes.
  round.priming = ctx.player.prime(track.uri);
  round.priming.then((ok) => {
    round.primed = ok;
  });

  const card = ui.el("div", { class: "card stack--lg" });
  card.append(clipBlock(round, live));
  card.append(yearBlock(round, live));
  view.replaceChildren(live, card);
}

// --- clip block (same mechanic as Game 1) -------------------------------------

function clipBlock(round, live) {
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

  return ui.el("div", { class: "stack" },
    ui.el("h2", { class: "display display--md", text: "¿De qué año es?" }),
    ui.el("div", { class: "clip" }, bar, label),
    ui.el("div", { class: "clip__actions" }, playBtn, addBtn, nextBtn),
  );
}

// --- year guess -----------------------------------------------------------------

function yearBlock(round, live) {
  const solvedBanner = ui.el("div", { class: "solved-banner", hidden: true },
    ui.icon("check"),
    ui.el("span", { text: `¡Correcto! ${round.year}.` }),
  );
  const hintArrow = ui.el("span", { class: "hint-arrow" });
  const hintClose = ui.el("span", { class: "muted-note" });
  const hintRow = ui.el("div", { class: "hint-row", hidden: true }, hintArrow, hintClose);

  const input = ui.el("input", {
    class: "guess__input",
    type: "number",
    inputmode: "numeric",
    min: "1950",
    max: "2035",
    placeholder: "Año",
    "aria-label": "Adivina el año",
    disabled: round.solved,
  });
  const group = ui.el("div", { class: "guess" }, input);

  // A partial number (1–3 digits) is not a submitted guess: never show a hint
  // for it, and hide the previous hint while the user is still editing.
  const evaluate = () => {
    const digits = input.value.replace(/\D/g, "");
    if (round.solved || digits.length !== 4) return; // no hint, no timer leftovers
    const guess = Number.parseInt(digits, 10);
    const hint = match.yearHint(guess, round.year);
    hintRow.hidden = false;
    if (hint.direction === "equal") {
      hintArrow.textContent = "¡Correcto!";
      hintClose.textContent = "";
      round.solved = true;
      input.disabled = true;
      solvedBanner.hidden = false;
      revealInfo(round);
      announce(live, `¡Correcto! El año es ${round.year}`);
    } else {
      hintArrow.textContent = DIRECTION_COPY[hint.direction];
      hintClose.textContent = CLOSENESS_COPY[hint.closeness];
      announce(live, `${DIRECTION_COPY[hint.direction]}, ${CLOSENESS_COPY[hint.closeness]}`);
    }
  };

  // Hide the stale hint from the previous guess before the binder handles this
  // input (registered first so the binder's evaluate can re-show a fresh one).
  input.addEventListener("input", () => {
    hintRow.hidden = true;
  });

  const shouldInstant = () => {
    const digits = input.value.replace(/\D/g, "");
    return digits.length === 4 && Number.parseInt(digits, 10) === round.year;
  };

  auto.bind(group, input, shouldInstant, evaluate);

  return ui.el("div", { class: "guess-panel" },
    ui.el("p", { class: "guess-panel__title", text: "Adivina el año" }),
    group,
    hintRow,
    solvedBanner,
  );
}

function revealInfo(round) {
  // After a solve, show what was playing: title + album + cover.
  const track = round.track;
  const card = ui.el("div", { class: "card stack" });
  const url = track.album.images?.[0]?.url;
  if (url) {
    card.append(ui.el("img", {
      class: "cover cover--revealed",
      style: "max-width:180px",
      alt: `Portada de ${track.album.name}`,
      src: url,
    }));
  }
  card.append(
    ui.el("h3", { class: "display display--md", text: track.name }),
    ui.el("p", { class: "muted-note", text: `${track.artists.map((a) => a.name).join(", ")} · ${track.album.name} · ${round.year}` }),
  );
  handle.container.querySelector(".view").append(card);
}

function announce(live, msg) {
  if (live) live.textContent = msg;
}