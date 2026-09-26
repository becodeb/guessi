// Game 5 — "Completa la letra": five short lyric fragments per run, a few
// blanks per fragment, a draining timer, and help (Pista, Escuchar el
// fragmento) that costs points. The song is either drawn at random or picked
// by the player before each fragment. Works without Premium — only the
// "listen" help needs it, everything else (typing, hints, scoring) does not.

import * as ui from "../ui.js";
import * as scores from "../scores.js";
import { getLyrics } from "../lyrics.js";
import { searchSuggestions, artistNames } from "../clip-guess.js";
import { maskWord } from "../lyrics-engine.js";
import {
  SONGS_PER_RUN, FRAGMENT_TIMER_MS, LISTEN_CAP_MS, MAX_LISTENS_PER_FRAGMENT,
  HINT_COST, LISTEN_COST,
  buildFragment, createFragmentQuiz, findFragmentTiming, scoreFragment,
} from "../lyrics-quiz.js";

// An invented teaser line (never real lyrics — same rule as every fixture in
// this repo) shown on the start screen with a few words masked, just to show
// what a fragment looks like before the player commits to a run.
const TEASER_WORDS = [
  { text: "Una", blank: false }, { text: "historia", blank: true }, { text: "que", blank: false },
  { text: "solo", blank: false }, { text: "tú", blank: false }, { text: "puedes", blank: false },
  { text: "terminar", blank: true }, { text: "de", blank: false }, { text: "cantar", blank: true },
];

const GAME_ID = "letra";
const RESULT_DELAY_MS = 700;
const URGENT_MS = 8000; // last 8s of the timer get the urgent style

let handle = null;

export function mount(container, ctx) {
  handle = { container, ctx, timers: [], run: null, round: null };
  render();
}

export function unmount() {
  if (!handle) return;
  clearRoundTimers();
  for (const id of handle.timers) clearTimeout(id);
  handle.round?.listenState?.stop();
  handle.abort?.abort();
  // Only save once per run: a natural "Ver resultados" already saved it, so
  // leaving right afterwards (the results screen is still this view) must
  // not double-count the same run.
  if (handle.run && !handle.run.saved && (handle.run.points > 0 || handle.run.streak > 0)) {
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
      body: "Añade canciones a «Lo que sé» para jugar a Completa la letra.",
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
    ui.el("h1", { class: "display display--lg", text: "Completa la letra" }),
    hud.el,
  );

  const panels = ui.el("div", { class: "game__panels" });
  handle.panels = panels;

  const view = ui.el("section", { class: "view game lyrics-quiz" }, live, header, panels);
  container.append(view);

  renderStart();
}

function announce(msg) {
  if (handle?.live) handle.live.textContent = msg;
}

// --- start screen --------------------------------------------------------------

function teaserLine() {
  const line = ui.el("p", { class: "lyrics-quiz__teaser" });
  TEASER_WORDS.forEach((w, i) => {
    if (i > 0) line.append(" ");
    line.append(w.blank
      ? ui.el("span", { class: "lyrics-quiz__blank", text: maskWord(w.text, 0) })
      : ui.el("span", { text: w.text }));
  });
  return line;
}

function choiceCard({ modifier, icon, title, desc, onClick }) {
  return ui.el("button", {
    class: `lyrics-quiz__choice${modifier ? ` lyrics-quiz__choice--${modifier}` : ""}`,
    type: "button",
    on: { click: onClick },
  },
    ui.icon(icon),
    ui.el("span", { class: "lyrics-quiz__choice-title", text: title }),
    ui.el("span", { class: "lyrics-quiz__choice-desc", text: desc }),
  );
}

function renderStart() {
  const rules = ui.el("div", { class: "row row--wrap lyrics-quiz__rules" },
    ui.el("span", { class: "chip chip--muted", text: "5 canciones" }),
    ui.el("span", { class: "chip chip--muted", text: "45 s por fragmento" }),
    ui.el("span", { class: "chip chip--muted", text: "Pistas y audio cuestan puntos" }),
  );

  const choices = ui.el("div", { class: "lyrics-quiz__choices" },
    choiceCard({
      modifier: "primary",
      icon: "note",
      title: "Al azar",
      desc: "5 canciones sorpresa de «Lo que sé».",
      onClick: () => startRun("random"),
    }),
    choiceCard({
      icon: "search",
      title: "Elijo yo",
      desc: "Vos eliges cada canción, con un escape a una sorpresa cuando quieras.",
      onClick: () => startRun("pick"),
    }),
  );

  handle.panels.replaceChildren(
    ui.el("div", { class: "card lyrics-quiz__start" },
      ui.el("p", { class: "small dim lyrics-quiz__teaser-label", text: "Así se ve un fragmento" }),
      teaserLine(),
      rules,
      choices,
    ),
  );
}

function startRun(mode) {
  handle.run = { mode, songNumber: 0, excludedIds: new Set(), streak: 0, points: 0, perfectCount: 0, saved: false };
  handle.hud.update({ streak: 0, points: 0, best: scores.getRecord(GAME_ID).bestStreak });
  advance();
}

// --- song selection --------------------------------------------------------------

function eligiblePool() {
  const pool = handle.ctx.library.getPoolTracks();
  return pool.filter((t) => !handle.run.excludedIds.has(t.id));
}

function advance() {
  if (handle.run.songNumber >= SONGS_PER_RUN) {
    showResults();
    return;
  }
  if (handle.run.mode === "pick") renderPicker();
  else drawRandomAndLoad();
}

function drawRandomAndLoad() {
  const candidates = eligiblePool();
  if (candidates.length === 0) {
    showRunFailure();
    return;
  }
  const track = candidates[Math.floor(Math.random() * candidates.length)];
  loadSong(track);
}

function renderPicker(errorMsg) {
  const candidates = eligiblePool();
  if (candidates.length === 0) {
    showRunFailure();
    return;
  }

  const input = ui.el("input", {
    class: "guess__input combobox__input",
    type: "text",
    role: "combobox",
    "aria-expanded": "false",
    "aria-controls": "lyrics-quiz-listbox",
    "aria-autocomplete": "list",
    autocomplete: "off",
    placeholder: "Escribe el título o el artista",
    "aria-label": "¿Qué canción quieres jugar?",
  });
  const listbox = ui.el("ul", { class: "combobox__listbox", id: "lyrics-quiz-listbox", role: "listbox", hidden: true });

  function closeListbox() {
    listbox.hidden = true;
    listbox.replaceChildren();
    input.setAttribute("aria-expanded", "false");
  }

  function optionEl(t) {
    return ui.el("li", {
      class: "combobox__option", role: "option",
      on: { click: () => loadSong(t) },
    },
      ui.el("span", { class: "combobox__option-title", text: t.name }),
      ui.el("span", { class: "combobox__option-artists", text: artistNames(t).join(", ") }),
    );
  }

  input.addEventListener("input", () => {
    const q = input.value;
    if (q.trim().length < 2) { closeListbox(); return; }
    const options = searchSuggestions(candidates, q, 6);
    listbox.replaceChildren(...options.map(optionEl));
    listbox.hidden = options.length === 0;
    input.setAttribute("aria-expanded", String(options.length > 0));
  });

  const randomBtn = ui.el("button", {
    class: "btn btn--ghost btn--sm",
    type: "button",
    text: "Una al azar",
    on: { click: () => drawRandomAndLoad() },
  });

  handle.panels.replaceChildren(
    ui.el("div", { class: "card lyrics-quiz__picker" },
      ui.el("p", { class: "guess-panel__title", text: `Elige la canción ${handle.run.songNumber + 1} de ${SONGS_PER_RUN}` }),
      errorMsg ? ui.el("p", { class: "small dim", text: errorMsg }) : null,
      ui.el("div", { class: "combobox" }, input, listbox),
      randomBtn,
    ),
  );
  input.focus();
}

// --- lyrics loading ----------------------------------------------------------------

function loadSong(track) {
  handle.abort?.abort();
  const controller = new AbortController();
  handle.abort = controller;

  handle.panels.replaceChildren(
    ui.el("div", { class: "card lyrics-quiz__loading" },
      songHeader(track),
      ui.el("p", { class: "small dim", text: "Buscando la letra…" }),
      ui.skeleton(3),
    ),
  );

  getLyrics(track, { signal: controller.signal }).then((res) => {
    if (!handle || handle.abort !== controller) return;
    if (res.status !== "ok" || !res.text) {
      handleNoLyrics(track);
      return;
    }
    const fragment = buildFragment(res.text, { rng: Math.random });
    if (!fragment) {
      handleNoLyrics(track);
      return;
    }
    handle.run.excludedIds.add(track.id);
    handle.run.songNumber += 1;
    startFragment(track, fragment, res.lines);
  });
}

function handleNoLyrics(track) {
  if (!handle) return;
  handle.run.excludedIds.add(track.id);
  if (handle.run.mode === "random") {
    drawRandomAndLoad();
  } else {
    renderPicker(`No encontré la letra de «${track.name}». Elige otra canción.`);
  }
}

function showRunFailure() {
  handle.panels.replaceChildren(
    ui.el("div", { class: "card lyrics-quiz__gate" },
      ui.icon("warn"),
      ui.el("p", { text: "No pudimos encontrar letras para armar el juego con las canciones de tu biblioteca." }),
      ui.el("button", { class: "btn btn--primary", type: "button", text: "Volver a Juegos", on: { click: () => handle.ctx.navigate("#/juegos") } }),
    ),
  );
}

function songHeader(track) {
  const cover = track.album?.images?.[0]?.url;
  const img = cover
    ? ui.el("img", { class: "lyrics-quiz__cover", src: cover, alt: `Portada de ${track.album?.name ?? track.name}` })
    : null;
  if (img) img.addEventListener("error", () => img.remove(), { once: true });
  return ui.el("div", { class: "lyrics-quiz__song" },
    img,
    ui.el("div", { class: "lyrics-quiz__song-meta" },
      ui.el("p", { class: "lyrics-quiz__song-title", text: track.name }),
      ui.el("p", { class: "small dim", text: artistNames(track).join(", ") }),
    ),
  );
}

/**
 * Render tokenized lyric lines as normal flowing text (a single space text
 * node between tokens) instead of a flex row with a fixed `gap` — a `gap`
 * between every token reads as one wide, evenly-spaced gap per word (it does
 * not collapse to a normal single-space width), which is fine for
 * round-game.js's per-word buttons but not for plain reading text here.
 * `renderToken(tok)` returns the element for one word/punctuation token.
 */
function buildLinesHost(lines, renderToken) {
  const host = ui.el("div", { class: "lyrics-quiz__lines" });
  for (const lineTokens of lines) {
    if (lineTokens.length === 0) { host.append(ui.el("span", { class: "lyrics-quiz__gap", "aria-hidden": "true" })); continue; }
    const lineEl = ui.el("p", { class: "lyrics-quiz__line" });
    lineTokens.forEach((tok, i) => {
      if (i > 0) lineEl.append(" ");
      lineEl.append(renderToken(tok));
    });
    host.append(lineEl);
  }
  return host;
}

// --- fragment gameplay -------------------------------------------------------------

function startFragment(track, fragment, syncedLines) {
  const quiz = createFragmentQuiz(fragment);
  const timing = findFragmentTiming(fragment.rawLines, syncedLines, { capMs: LISTEN_CAP_MS });

  handle.round = {
    track, fragment, quiz, timing,
    blankEls: new Map(),
    hintCalls: 0,
    listenCalls: 0,
    listenState: null,
    tickId: null, urgentId: null, hardId: null, deadline: 0,
    ended: false,
  };

  renderFragment();
  startTimer();
}

function renderFragment() {
  const { track, fragment, quiz } = handle.round;

  const progress = ui.el("span", { class: "chip chip--muted", text: `Canción ${handle.run.songNumber} de ${SONGS_PER_RUN}` });

  handle.round.blankEls.clear();
  const linesHost = buildLinesHost(fragment.lines, (tok) => {
    if (!tok.isWord) return ui.el("span", { class: "lyrics-quiz__punct", text: tok.text });
    if (quiz.isBlank(tok.wordIndex)) {
      const span = ui.el("span", { class: "lyrics-quiz__blank", text: quiz.maskFor(tok.wordIndex) });
      handle.round.blankEls.set(tok.wordIndex, span);
      return span;
    }
    return ui.el("span", { class: "lyrics-quiz__word", text: tok.text });
  });

  const input = ui.el("input", {
    class: "input lyrics-quiz__input",
    type: "text",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    placeholder: "Escribe las palabras que faltan…",
    "aria-label": "Palabra que falta en la letra",
  });
  handle.round.input = input;

  function commit(raw) {
    const word = raw.trim();
    if (!word) return;
    const attempt = quiz.tryWord(word);
    if (attempt.ok) {
      fillBlank(attempt.index);
      input.value = "";
      announce("Correcto.");
      if (attempt.done) finishFragment("complete");
    } else {
      ui.shake(input);
      input.value = "";
    }
  }

  input.addEventListener("input", () => {
    const val = input.value;
    const attempt = quiz.tryWord(val.trim());
    if (attempt.ok) {
      fillBlank(attempt.index);
      input.value = "";
      announce("Correcto.");
      if (attempt.done) finishFragment("complete");
      return;
    }
    if (/\s$/.test(val)) commit(val);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(input.value); }
  });

  const timerFill = ui.el("div", { class: "lyrics-quiz__timer-fill" });
  const timerCountdown = ui.el("span", { class: "lyrics-quiz__timer-countdown display--num" });
  const timerTrack = ui.el("div", { class: "lyrics-quiz__timer", "aria-hidden": "true" }, timerFill);
  handle.round.timerTrack = timerTrack;
  handle.round.timerFill = timerFill;
  handle.round.timerCountdown = timerCountdown;

  const hintBtn = ui.el("button", {
    class: "btn btn--ghost btn--sm",
    type: "button",
    text: `Pista (-${HINT_COST})`,
    on: { click: () => useHint() },
  });
  handle.round.hintBtn = hintBtn;

  const listenRow = buildListenControl();

  handle.panels.replaceChildren(
    ui.el("div", { class: "card lyrics-quiz__fragment" },
      ui.el("div", { class: "row row--between" }, progress, ui.el("div", { class: "row" }, timerCountdown)),
      songHeader(track),
      fragment.contextLine ? ui.el("p", { class: "lyrics-quiz__context small dim", text: fragment.contextLine }) : null,
      linesHost,
      timerTrack,
      input,
      ui.el("div", { class: "lyrics-quiz__help row row--wrap" }, hintBtn, ...listenRow),
    ),
  );
  input.focus();
}

function fillBlank(index) {
  const span = handle.round.blankEls.get(index);
  if (!span) return;
  span.textContent = handle.round.quiz.maskFor(index);
  span.classList.add("lyrics-quiz__blank--found");
  ui.pop(span);
}

function useHint() {
  const round = handle.round;
  if (round.ended || round.quiz.isComplete()) return;
  const res = round.quiz.hint();
  if (!res.ok) return;
  round.hintCalls += 1;
  const span = round.blankEls.get(res.index);
  if (span) {
    span.textContent = round.quiz.maskFor(res.index);
    if (res.filled) span.classList.add("lyrics-quiz__blank--found");
    ui.pop(span);
  }
  if (round.quiz.isComplete()) finishFragment("complete");
}

/** "Escuchar el fragmento": Premium + synced timing only; capped uses. */
function buildListenControl() {
  const round = handle.round;
  const { ctx } = handle;

  if (!ctx.player.isPremium()) {
    return [ui.el("p", { class: "small dim lyrics-quiz__help-note", text: "Necesitas Spotify Premium para escuchar el fragmento." })];
  }
  if (!round.timing) {
    return [ui.el("p", { class: "small dim lyrics-quiz__help-note", text: "No hay un fragmento sincronizado para escuchar en esta canción." })];
  }

  let playing = false;
  const btn = ui.el("button", { class: "btn btn--ghost btn--sm", type: "button" });
  function label() {
    const left = MAX_LISTENS_PER_FRAGMENT - round.listenCalls;
    btn.textContent = playing ? "Detener" : `Escuchar el fragmento (-${LISTEN_COST}, ${left} rest.)`;
  }
  label();

  btn.addEventListener("click", async () => {
    if (playing) { ctx.player.stop(); return; }
    if (round.listenCalls >= MAX_LISTENS_PER_FRAGMENT || round.ended) return;
    if (!ctx.player.isPrimed(round.track.uri)) await ctx.player.prime(round.track.uri, { positionMs: round.timing.startMs });
    if (!handle || handle.round !== round || round.ended) return;
    round.listenCalls += 1;
    playing = true;
    label();
    ctx.player.playClip(round.timing.durationMs, {
      fromMs: round.timing.startMs,
      onEnd: () => {
        playing = false;
        btn.disabled = round.listenCalls >= MAX_LISTENS_PER_FRAGMENT;
        label();
      },
    });
  });
  round.listenState = { stop: () => { if (playing) ctx.player.stop(); } };
  return [btn];
}

// --- timer -------------------------------------------------------------------------

function startTimer() {
  const round = handle.round;
  round.deadline = Date.now() + FRAGMENT_TIMER_MS;

  round.timerFill.style.transition = "none";
  round.timerFill.style.width = "100%";
  void round.timerFill.offsetWidth;
  round.timerFill.style.transition = `width ${FRAGMENT_TIMER_MS}ms linear`;
  round.timerFill.style.width = "0%";

  updateCountdown();
  round.tickId = setInterval(updateCountdown, 250);
  round.urgentId = setTimeout(() => round.timerTrack.classList.add("lyrics-quiz__timer--urgent"), Math.max(0, FRAGMENT_TIMER_MS - URGENT_MS));
  round.hardId = setTimeout(() => finishFragment("timeout"), FRAGMENT_TIMER_MS);
}

function updateCountdown() {
  const round = handle?.round;
  if (!round) return;
  const remainingMs = Math.max(0, round.deadline - Date.now());
  round.timerCountdown.textContent = `${Math.ceil(remainingMs / 1000)} s`;
}

function clearRoundTimers() {
  const round = handle?.round;
  if (!round) return;
  clearInterval(round.tickId);
  clearTimeout(round.urgentId);
  clearTimeout(round.hardId);
}

// --- fragment outcome ------------------------------------------------------------

function finishFragment(reason) {
  const round = handle.round;
  if (round.ended) return;
  round.ended = true;
  clearRoundTimers();
  round.listenState?.stop();
  round.input.disabled = true;
  round.hintBtn.disabled = true;

  const remainingMs = reason === "timeout" ? 0 : Math.max(0, round.deadline - Date.now());
  const summary = scoreFragment({
    totalBlanks: round.quiz.totalBlanks(),
    foundCount: round.quiz.foundCount(),
    hintCalls: round.hintCalls,
    listenCalls: round.listenCalls,
    remainingMs,
    timerMs: FRAGMENT_TIMER_MS,
  });

  handle.run.points += summary.points;
  handle.run.streak = summary.completed ? handle.run.streak + 1 : 0;
  if (summary.perfect) handle.run.perfectCount += 1;

  const record = scores.getRecord(GAME_ID);
  handle.hud.update({
    streak: handle.run.streak,
    points: handle.run.points,
    best: Math.max(record.bestStreak, handle.run.streak),
  });
  if (summary.completed) {
    announce(`¡Fragmento completo! Más ${summary.points} puntos.`);
  } else if (reason === "timeout") {
    announce(`Se acabó el tiempo. Escribiste ${round.quiz.foundCount()} de ${round.quiz.totalBlanks()} palabras.`);
  } else {
    // Every blank got resolved, but not all of them by typing (some were
    // finished by a Pista) — not a timeout, but not a full find either.
    announce(`Fragmento resuelto con ayuda. Escribiste ${round.quiz.foundCount()} de ${round.quiz.totalBlanks()} palabras.`);
  }

  const id = setTimeout(() => showReveal(summary), RESULT_DELAY_MS);
  handle.timers.push(id);
}

function showReveal(summary) {
  const round = handle.round;
  const { fragment, quiz, track } = round;
  const album = track.album;

  // Snapshot BEFORE revealAll() — isTyped() is the "found" the parent asked
  // for (a hint-completed blank must read as missed, not found, same rule
  // scoreFragment/the streak use — see createFragmentQuiz).
  const wasTyped = new Set(fragment.blankIndices.filter((i) => quiz.isTyped(i)));
  quiz.revealAll();

  const linesHost = buildLinesHost(fragment.lines, (tok) => {
    if (!tok.isWord) return ui.el("span", { class: "lyrics-quiz__punct", text: tok.text });
    const missed = quiz.isBlank(tok.wordIndex) && !wasTyped.has(tok.wordIndex);
    return ui.el("span", {
      class: `lyrics-quiz__word${missed ? " lyrics-quiz__word--missed" : ""}`,
      text: tok.text,
    });
  });

  // Same reveal-poster component clip-game's win/loss screens use, in this
  // game's own paper color — the "poster moment" the parent asked for,
  // instead of a plain card with body text.
  const poster = ui.revealPoster({
    paper: "white",
    title: track.name,
    lines: [artistNames(track).join(", "), [album?.name, yearOf(album)].filter(Boolean).join(" · ")],
    coverUrl: album?.images?.[0]?.url,
    stamp: summary.perfect ? "¡Perfecto!" : `+${summary.points}`,
  });

  const isLast = handle.run.songNumber >= SONGS_PER_RUN;
  const nextBtn = ui.el("button", {
    class: "btn btn--primary",
    type: "button",
    text: isLast ? "Ver resultados" : "Siguiente",
    on: { click: () => advance() },
  });

  handle.panels.replaceChildren(
    ui.el("div", { class: "lyrics-quiz__reveal" },
      poster,
      linesHost,
      ui.el("div", { class: "row" }, nextBtn),
    ),
  );
  nextBtn.focus();
}

function yearOf(album) {
  return String(album?.release_date ?? "").slice(0, 4) || "";
}

// --- results poster -------------------------------------------------------------

function showResults() {
  const { record, isNewBestStreak, isNewBestPoints } = scores.saveRun(GAME_ID, {
    streak: handle.run.streak,
    points: handle.run.points,
  });
  handle.run.saved = true;
  handle.hud.update({ streak: handle.run.streak, points: handle.run.points, best: record.bestStreak });

  // Points lead the poster — perfects are a nice secondary line, but a run
  // with zero perfect fragments still earned real points and shouldn't read
  // as "0/5 PERFECTOS" (parent review: that buried the actual result).
  const poster = ui.revealPoster({
    paper: "white",
    title: `${handle.run.points} puntos`,
    lines: [`${handle.run.perfectCount}/${SONGS_PER_RUN} fragmentos perfectos`, `Récord: ${record.bestPoints} puntos, racha de ${record.bestStreak}`],
    stamp: (isNewBestStreak || isNewBestPoints) ? "¡Récord!" : undefined,
  });

  const againBtn = ui.el("button", {
    class: "btn btn--primary",
    type: "button",
    text: "Jugar otra vez",
    on: { click: () => renderStart() },
  });
  const backBtn = ui.el("a", { class: "btn btn--ghost", href: "#/juegos", text: "Volver a Juegos" });

  handle.panels.replaceChildren(
    ui.el("div", { class: "lyrics-quiz__result" }, poster, ui.el("div", { class: "row" }, againBtn, backBtn)),
  );
  againBtn.focus();
}
