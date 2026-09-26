// Game 1 — "La primera décima": six clip steps, one accessible combobox
// guess per step, a shared game-kit clip player, scoring and reveal poster.

import * as ui from "../ui.js";
import * as scores from "../scores.js";
import { createClipPlayer } from "../clip-player.js";
import { CLIP_STEPS_MS, LISTEN_MORE_MS, pickClipStart } from "../clip-steps.js";
import {
  searchSuggestions, evaluateFreeText, isCorrectPick, eligibleTracks, artistNames,
} from "../clip-guess.js";

const GAME_ID = "clip";
const STEPS = CLIP_STEPS_MS.length;
const RESULT_DELAY_MS = 450;
const HISTORY_LIMIT = 10;

let handle = null;

export function mount(container, ctx) {
  handle = {
    container, ctx, timers: [], history: [], run: { streak: 0, points: 0 },
    clipPlayer: null, listenMore: null, offPremiumError: null,
  };
  render();
}

export function unmount() {
  if (!handle) return;
  for (const id of handle.timers) clearTimeout(id);
  handle.offPremiumError?.();
  handle.closeListbox?.();
  handle.listenMore?.stop();
  handle.clipPlayer?.destroy();
  if (handle.run.streak > 0) {
    scores.saveRun(GAME_ID, { streak: handle.run.streak, points: handle.run.points });
  }
  handle = null;
}

// ---------------------------------------------------------------------------

function render() {
  const { container, ctx } = handle;
  container.innerHTML = "";

  if (ctx.library.getPoolTracks().length === 0) {
    container.append(ui.emptyGuide({
      body: "Añade canciones a «Lo que sé» para jugar a La primera décima.",
      actionLabel: "Ir a la biblioteca",
      onAction: () => ctx.navigate("#/library"),
    }));
    return;
  }

  const live = ui.liveRegion();
  handle.live = live;

  const record = scores.getRecord(GAME_ID);
  const hud = ui.scoreHud({});
  handle.hud = hud;
  hud.update({ streak: 0, points: 0, best: record.bestStreak });

  const header = ui.el("div", { class: "game__header" },
    ui.el("h1", { class: "display display--lg", text: "La primera décima" }),
    hud.el,
  );

  const panels = ui.el("div", { class: "game__panels" });
  handle.panels = panels;

  const view = ui.el("section", { class: "view game clip-quiz" }, live, header, panels);
  container.append(view);

  // Reacts live to the same status signal ctx.player already exposes, instead
  // of trusting a one-shot isPremium() read at mount.
  handle.offPremiumError = ctx.player.onPremiumError(() => syncPremiumGate());
  syncPremiumGate();
}

/** Decides whether the panels show the game or a flat Premium gate. */
function syncPremiumGate() {
  if (!handle) return;
  if (!handle.ctx.player.isPremium()) showPremiumGate();
  else if (!handle.clipPlayer) buildGamePanels();
}

function showPremiumGate() {
  handle.listenMore?.stop();
  handle.listenMore = null;
  handle.clipPlayer?.destroy();
  handle.clipPlayer = null;
  handle.closeListbox = null;
  handle.panels.replaceChildren(
    ui.el("div", { class: "card game__gate" },
      ui.icon("warn"),
      ui.el("p", { text: "La primera décima necesita Spotify Premium para sonar. Mientras tanto puedes jugar Portada borrosa." }),
      ui.el("a", { class: "btn btn--primary", href: "#/juegos/album", text: "Jugar Portada borrosa" }),
    ),
  );
}

function buildGamePanels() {
  const { ctx } = handle;
  const skipBtn = ui.el("button", {
    class: "btn btn--ghost btn--sm",
    type: "button",
    on: { click: () => handleSkip() },
  });
  handle.skipBtn = skipBtn;

  const clipPlayer = createClipPlayer(ctx, { actions: [skipBtn] });
  handle.clipPlayer = clipPlayer;
  clipPlayer.el.classList.add("card", "clip-quiz__player");

  // Which kind of start this song got (task T2): never the exact timestamp,
  // that would give away the answer's position in the track.
  const startKind = ui.el("span", { class: "chip chip--muted clip-quiz__start-kind" });
  handle.startKind = startKind;

  const bodyHost = ui.el("div", { class: "clip-quiz__body" });
  handle.bodyHost = bodyHost;

  handle.panels.replaceChildren(startKind, clipPlayer.el, bodyHost);
  startRound();
}

function syncStartKind(fromMs) {
  const label = fromMs > 0 ? "Desde algún momento de la canción" : "Desde el principio";
  handle.startKind.textContent = label;
  return label;
}

function announce(msg) {
  if (handle.live) handle.live.textContent = msg;
}

// --- round lifecycle ---------------------------------------------------------

function startRound() {
  const { ctx } = handle;
  const pool = ctx.library.getPoolTracks();
  const candidates = eligibleTracks(pool, handle.history);
  const track = candidates[Math.floor(Math.random() * candidates.length)];

  handle.history.push(track.id);
  if (handle.history.length > HISTORY_LIMIT) handle.history.shift();

  // Decided once per song, right here when it is drawn: every step and
  // "Escuchar más" afterwards all play from this same point.
  const startMs = pickClipStart(track.duration_ms);

  handle.round = { track, step: 0, attempts: new Array(STEPS).fill(null), pool, startMs };
  handle.clipPlayer.setTrack(track, { fromMs: startMs });
  handle.clipPlayer.setStep(0);
  const startLabel = syncStartKind(startMs);
  syncSkipLabel();
  renderGuessBody();
  announce(`Nueva canción. ${startLabel}.`);
}

function syncSkipLabel() {
  const { step } = handle.round;
  const surrender = step >= STEPS - 1;
  handle.skipBtn.hidden = false;
  handle.skipBtn.textContent = surrender ? "Rendirse" : `Saltar +${ui.formatMs(CLIP_STEPS_MS[step + 1] - CLIP_STEPS_MS[step])}`;
  handle.skipBtn.setAttribute("aria-label", surrender ? "Rendirse y ver la respuesta" : "Saltar el siguiente paso del clip");
}

// --- guessing body: combobox + attempts list ----------------------------------

function renderGuessBody() {
  const round = handle.round;

  const input = ui.el("input", {
    class: "guess__input combobox__input",
    type: "text",
    role: "combobox",
    "aria-expanded": "false",
    "aria-controls": "clip-quiz-listbox",
    "aria-autocomplete": "list",
    autocomplete: "off",
    placeholder: "Escribe el título o el artista",
    "aria-label": "¿Qué canción es?",
  });
  const listbox = ui.el("ul", { class: "combobox__listbox", id: "clip-quiz-listbox", role: "listbox", hidden: true });
  const hint = ui.el("p", { class: "clip-quiz__hint small dim", hidden: true, text: "No está en «Lo que sé». Elige una canción de la lista." });

  let options = [];
  let activeIndex = -1;

  function closeListbox() {
    listbox.hidden = true;
    listbox.replaceChildren();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    options = [];
    activeIndex = -1;
  }

  function setActive(i) {
    const nodes = [...listbox.children];
    nodes.forEach((node, idx) => node.classList.toggle("combobox__option--active", idx === i));
    activeIndex = i;
    if (i >= 0 && nodes[i]) {
      input.setAttribute("aria-activedescendant", nodes[i].id);
      nodes[i].scrollIntoView({ block: "nearest" });
    } else {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function openWith(list) {
    options = list;
    activeIndex = -1;
    listbox.replaceChildren(...list.map((t, i) => optionEl(t, i)));
    listbox.hidden = list.length === 0;
    input.setAttribute("aria-expanded", String(list.length > 0));
    input.removeAttribute("aria-activedescendant");
  }

  function optionEl(t, i) {
    return ui.el("li", {
      class: "combobox__option", role: "option", id: `clip-quiz-option-${i}`,
      on: { click: () => pick(t) },
    },
      ui.el("span", { class: "combobox__option-title", text: t.name }),
      ui.el("span", { class: "combobox__option-artists", text: artistNames(t).join(", ") }),
    );
  }

  function pick(track) {
    closeListbox();
    input.value = "";
    hint.hidden = true;
    if (isCorrectPick(track, round.track)) handleCorrect();
    else handleWrong({ title: track.name, artists: artistNames(track) });
  }

  function submitFreeText() {
    const text = input.value.trim();
    if (!text) return;
    const result = evaluateFreeText(text, round.track, round.pool);
    if (result.result === "correct") {
      closeListbox();
      hint.hidden = true;
      handleCorrect();
    } else if (result.result === "wrong") {
      closeListbox();
      hint.hidden = true;
      handleWrong({ title: result.track.name, artists: artistNames(result.track) });
    } else {
      hint.hidden = false;
    }
  }

  input.addEventListener("input", () => {
    hint.hidden = true;
    const q = input.value;
    if (q.trim().length < 2) { closeListbox(); return; }
    openWith(searchSuggestions(round.pool, q, 6));
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (listbox.hidden) {
        if (input.value.trim().length >= 2) openWith(searchSuggestions(round.pool, input.value, 6));
        return;
      }
      setActive(Math.min(activeIndex + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (!listbox.hidden) setActive(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!listbox.hidden && activeIndex >= 0 && options[activeIndex]) pick(options[activeIndex]);
      else submitFreeText();
    } else if (e.key === "Escape") {
      if (!listbox.hidden) { e.preventDefault(); closeListbox(); }
    }
  });

  handle.input = input;
  handle.closeListbox = closeListbox;

  const combobox = ui.el("div", { class: "combobox" }, input, listbox);

  const rows = round.attempts.map(() => ui.el("li", { class: "clip-quiz__attempt clip-quiz__attempt--future" }));
  handle.attemptRows = rows;
  syncAttemptHighlight();
  const attempts = ui.el("ol", { class: "clip-quiz__attempts" }, ...rows);

  handle.bodyHost.replaceChildren(
    ui.el("div", { class: "card clip-quiz__guess" },
      ui.el("p", { class: "guess-panel__title", text: "¿Qué canción es?" }),
      combobox,
      hint,
      attempts,
    ),
  );
  input.focus();
}

function syncAttemptHighlight() {
  const { attempts, step } = handle.round;
  handle.attemptRows.forEach((row, i) => {
    if (attempts[i]) return;
    row.className = `clip-quiz__attempt${i === step ? " clip-quiz__attempt--current" : " clip-quiz__attempt--future"}`;
  });
}

function attemptContent(attempt) {
  if (attempt.type === "wrong") {
    return [
      ui.icon("x"),
      ui.el("span", { class: "clip-quiz__attempt-body" },
        ui.el("span", { class: "clip-quiz__attempt-title", text: attempt.title }),
        ui.el("span", { class: "clip-quiz__attempt-artists", text: attempt.artists.join(", ") }),
      ),
    ];
  }
  if (attempt.type === "skipped") return [ui.el("span", { class: "clip-quiz__attempt-title", text: "Salteada" })];
  return [ui.icon("check"), ui.el("span", { class: "clip-quiz__attempt-title", text: "¡Correcto!" })];
}

function resolveAttempt(i) {
  const attempt = handle.round.attempts[i];
  const row = handle.attemptRows[i];
  row.className = `clip-quiz__attempt clip-quiz__attempt--${attempt.type}`;
  row.replaceChildren(...attemptContent(attempt));
  ui.pop(row);
}

// --- outcomes ------------------------------------------------------------------

function handleWrong({ title, artists }) {
  const round = handle.round;
  round.attempts[round.step] = { type: "wrong", title, artists };
  resolveAttempt(round.step);
  ui.shake(handle.input);
  handle.input.value = "";
  handle.input.focus();

  if (round.step >= STEPS - 1) {
    finishAsLoss();
    return;
  }
  round.step += 1;
  handle.clipPlayer.setStep(round.step);
  syncSkipLabel();
  syncAttemptHighlight();
  announce(`Incorrecto. Ahora escuchas ${ui.formatMs(CLIP_STEPS_MS[round.step])}.`);
}

function handleSkip() {
  const round = handle.round;
  if (round.step >= STEPS - 1) {
    finishAsLoss();
    return;
  }
  round.attempts[round.step] = { type: "skipped" };
  resolveAttempt(round.step);
  round.step += 1;
  handle.clipPlayer.setStep(round.step);
  syncSkipLabel();
  syncAttemptHighlight();
  announce(`Salteado. Ahora escuchas ${ui.formatMs(CLIP_STEPS_MS[round.step])}.`);
}

function handleCorrect() {
  const round = handle.round;
  round.attempts[round.step] = { type: "correct" };
  resolveAttempt(round.step);
  handle.input.disabled = true;
  handle.skipBtn.hidden = true;

  const points = scores.pointsForStep(round.step, STEPS);
  handle.run.streak += 1;
  handle.run.points += points;
  const record = scores.getRecord(GAME_ID);
  const isRecord = handle.run.streak > record.bestStreak;
  handle.hud.update({ streak: handle.run.streak, points: handle.run.points, best: Math.max(record.bestStreak, handle.run.streak) });
  announce(`¡Correcto! Era ${round.track.name} de ${artistNames(round.track).join(", ")}. Más ${points} puntos.`);

  const id = setTimeout(() => showWin({ points, isRecord }), RESULT_DELAY_MS);
  handle.timers.push(id);
}

function finishAsLoss() {
  const round = handle.round;
  handle.input.disabled = true;
  handle.skipBtn.hidden = true;
  announce(`La respuesta era ${round.track.name} de ${artistNames(round.track).join(", ")}.`);

  const id = setTimeout(() => showLoss(), RESULT_DELAY_MS);
  handle.timers.push(id);
}

// --- result: reveal poster -----------------------------------------------------

function buildListenMore(track, fromMs) {
  const { ctx } = handle;
  let playing = false;
  const btn = ui.el("button", { class: "btn btn--ghost", type: "button", text: "Escuchar más" });
  btn.addEventListener("click", async () => {
    if (playing) { ctx.player.stop(); return; }
    if (!ctx.player.isPrimed(track.uri)) await ctx.player.prime(track.uri);
    playing = true;
    btn.textContent = "Detener";
    ctx.player.playClip(LISTEN_MORE_MS, {
      fromMs,
      onEnd: () => { playing = false; btn.textContent = "Escuchar más"; },
    });
  });
  return { el: btn, stop: () => { if (playing) ctx.player.stop(); } };
}

function showWin({ points, isRecord }) {
  const round = handle.round;
  const track = round.track;
  const album = track.album;
  handle.listenMore?.stop();
  handle.listenMore = null;

  const poster = ui.revealPoster({
    paper: "yellow",
    title: track.name,
    lines: [artistNames(track).join(", "), [album?.name, yearOf(album)].filter(Boolean).join(" · ")],
    coverUrl: album?.images?.[0]?.url,
    stamp: isRecord ? "¡Récord!" : `+${points}`,
  });

  const nextBtn = ui.el("button", {
    class: "btn btn--primary",
    type: "button",
    text: "Siguiente canción",
    on: { click: () => { handle.listenMore?.stop(); startRound(); } },
  });

  const actions = [nextBtn];
  if (handle.ctx.player.isPremium()) {
    const listenMore = buildListenMore(track, handle.clipPlayer.getOffset());
    handle.listenMore = listenMore;
    actions.push(listenMore.el);
  }

  handle.bodyHost.replaceChildren(
    ui.el("div", { class: "clip-quiz__result" }, poster, ui.el("div", { class: "row" }, ...actions)),
  );
  nextBtn.focus();
}

function showLoss() {
  const round = handle.round;
  const track = round.track;
  const album = track.album;
  const lostStreak = handle.run.streak;

  scores.saveRun(GAME_ID, { streak: handle.run.streak, points: handle.run.points });
  handle.run.streak = 0;
  handle.run.points = 0;
  handle.hud.update({ streak: 0, points: 0, best: scores.getRecord(GAME_ID).bestStreak });

  const poster = ui.revealPoster({
    paper: "yellow",
    title: track.name,
    lines: [artistNames(track).join(", "), [album?.name, yearOf(album)].filter(Boolean).join(" · ")],
    coverUrl: album?.images?.[0]?.url,
  });

  const otraBtn = ui.el("button", {
    class: "btn btn--primary",
    type: "button",
    text: "Otra canción",
    on: { click: () => startRound() },
  });

  handle.bodyHost.replaceChildren(
    ui.el("div", { class: "clip-quiz__result" },
      lostStreak > 0 ? ui.el("p", { class: "clip-quiz__lost-note", text: `Se cortó la racha de ${lostStreak}.` }) : null,
      poster,
      ui.el("div", { class: "row" }, otraBtn),
    ),
  );
  otraBtn.focus();
}

function yearOf(album) {
  return String(album?.release_date ?? "").slice(0, 4) || "";
}
