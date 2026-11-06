// "Completa la letra": the whole song, typed word by word on a full-screen,
// Spotify-lyrics-style view with a real transport bar. Playback never starts
// (and Spotify is never touched) before the first press of play.

import * as ui from "../ui.js";
import { getLyrics } from "../lyrics.js";
import { parseLyrics } from "../lyrics-parse.js";
import { createTypingGame } from "../lyrics-typing.js";
import { createQueue } from "../lyrics-queue.js";
import {
  DEFAULT_FLOOD, floodFromRgb, fallbackFlood, dominantRgb,
} from "../letra-color.js";
import { artistNames } from "../clip-guess.js";
import { mountPicker, pickImage } from "./letra-picker.js";

const MIN_WORDS = 6; // fewer typeable words than this is not a lyric worth playing
const SCROLL_ANCHOR = 0.38; // the cursor line is held this far from the top of the scroller
const STREAK_SHOWN_FROM = 5;
const TYPING_IDLE_MS = 700;
const SAMPLE_TIMEOUT_MS = 4000;

let handle = null;

function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function clock(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function playOnce(node, className) {
  if (!node || reducedMotion()) return;
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
  node.addEventListener("animationend", () => node.classList.remove(className), { once: true });
}

function coverOf(track) {
  return pickImage(track?.album?.images, 160);
}

// --- mount / unmount ----------------------------------------------------------

export function mount(container, ctx) {
  document.body.dataset.immersive = "1";
  const root = ui.el("div", { class: "letra", dataset: { mode: "pick" } });
  container.replaceChildren(root);
  handle = {
    container, ctx, root,
    alive: true,
    picker: null,
    view: null,
    queue: null,
    entries: new Map(),
    cur: null,
    navSeq: 0,
    playSeq: 0,
    putInflight: false,
    settleUntil: 0, // right after a play lands the SDK may still report the old paused state
    wantPlay: false, // the user wants sound (playing, or about to)
    playing: false, // this tab is audibly playing the current song
    touchedPlayback: false,
    repeat: false,
    rafId: 0,
    offs: [],
    dialog: null,
  };
  setFlood(DEFAULT_FLOOD);
  handle.offs.push(
    ctx.player.onPlayback(onPlayback),
    ctx.player.onPremiumError(() => paintTransport()),
    ctx.player.onReady(() => paintTransport()),
  );
  document.addEventListener("keydown", onDocKeydown, true);
  if (window.visualViewport) {
    const fit = () => fitViewport();
    window.visualViewport.addEventListener("resize", fit);
    window.visualViewport.addEventListener("scroll", fit);
    handle.offs.push(() => {
      window.visualViewport.removeEventListener("resize", fit);
      window.visualViewport.removeEventListener("scroll", fit);
    });
  }
  fitViewport();
  showPicker();
}

export function unmount() {
  const h = handle;
  if (!h) return;
  h.alive = false;
  cancelAnimationFrame(h.rafId);
  for (const off of h.offs) off();
  document.removeEventListener("keydown", onDocKeydown, true);
  for (const entry of h.entries.values()) entry.ctrl?.abort();
  h.picker?.destroy();
  h.dialog?.close();
  // Only if we ever started playback: stopFree sends no request, it pauses
  // the device and forgets ownership.
  if (h.touchedPlayback) h.ctx.player.stopFree();
  delete document.body.dataset.immersive;
  document.body.style.removeProperty("--toast-offset-bottom");
  handle = null;
}

function setFlood(hex) {
  const { root } = handle;
  root.style.setProperty("--song", hex);
  root.style.setProperty("--song-deep", mixBlack(hex));
}

function mixBlack(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#0b1a28";
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * 0.45));
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** On phones the keyboard shrinks the visual viewport, not the layout one. */
function fitViewport() {
  const h = handle;
  const vv = window.visualViewport;
  if (!h || !vv) return;
  h.root.style.height = `${Math.round(vv.height)}px`;
  h.root.style.transform = `translateY(${Math.round(vv.offsetTop)}px)`;
  measureBar();
}

function measureBar() {
  const bar = handle?.view?.bar;
  if (!bar) return;
  document.body.style.setProperty("--toast-offset-bottom", `${bar.offsetHeight + 20}px`);
  handle.root.style.setProperty("--bar-h", `${bar.offsetHeight}px`);
}

// --- picker -------------------------------------------------------------------

function showPicker(message) {
  const h = handle;
  teardownPlay();
  h.root.dataset.mode = "pick";
  setFlood(DEFAULT_FLOOD);
  document.body.style.removeProperty("--toast-offset-bottom");
  h.picker?.destroy();
  const host = ui.el("div", { class: "letra__screen" });
  h.root.replaceChildren(host);
  h.picker = mountPicker(host, { ctx: h.ctx, onStart: startQueue });
  if (message) h.picker.say(message);
  h.picker.focus();
}

function teardownPlay() {
  const h = handle;
  cancelAnimationFrame(h.rafId);
  h.rafId = 0;
  for (const entry of h.entries.values()) entry.ctrl?.abort();
  if (h.touchedPlayback) h.ctx.player.stopFree();
  h.touchedPlayback = false;
  h.navSeq++;
  h.playSeq++;
  h.wantPlay = false;
  h.playing = false;
  h.putInflight = false;
  h.queue = null;
  h.entries = new Map();
  h.cur = null;
  h.view = null;
  h.repeat = false;
}

// --- queue + entries ----------------------------------------------------------

function startQueue(tracks, startIndex) {
  const h = handle;
  h.picker?.destroy();
  h.picker = null;
  teardownPlay();
  h.queue = createQueue(tracks, { startIndex });
  buildPlayView();
  activate(h.queue.current(), +1, null);
}

function entryFor(track) {
  const h = handle;
  let e = h.entries.get(track.id);
  if (!e) {
    e = {
      track,
      state: "idle", // idle | loading | ready | none | error
      ctrl: null,
      parsed: null,
      timeline: [],
      game: null,
      lineEls: [],
      slots: [],
      backs: [],
      curLine: -1,
      cursor: -2,
      sungLine: -1,
      revealedN: 0,
      pending: 0, // where the song will start (ms); the live position while playing
      pendingAt: 0,
      duration: track.duration_ms ?? 0,
      flood: fallbackFlood(track.id),
      floodTried: false,
      t0: 0,
      elapsed: 0,
      finished: false,
    };
    h.entries.set(track.id, e);
  }
  return e;
}

/**
 * Makes `track` the current song. `dir` is the direction of travel (used to
 * keep going the same way past songs without lyrics); `from` is the song we
 * just left.
 */
function activate(track, dir, from) {
  const h = handle;
  if (!track) {
    showPicker("Ya no quedan canciones con letra. Elige otra.");
    return;
  }
  const prev = h.cur;
  if (prev && prev !== entryFor(track)) leave(prev);
  const entry = entryFor(track);
  const nav = ++h.navSeq;
  const resume = h.wantPlay;
  const wasPlaying = h.playing;
  // Switch first: the pause below can report its state synchronously, and that
  // report is about the song we are leaving, not the one we are arriving at.
  h.cur = entry;
  h.playing = false;
  if (resume && wasPlaying) h.ctx.player.pauseFree();
  h.view.root.dataset.loading = "1";
  paintNow(entry);
  applyFlood(entry);
  paintTransport();
  paintCount();
  loadEntry(entry).then((ok) => {
    if (!h.alive || nav !== h.navSeq) return;
    delete h.view.root.dataset.loading;
    if (ok) {
      renderLyrics(entry);
      paintAll(entry);
      scrollToCursor(entry, false);
      h.view.input.focus({ preventScroll: true });
      if (h.wantPlay) startPlay(entry, entry.pending);
      return;
    }
    skipUnusable(entry, dir, from ?? prev?.track ?? null);
  });
}

function leave(entry) {
  const h = handle;
  if (h.playing && h.cur === entry) {
    entry.pending = positionOf(entry);
    entry.pendingAt = performance.now();
  }
  if (entry.state === "loading") {
    entry.ctrl?.abort();
    entry.state = "idle";
  }
}

function skipUnusable(entry, dir, origin) {
  const h = handle;
  const q = h.queue;
  const text = entry.state === "error"
    ? `No pude cargar la letra de «${entry.track.name}».`
    : `No encontré la letra de «${entry.track.name}».`;
  if (q.size() <= 1) {
    showPicker(`${text} Elige otra canción.`);
    return;
  }
  ui.toast(`${text} La salto.`, "info");
  q.drop(entry.track.id);
  let target;
  if (dir < 0) target = q.prev() ?? q.current();
  else target = q.current();
  if (origin && target && target.id === origin.id && h.entries.get(origin.id)?.state !== "ready") {
    target = null;
  }
  if (!target) {
    showPicker("Ya no quedan canciones con letra. Elige otra.");
    return;
  }
  activate(target, dir, origin);
}

function go(delta) {
  const h = handle;
  const q = h.queue;
  if (!q || !h.cur) return;
  const from = h.cur.track;
  const target = delta > 0 ? q.next() : q.prev();
  if (!target) return;
  activate(target, delta, from);
}

// --- lyrics loading -----------------------------------------------------------

/** @returns {Promise<boolean>} true when the lyrics are ready and usable. */
async function loadEntry(entry) {
  if (entry.state === "ready") return true;
  if (entry.state === "none" || entry.state === "error") {
    if (entry.state === "none") return false;
  }
  entry.ctrl?.abort();
  const ctrl = new AbortController();
  entry.ctrl = ctrl;
  entry.state = "loading";
  const res = await getLyrics(entry.track, { signal: ctrl.signal });
  if (entry.ctrl !== ctrl || ctrl.signal.aborted) {
    if (entry.ctrl === ctrl && entry.state === "loading") entry.state = "idle";
    return false;
  }
  if (res.status === "error") {
    entry.state = "error";
    return false;
  }
  if (res.status !== "ok" || !res.text) {
    entry.state = "none";
    return false;
  }
  const parsed = parseLyrics({ text: res.text, synced: res.lines });
  if (parsed.words.length < MIN_WORDS) {
    entry.state = "none";
    return false;
  }
  entry.parsed = parsed;
  entry.game = createTypingGame(parsed);
  entry.timeline = [];
  parsed.lines.forEach((line, l) => {
    if (line.ms != null) entry.timeline.push({ l, ms: line.ms });
  });
  if (entry.timeline.length < 3) entry.timeline = [];
  entry.state = "ready";
  return true;
}

// --- cover color --------------------------------------------------------------

function sampleCover(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(null), SAMPLE_TIMEOUT_MS);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 24;
        canvas.height = 24;
        const g = canvas.getContext("2d", { willReadFrequently: true });
        g.drawImage(img, 0, 0, 24, 24);
        finish(dominantRgb(g.getImageData(0, 0, 24, 24).data));
      } catch {
        finish(null); // tainted canvas or no 2d context: the hashed palette stays
      }
    };
    img.onerror = () => { clearTimeout(timer); finish(null); };
    img.src = url;
  });
}

function applyFlood(entry) {
  const h = handle;
  setFlood(entry.flood);
  if (entry.floodTried) return;
  entry.floodTried = true;
  const url = coverOf(entry.track);
  if (!url) return;
  sampleCover(url).then((rgb) => {
    if (!rgb) return;
    entry.flood = floodFromRgb(rgb[0], rgb[1], rgb[2]);
    if (handle === h && h.alive && h.cur === entry) setFlood(entry.flood);
  });
}

// --- play view ----------------------------------------------------------------

function iconButton(name, label, onClick, extra = "") {
  return ui.el("button", {
    class: `letra-btn${extra ? ` ${extra}` : ""}`, type: "button", "aria-label": label, title: label,
    on: { click: onClick },
  }, ui.icon(name));
}

function buildPlayView() {
  const h = handle;
  const { ctx } = h;

  const input = ui.el("input", {
    class: "letra__input", type: "text",
    autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false",
    enterkeyhint: "done", "aria-label": "Escribe la palabra que sigue",
  });
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKeydown);

  const back = ui.el("button", {
    class: "letra__back", type: "button", "aria-label": "Elegir otra canción",
    on: { click: () => showPicker() },
  }, ui.icon("back"), ui.el("span", { text: "Elegir otra" }));
  const streak = ui.el("span", { class: "letra__streak", hidden: true });
  const count = ui.el("span", { class: "letra__count" });
  const progFill = ui.el("i");
  const prog = ui.el("span", { class: "letra__prog", "aria-hidden": "true" }, progFill);
  const top = ui.el("header", { class: "letra__top" }, back,
    ui.el("div", { class: "letra__top-right" }, streak, count, prog));

  const lyrics = ui.el("div", { class: "letra__lyrics" });
  const scroller = ui.el("main", { class: "letra__scroller", "aria-label": "Letra", tabindex: "-1" }, lyrics);
  scroller.addEventListener("click", onLyricsClick);

  const finish = ui.el("div", { class: "letra__finish", hidden: true, role: "status" });

  // Bar: song | transport | tools.
  const coverImg = ui.el("img", { class: "letra__cover", alt: "", crossorigin: "anonymous", decoding: "async" });
  coverImg.addEventListener("error", () => {
    if (coverImg.getAttribute("crossorigin")) {
      coverImg.removeAttribute("crossorigin");
      coverImg.src = coverImg.src;
    } else {
      coverImg.removeAttribute("src");
    }
  });
  const title = ui.el("span", { class: "letra__title" });
  const artist = ui.el("span", { class: "letra__artist" });
  const now = ui.el("div", { class: "letra__now" }, coverImg, ui.el("div", { class: "letra__meta" }, title, artist));

  const shuffle = iconButton("shuffle", "Aleatorio", () => toggleShuffle(), "letra-btn--toggle");
  const prev = iconButton("prev", "Canción anterior", () => go(-1));
  const play = ui.el("button", {
    class: "letra__play", type: "button", "aria-label": "Reproducir", title: "Reproducir (Ctrl + Espacio)",
    on: { click: () => togglePlay() },
  }, ui.icon("play-solid", "letra__play-icon"), ui.el("span", { class: "letra__spin", "aria-hidden": "true" }));
  const next = iconButton("next", "Canción siguiente", () => go(+1));
  const repeat = iconButton("repeat", "Repetir canción", () => toggleRepeat(), "letra-btn--toggle");
  const ctrls = ui.el("div", { class: "letra__ctrls" }, shuffle, prev, play, next, repeat);

  const elapsed = ui.el("span", { class: "letra__time", text: "0:00" });
  const total = ui.el("span", { class: "letra__time", text: "0:00" });
  const seek = ui.el("input", {
    class: "letra__seek", type: "range", min: "0", max: "1000", step: "1", value: "0",
    "aria-label": "Posición de la canción",
  });
  seek.addEventListener("input", onSeekInput);
  seek.addEventListener("change", onSeekChange);
  const seekRow = ui.el("div", { class: "letra__seekrow" }, elapsed, seek, total);
  const note = ui.el("p", { class: "letra__note", hidden: true });
  const transport = ui.el("div", { class: "letra__transport" }, ctrls, seekRow, note);

  const hint = iconButton("hint", "Pista (Intro)", () => doHint());
  const revealLine = iconButton("reveal-line", "Revelar la línea (Mayús + Intro)", () => doRevealLine());
  const listen = iconButton("headphones", "Escuchar esta línea (Ctrl + Intro)", () => listenFromLine());
  const giveUp = iconButton("eye", "Ver toda la letra", () => confirmGiveUp());
  const help = iconButton("help", "Atajos de teclado", () => showHelp(), "letra-btn--help");
  const volume = ui.volumeControl(ctx);
  const volumeRange = volume.querySelector("input[type=range]");
  const paintVolume = () => volumeRange.style.setProperty("--p", `${volumeRange.value}%`);
  volumeRange.addEventListener("input", paintVolume);
  paintVolume();
  const tools = ui.el("div", { class: "letra__tools" },
    ui.el("div", { class: "letra__tools-btns" }, hint, revealLine, listen, giveUp, help), volume);

  const bar = ui.el("footer", { class: "letra__bar" }, now, transport, tools);
  // A mouse click on a button hands the keyboard back to the hidden field, so
  // the next letter is typed instead of re-activating the button.
  for (const zone of [bar, top]) {
    zone.addEventListener("click", (e) => {
      if (e.detail > 0 && e.target.closest("button")) requestAnimationFrame(refocus);
    });
  }
  const live = ui.liveRegion();

  h.root.dataset.mode = "play";
  h.root.replaceChildren(top, scroller, finish, bar, input, live);
  h.view = {
    root: h.root, input, top, back, streak, count, progFill, scroller, lyrics, finish, bar, coverImg, title, artist,
    shuffle, prev, play, next, repeat, elapsed, total, seek, seekRow, note, hint, revealLine, listen, giveUp, volume, live,
    typingTimer: 0, seeking: false, lastClock: "",
  };
  fitViewport();
  requestAnimationFrame(measureBar);
}

function paintNow(entry) {
  const v = handle.view;
  const url = coverOf(entry.track);
  if (url) {
    if (v.coverImg.getAttribute("src") !== url) {
      v.coverImg.setAttribute("crossorigin", "anonymous");
      v.coverImg.src = url;
    }
  } else {
    v.coverImg.removeAttribute("src");
  }
  v.title.textContent = entry.track.name;
  v.artist.textContent = artistNames(entry.track).join(", ");
  v.finish.hidden = true;
  v.lyrics.replaceChildren();
  v.streak.hidden = true;
  v.progFill.style.width = "0%";
}

function paintCount() {
  const h = handle;
  const q = h.queue;
  const v = h.view;
  v.count.textContent = q.size() > 1 ? `${q.index() + 1} de ${q.size()}` : "";
  v.count.hidden = q.size() <= 1;
  v.prev.disabled = !q.hasPrev();
  v.next.disabled = !q.hasNext();
  v.shuffle.disabled = q.size() <= 1;
  v.shuffle.setAttribute("aria-pressed", String(q.isShuffled()));
  v.shuffle.classList.toggle("is-on", q.isShuffled());
}

// --- lyrics DOM ---------------------------------------------------------------

function renderLyrics(entry) {
  const v = handle.view;
  const { parsed } = entry;
  entry.lineEls = [];
  entry.slots = new Array(parsed.words.length);
  entry.backs = parsed.lines.map(() => []);
  entry.curLine = -1;
  entry.cursor = -2;
  entry.sungLine = -1;
  entry.revealedN = 0;
  const frag = document.createDocumentFragment();
  parsed.lines.forEach((line, l) => {
    const p = ui.el("p", { class: "letra__line", dataset: { l } });
    line.tokens.forEach((tok, t) => {
      if (t > 0) p.append(" ");
      if (tok.kind === "word") {
        const slot = buildSlot(tok);
        entry.slots[tok.wordIndex] = slot;
        p.append(slot.w);
      } else {
        const node = ui.el("span", {
          class: tok.kind === "filler" ? "letra__fill" : "letra__back-tok",
          text: `${tok.pre ?? ""}${tok.text}${tok.post ?? ""}`,
        });
        if (tok.kind === "backing") entry.backs[l].push({ node, t });
        p.append(node);
      }
    });
    entry.lineEls.push(p);
    frag.append(p);
  });
  v.lyrics.replaceChildren(frag);
  v.lyrics.dataset.song = entry.track.id;
}

function buildSlot(tok) {
  const ghost = ui.el("span", { class: "letra__ghost", "aria-hidden": "true", text: tok.text });
  const typed = ui.el("span", { class: "letra__typed", "aria-hidden": "true" });
  const core = ui.el("span", { class: "letra__core" }, ghost, typed);
  const w = ui.el("span", { class: "letra__w", dataset: { i: tok.wordIndex } },
    tok.pre ? ui.el("span", { class: "letra__p", text: tok.pre }) : null,
    core,
    tok.post ? ui.el("span", { class: "letra__p", text: tok.post }) : null,
  );
  return { w, core, ghost, typed, on: false, how: null, cur: false, text: "" };
}

/** Brings one slot in line with the game state; cheap and idempotent. */
function paintSlot(entry, i, animate) {
  const s = entry.slots[i];
  if (!s) return;
  const g = entry.game;
  const on = g.isRevealed(i);
  const cur = !on && i === g.cursor();
  if (on !== s.on) {
    s.on = on;
    s.w.classList.toggle("is-on", on);
    if (on) {
      s.ghost.removeAttribute("aria-hidden");
      entry.revealedN++;
      if (animate) playOnce(s.core, "is-pop");
    }
  }
  if (cur !== s.cur) {
    s.cur = cur;
    s.w.classList.toggle("is-cur", cur);
  }
  if (on) {
    const how = g.howRevealed(i);
    if (how !== s.how) {
      s.how = how;
      s.w.dataset.how = how ?? "";
    }
    if (s.text) {
      s.typed.textContent = "";
      s.text = "";
    }
    return;
  }
  const buf = cur ? g.buffer() : "";
  const text = buf || g.hintText(i);
  if (text !== s.text) {
    s.text = text;
    s.typed.textContent = text;
    s.typed.classList.toggle("is-hint", !buf);
  }
}

function paintBacking(entry, lines) {
  const g = entry.game;
  for (const l of lines) {
    for (const b of entry.backs[l] ?? []) {
      const seen = g.isBackingVisible(l, b.t);
      if (seen !== b.seen) {
        b.seen = seen;
        b.node.classList.toggle("is-seen", seen);
      }
    }
  }
}

function paintAll(entry) {
  const g = entry.game;
  for (let i = 0; i < entry.slots.length; i++) paintSlot(entry, i, false);
  paintBacking(entry, entry.backs.map((_, l) => l));
  entry.cursor = g.cursor();
  paintCursorLine(entry);
  paintProgress(entry);
  paintStreak(entry);
  paintSung(entry);
  paintTransport();
  if (g.isDone()) showFinish(entry);
}

function paintCursorLine(entry) {
  const g = entry.game;
  const c = g.cursor();
  const line = c >= 0 ? g.lineOf(c) : -1;
  if (line === entry.curLine) return false;
  entry.lineEls[entry.curLine]?.classList.remove("is-cur");
  entry.curLine = line;
  entry.lineEls[line]?.classList.add("is-cur");
  return true;
}

function paintProgress(entry) {
  const total = entry.slots.length || 1;
  handle.view.progFill.style.width = `${Math.round((100 * entry.revealedN) / total)}%`;
}

function paintStreak(entry) {
  const n = entry.game.streak();
  const el = handle.view.streak;
  el.hidden = n < STREAK_SHOWN_FROM;
  if (!el.hidden) el.textContent = `${n} seguidas`;
}

function scrollToCursor(entry, smooth = true) {
  const v = handle.view;
  const line = entry.lineEls[entry.curLine >= 0 ? entry.curLine : entry.sungLine];
  if (!line) return;
  const target = line.offsetTop + line.offsetHeight / 2 - v.scroller.clientHeight * SCROLL_ANCHOR;
  v.scroller.scrollTo({ top: Math.max(0, target), behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
}

// --- typing -------------------------------------------------------------------

function afterEngine(entry, events) {
  const h = handle;
  const v = h.view;
  const g = entry.game;
  if (v.input.value !== g.buffer()) v.input.value = g.buffer();
  if (!entry.t0 && events.some((e) => e.type !== "typing" || g.buffer())) entry.t0 = Date.now();

  const dirty = new Set();
  const popped = new Set();
  const lines = new Set();
  let missAt = -1;
  let done = false;
  let revealedLine = -1;
  if (entry.cursor >= 0) dirty.add(entry.cursor);
  for (const ev of events) {
    if (ev.type === "reveal") {
      dirty.add(ev.index);
      popped.add(ev.index);
      if (revealedLine === -1 || ev.how === "typed") revealedLine = g.lineOf(ev.index);
      for (const r of ev.repeated ?? []) { dirty.add(r); popped.add(r); }
    } else if (ev.type === "miss") missAt = ev.index;
    else if (ev.type === "done") done = true;
  }
  const c = g.cursor();
  if (c >= 0) dirty.add(c);
  for (const i of dirty) {
    paintSlot(entry, i, popped.has(i));
    lines.add(g.lineOf(i));
  }
  if (c >= 0) { lines.add(g.lineOf(c)); lines.add(g.lineOf(c) + 1); }
  paintBacking(entry, [...lines].filter((l) => l >= 0 && l < entry.backs.length));
  entry.cursor = c;
  const moved = paintCursorLine(entry);
  if (moved) scrollToCursor(entry);
  paintProgress(entry);
  paintStreak(entry);

  if (missAt >= 0) playOnce(entry.slots[missAt]?.core, "is-miss");
  if (revealedLine >= 0 && g.cursor() !== -1 && lineComplete(entry, revealedLine) && moved) {
    playOnce(v.root, "is-pulse");
  }
  v.root.classList.add("is-typing");
  clearTimeout(v.typingTimer);
  v.typingTimer = setTimeout(() => v.root.classList.remove("is-typing"), TYPING_IDLE_MS);

  if (done) paintAll(entry); // also raises the finish panel
}

function lineComplete(entry, l) {
  const g = entry.game;
  for (let i = 0; i < entry.slots.length; i++) {
    if (g.lineOf(i) === l && !g.isRevealed(i)) return false;
  }
  return true;
}

function onInput() {
  const entry = readyEntry();
  if (!entry) return;
  const v = handle.view;
  afterEngine(entry, entry.game.setBuffer(v.input.value));
}

function readyEntry() {
  const e = handle?.cur;
  return e && e.state === "ready" && e.game && handle.view.lyrics.dataset.song === e.track.id ? e : null;
}

function runEngine(fn) {
  const entry = readyEntry();
  if (!entry) return;
  afterEngine(entry, fn(entry.game));
}

function doHint() { runEngine((g) => g.hint()); refocus(); }
function doRevealLine() { runEngine((g) => g.revealLine()); refocus(); }

function refocus() {
  handle?.view?.input.focus({ preventScroll: true });
}

function onLyricsClick(e) {
  const slot = e.target.closest?.(".letra__w");
  if (slot) {
    const entry = readyEntry();
    if (entry) afterEngine(entry, entry.game.moveCursor(Number(slot.dataset.i)));
  }
  refocus();
}

/** Keys that belong to the game even when focus is somewhere else. */
function shortcut(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === " ") { e.preventDefault(); togglePlay(); return true; }
  if (mod && e.key === "Enter") { e.preventDefault(); listenFromLine(); return true; }
  if (mod && e.key === "ArrowRight") { e.preventDefault(); go(+1); return true; }
  if (mod && e.key === "ArrowLeft") { e.preventDefault(); go(-1); return true; }
  return false;
}

function onKeydown(e) {
  if (e.isComposing) return;
  if (shortcut(e)) return;
  const entry = readyEntry();
  const k = e.key;
  if (k === "Tab") {
    e.preventDefault();
    if (entry) afterEngine(entry, e.shiftKey ? entry.game.prevWord() : entry.game.nextWord());
    return;
  }
  if (k === "Enter") {
    e.preventDefault();
    if (!entry) return;
    const g = entry.game;
    if (g.isDone()) {
      if (handle.queue.hasNext()) go(+1);
      return;
    }
    if (e.shiftKey) afterEngine(entry, g.revealLine());
    else if (g.buffer().trim() === "") afterEngine(entry, g.hint());
    else afterEngine(entry, g.commit());
    return;
  }
  if (k === "Escape") {
    handle.view.input.blur();
    return;
  }
  // The caret never moves inside the hidden field: the engine owns the text.
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(k)) {
    e.preventDefault();
  }
}

/** Typing from anywhere returns to the hidden field; shortcuts work everywhere. */
function onDocKeydown(e) {
  const h = handle;
  if (!h?.view || h.dialog) return;
  const t = e.target;
  if (t === h.view.input) return;
  if (t?.closest?.("dialog")) return;
  if (shortcut(e)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "Enter" || e.key === "Tab" || e.key === "Escape") return;
  if (e.key.length === 1 || e.key === "Backspace") h.view.input.focus({ preventScroll: true });
}

// --- playback -----------------------------------------------------------------

function audioIssue() {
  const { ctx } = handle;
  if (!ctx.player.isPremium()) return "Escuchar necesita Spotify Premium. Puedes jugar igual.";
  if (ctx.state.player.status === "error") return "El reproductor de Spotify no se pudo conectar. Puedes jugar igual.";
  return "";
}

function positionOf(entry) {
  const h = handle;
  if (h.playing && h.cur === entry) {
    return Math.min(entry.duration || Infinity, entry.pending + (performance.now() - entry.pendingAt));
  }
  return entry.pending;
}

async function startPlay(entry, positionMs) {
  const h = handle;
  const my = ++h.playSeq;
  h.wantPlay = true;
  h.putInflight = true;
  h.touchedPlayback = true;
  paintTransport();
  const res = await h.ctx.player.playTrack(entry.track.uri, { positionMs });
  if (!h.alive) return;
  if (my === h.playSeq) h.putInflight = false;
  if (res.ok) {
    if (my !== h.playSeq || h.cur !== entry || !h.wantPlay) {
      // The user paused or skipped while the request was in flight.
      h.ctx.player.pauseFree();
    } else {
      h.playing = true;
      h.settleUntil = performance.now() + 1500;
      entry.pending = positionMs;
      entry.pendingAt = performance.now();
      startLoop();
    }
  } else if (res.reason !== "stale" && my === h.playSeq) {
    h.wantPlay = false;
    h.playing = false;
    if (res.reason === "premium") {
      // player.js already told everyone; the bar shows why.
    } else if (res.reason === "no-device") {
      ui.toast("El reproductor de Spotify todavía no está listo. Inténtalo de nuevo en un momento.", "error");
    } else {
      ui.toast("No pude empezar a reproducir. Inténtalo de nuevo.", "error");
    }
  }
  paintTransport();
}

function togglePlay() {
  const h = handle;
  if (!h?.view || audioIssue()) return;
  const entry = h.cur;
  if (!entry || entry.state !== "ready") return;
  if (h.wantPlay) {
    if (h.playing) {
      entry.pending = positionOf(entry);
      entry.pendingAt = performance.now();
    }
    h.wantPlay = false;
    h.playing = false;
    if (!h.putInflight) h.ctx.player.pauseFree();
  } else {
    h.wantPlay = true;
    if (h.ctx.player.isOwning(entry.track.uri)) {
      h.ctx.player.resumeFree();
      h.playing = true;
      entry.pendingAt = performance.now();
      startLoop();
    } else {
      startPlay(entry, entry.pending);
    }
  }
  paintTransport();
  refocus();
}

function onPlayback(e) {
  const h = handle;
  if (!h?.view || !h.cur) return;
  if (e.lost) {
    h.wantPlay = false;
    h.playing = false;
    paintTransport();
    return;
  }
  const entry = h.cur;
  if (e.uri !== entry.track.uri) return; // the previous song's last words
  if (e.paused && (h.putInflight || performance.now() < h.settleUntil) && !e.ended) return; // stale state before the new play lands
  if (e.duration) entry.duration = e.duration;
  entry.pending = e.position;
  entry.pendingAt = performance.now();
  if (e.ended) {
    entry.pending = 0;
    h.playing = false;
    h.wantPlay = false;
    paintTransport();
    if (h.repeat && !h.putInflight) startPlay(entry, 0);
    return;
  }
  h.playing = !e.paused;
  h.wantPlay = h.playing || h.putInflight;
  if (h.playing) {
    startLoop();
    h.settleUntil = 0;
  }
  paintTransport();
}

function toggleShuffle() {
  const h = handle;
  h.queue.setShuffle(!h.queue.isShuffled());
  paintCount();
  refocus();
}

function toggleRepeat() {
  const h = handle;
  h.repeat = !h.repeat;
  h.view.repeat.setAttribute("aria-pressed", String(h.repeat));
  h.view.repeat.classList.toggle("is-on", h.repeat);
  refocus();
}

function listenFromLine() {
  const h = handle;
  if (!h?.view || audioIssue()) return;
  const entry = readyEntry();
  if (!entry || entry.timeline.length === 0) {
    ui.toast("Esta canción no tiene tiempos para escuchar una línea.", "info");
    return;
  }
  const c = entry.game.cursor();
  const l = c >= 0 ? entry.game.lineOf(c) : entry.sungLine;
  const ms = entry.parsed.lines[l]?.ms;
  if (ms == null) return;
  entry.pending = ms;
  entry.pendingAt = performance.now();
  h.wantPlay = true;
  if (h.ctx.player.isOwning(entry.track.uri)) {
    h.ctx.player.seekFree(ms);
    if (!h.playing) {
      h.ctx.player.resumeFree();
      h.playing = true;
    }
    startLoop();
  } else {
    startPlay(entry, ms);
  }
  paintTransport();
  refocus();
}

// --- seek ---------------------------------------------------------------------

function seekMax(entry) {
  return Math.max(1, entry.duration || entry.track.duration_ms || 1);
}

function onSeekInput() {
  const h = handle;
  const v = h.view;
  v.seeking = true;
  const entry = h.cur;
  const ms = (Number(v.seek.value) / 1000) * seekMax(entry);
  v.elapsed.textContent = clock(ms);
  v.seek.style.setProperty("--p", `${v.seek.value / 10}%`);
}

function onSeekChange() {
  const h = handle;
  const v = h.view;
  v.seeking = false;
  const entry = h.cur;
  if (!entry) return;
  const ms = Math.round((Number(v.seek.value) / 1000) * seekMax(entry));
  entry.pending = ms;
  entry.pendingAt = performance.now();
  if (h.ctx.player.isOwning(entry.track.uri)) h.ctx.player.seekFree(ms);
  paintClock();
  refocus();
}

// --- transport paint ----------------------------------------------------------

function startLoop() {
  const h = handle;
  if (h.rafId) return;
  const tick = () => {
    h.rafId = 0;
    if (!h.alive || !h.view) return;
    paintClock();
    if (h.playing) h.rafId = requestAnimationFrame(tick);
  };
  h.rafId = requestAnimationFrame(tick);
}

function paintClock() {
  const h = handle;
  const v = h?.view;
  const entry = h?.cur;
  if (!v || !entry) return;
  const dur = seekMax(entry);
  const pos = Math.min(dur, positionOf(entry));
  if (!v.seeking) {
    const p = (pos / dur) * 1000;
    v.seek.value = String(Math.round(p));
    v.seek.style.setProperty("--p", `${p / 10}%`);
    const label = clock(pos);
    if (label !== v.lastClock) {
      v.lastClock = label;
      v.elapsed.textContent = label;
    }
  }
  v.total.textContent = clock(dur);
  if (entry.state === "ready") paintSung(entry, pos);
}

function paintSung(entry, pos = positionOf(entry)) {
  if (entry.timeline.length === 0) return;
  const showing = handle.playing || pos > 0;
  let lo = 0;
  let hi = entry.timeline.length - 1;
  let at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entry.timeline[mid].ms <= pos) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const l = showing && at >= 0 ? entry.timeline[at].l : -1;
  if (l === entry.sungLine) return;
  entry.lineEls[entry.sungLine]?.classList.remove("is-sung");
  entry.sungLine = l;
  entry.lineEls[l]?.classList.add("is-sung");
}

function paintTransport() {
  const h = handle;
  const v = h?.view;
  if (!v) return;
  const issue = audioIssue();
  const entry = h.cur;
  const ready = Boolean(entry && entry.state === "ready");
  const waiting = h.wantPlay && !h.playing;
  v.play.disabled = Boolean(issue) || !ready;
  v.play.classList.toggle("is-waiting", waiting && !issue);
  const showPause = h.wantPlay;
  if (v.playMode !== showPause) {
    v.playMode = showPause;
    v.play.replaceChildren(ui.icon(showPause ? "pause-solid" : "play-solid", "letra__play-icon"),
      ui.el("span", { class: "letra__spin", "aria-hidden": "true" }));
  }
  const playLabel = showPause ? "Pausar" : "Reproducir";
  v.play.setAttribute("aria-label", playLabel);
  v.play.title = `${playLabel} (Ctrl + Espacio)`;
  v.seek.disabled = Boolean(issue) || !ready;
  const volumeRange = v.volume.querySelector("input[type=range]");
  if (issue) volumeRange.disabled = true;
  else if (h.ctx.player.isReady()) volumeRange.disabled = false;
  v.repeat.disabled = Boolean(issue);
  const timed = Boolean(entry && entry.timeline.length > 0);
  v.listen.disabled = Boolean(issue) || !ready || !timed;
  v.note.hidden = !issue;
  v.note.textContent = issue;
  v.seekRow.hidden = Boolean(issue);
  v.root.classList.toggle("is-silent", Boolean(issue));
  v.root.classList.toggle("is-playing", h.playing);
  paintClock();
  if (ready && h.playing) startLoop();
  measureBar();
}

// --- finish -------------------------------------------------------------------

function showFinish(entry) {
  const h = handle;
  const v = h.view;
  if (!entry.finished) {
    entry.finished = true;
    entry.elapsed = entry.t0 ? Date.now() - entry.t0 : 0;
  }
  const st = entry.game.stats();
  const stat = (value, label) => ui.el("div", { class: "letra__stat" },
    ui.el("span", { class: "letra__stat-v", text: String(value) }),
    ui.el("span", { class: "letra__stat-l", text: label }),
  );
  const q = h.queue;
  const nextBtn = q.hasNext()
    ? ui.el("button", { class: "letra__cta", type: "button", text: "Siguiente canción", on: { click: () => go(+1) } })
    : null;
  const otherBtn = ui.el("button", {
    class: nextBtn ? "letra__quiet" : "letra__cta", type: "button", text: "Elegir otra",
    on: { click: () => showPicker() },
  });
  v.finish.replaceChildren(
    ui.el("div", { class: "letra__finish-head" },
      ui.el("span", { class: "letra__pct", text: `${st.pct} %` }),
      ui.el("span", { class: "letra__finish-sub", text: st.pct === 100 ? "Letra completa" : "de la letra, escrita por ti" }),
    ),
    ui.el("div", { class: "letra__stats" },
      stat(st.typed, "escritas"),
      stat(st.helped, "con ayuda"),
      stat(st.repeated, "repetidas"),
      stat(st.bestStreak, "mejor racha"),
      stat(clock(entry.elapsed), "tiempo"),
    ),
    ui.el("div", { class: "letra__finish-actions" }, nextBtn, otherBtn),
  );
  v.finish.hidden = false;
  playOnce(v.finish, "is-rise");
  v.live.textContent = `Letra terminada: ${st.pct} por ciento.`;
  measureBar();
}

// --- dialogs ------------------------------------------------------------------

function letraDialog(label, ...children) {
  const h = handle;
  const dlg = ui.openDialog({ label, class: "letra-dialog" }, ...children);
  dlg.dialog.style.setProperty("--song-deep", h.root.style.getPropertyValue("--song-deep"));
  dlg.dialog.style.setProperty("--song", h.root.style.getPropertyValue("--song"));
  h.dialog = dlg;
  dlg.closed.then(() => {
    if (handle === h) {
      h.dialog = null;
      refocus();
    }
  });
  return dlg;
}

function showHelp() {
  const rows = [
    ["Espacio o Intro", "Confirma la palabra"],
    ["Intro sin escribir", "Pista: una letra más"],
    ["Tab y Mayús + Tab", "Palabra siguiente y anterior"],
    ["Mayús + Intro", "Revela la línea"],
    ["Ctrl + Espacio", "Reproducir y pausar"],
    ["Ctrl + Intro", "Escuchar desde esta línea"],
    ["Ctrl + flechas", "Canción anterior y siguiente"],
    ["Esc", "Salir del campo para moverte con Tab"],
  ];
  const list = ui.el("dl", { class: "letra-help" });
  for (const [k, d] of rows) list.append(ui.el("dt", { text: k }), ui.el("dd", { text: d }));
  const close = ui.el("button", { class: "letra__cta", type: "button", text: "Entendido" });
  const dlg = letraDialog("Atajos de teclado",
    ui.el("h2", { class: "letra-dialog__h", text: "Atajos" }), list, close);
  close.addEventListener("click", () => dlg.close("ok"));
}

function confirmGiveUp() {
  const entry = readyEntry();
  if (!entry || entry.game.isDone()) return;
  const no = ui.el("button", { class: "letra__quiet", type: "button", text: "Seguir escribiendo" });
  const yes = ui.el("button", { class: "letra__cta", type: "button", text: "Ver la letra" });
  const dlg = letraDialog("Ver toda la letra",
    ui.el("h2", { class: "letra-dialog__h", text: "¿Ver toda la letra?" }),
    ui.el("p", { class: "letra-dialog__p", text: "Se revelan las palabras que faltan y se termina esta canción." }),
    ui.el("div", { class: "letra-dialog__actions" }, yes, no),
  );
  no.addEventListener("click", () => dlg.close("no"));
  yes.addEventListener("click", () => {
    dlg.close("yes");
    const e = readyEntry();
    if (e) afterEngine(e, e.game.giveUp());
  });
}
