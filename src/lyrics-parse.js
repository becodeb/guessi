// Pure lyrics parser for the typing game: cleans a lyric text (or LRC-synced
// lines), splits it into typeable words, never-typed fillers and backing
// vocals, and computes every form a player may type for each word.
// No DOM, no I/O, deterministic.

import { levenshtein } from "./match.js";

// --- character cleaning ------------------------------------------------------

// Cyrillic look-alikes found inside Spanish words of LRCLIB lyrics.
const HOMOGLYPHS = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c",
  "у": "y", "х": "x", "і": "i", "ѕ": "s",
  "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C",
  "У": "Y", "Х": "X", "І": "I", "Ѕ": "S",
};
const HOMOGLYPH_RE = /[аеорсухіѕАЕОРСУХІЅ]/g;

/** Map Cyrillic homoglyphs to their Latin twin. */
export function mapHomoglyphs(s) {
  return String(s ?? "").replace(HOMOGLYPH_RE, (c) => HOMOGLYPHS[c]);
}

/** Homoglyphs mapped, junk/control/format chars dropped, apostrophes unified. */
export function cleanText(s) {
  return mapHomoglyphs(s)
    .replace(/[\t  -   　]/g, " ")
    .replace(/[’‘ʼ′`´]/g, "'")
    .replace(/[￼\p{Cc}\p{Cf}]/gu, "");
}

/** Lowercase, accents (and the ñ tilde) removed. */
function strip(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Lowercase letters and digits only: no accents, spaces or punctuation. */
export function plain(s) {
  return strip(mapHomoglyphs(s)).replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Phonetic key: spellings that sound alike (and common drops of urban
 * Spanish) collapse to the same key.
 */
export function looseKey(input) {
  const base = plain(input);
  let s = base
    .replace(/ch/g, "#")
    .replace(/qu/g, "k")
    .replace(/c(?=[ei])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/x/g, "s")
    .replace(/v/g, "b")
    .replace(/ll/g, "y")
    .replace(/h/g, "")
    .replace(/g(?=[ei])/g, "j")
    .replace(/ado(s?)$/, "ao$1")
    .replace(/ido(s?)$/, "io$1")
    .replace(/y$/, "i")
    .replace(/s$/, "")
    .replace(/d$/, "")
    .replace(/l$/, "r")
    .replace(/(.)\1+/gu, "$1");
  return s || base;
}

// --- dictionary of urban contractions ---------------------------------------

const DICT = {
  pa: ["para"],
  to: ["todo", "toda", "todos", "todas"],
  tos: ["todos"],
  toa: ["toda"],
  na: ["nada"],
  ma: ["mas"],
  e: ["es"],
  ve: ["vez", "ves"],
  pue: ["pues", "puede"],
  cu: ["culo"],
  cora: ["corazon"],
  compa: ["companero", "compadre"],
  pal: ["para el"],
  palla: ["para alla"],
  paca: ["para aca"],
  patra: ["para atras"],
  palante: ["para adelante"],
  alante: ["adelante"],
  voa: ["voy a"],
  tol: ["todo el"],
  q: ["que"],
  xq: ["porque"],
  tb: ["tambien"],
  baby: ["beibi", "bebe", "babe"],
  uste: ["usted"],
  verda: ["verdad"],
  ta: ["esta", "estas"],
  toy: ["estoy"],
  tamos: ["estamos"],
  cause: ["because", "cuz"],
};

// Both directions: a written "para" also accepts "pa".
const DICT_REVERSE = (() => {
  const rev = {};
  for (const [short, longs] of Object.entries(DICT)) {
    for (const long of longs) {
      if (long.includes(" ")) continue;
      (rev[long] ??= []).push(short);
    }
  }
  return rev;
})();

function dictAll(p) {
  return [...(DICT[p] ?? []), ...(DICT_REVERSE[p] ?? [])];
}

// Second half of a mid-word apostrophe (`salgo'el`, `i'm`).
const Y_DICT = {
  e: ["de"],
  el: ["el", "del"],
  l: ["el"],
  a: ["a"],
  re: ["are"],
  ll: ["will"],
  m: ["am"],
  s: ["is"],
  d: ["would", "had"],
  ve: ["have"],
};

const NUMBER_WORDS = {
  0: ["cero"], 1: ["uno", "un", "una"], 2: ["dos"], 3: ["tres"], 4: ["cuatro"],
  5: ["cinco"], 6: ["seis"], 7: ["siete"], 8: ["ocho"], 9: ["nueve"],
  10: ["diez"], 11: ["once"], 12: ["doce"], 13: ["trece"], 14: ["catorce"],
  15: ["quince"], 16: ["dieciseis"], 17: ["diecisiete"], 18: ["dieciocho"],
  19: ["diecinueve"], 20: ["veinte"], 100: ["cien", "ciento"],
};

// --- form building -----------------------------------------------------------

const N_T_STEMS = { ca: ["can"], wo: ["will"], sha: ["shall"], ain: ["am", "is", "are"] };

// Returns strings that may contain spaces (multi-word forms).
function aposForms(w) {
  const bare = w.replace(/'/g, "");
  const out = new Set([bare]);
  const add = (...xs) => xs.forEach((x) => x && out.add(x));
  add(...dictAll(bare));

  const nt = w.match(/^(.+)n't$/);
  if (nt) {
    for (const stem of N_T_STEMS[nt[1]] ?? [nt[1]]) add(`${stem}not`, `${stem} not`);
    if (nt[1] === "ca") add("cannot");
  }

  if (!w.includes("'")) return out;
  const lead = w.startsWith("'");
  const trail = w.endsWith("'");
  const parts = w.replace(/^'+|'+$/g, "").split("'");

  if (parts.length === 1) {
    const x = parts[0];
    const xs = new Set([x]);
    if (trail) for (const c of ["s", "d", "r", "g"]) xs.add(x + c);
    for (const f of [...xs]) add(f);
    for (const f of dictAll(x)) { xs.add(f); add(f); }
    if (lead) {
      for (const f of xs) {
        if (f.includes(" ")) continue;
        add(`es${f}`);
        if (f.length <= 2) add(`d${f}`);
      }
    }
  } else if (parts.length === 2) {
    const [x, y] = parts;
    const xf = [x, ...dictAll(x)];
    const yf = [y, ...(Y_DICT[y] ?? []), ...dictAll(y)];
    for (const a of xf) {
      for (const b of yf) {
        add(a + b, `${a} ${b}`);
      }
      add(`${a}s${y}`, `${a}d${y}`);
      if (a.length >= 3) add(`${a.slice(0, -1)}d${a.slice(-1)}${y}`);
    }
  } else {
    add(parts.join(""), parts.join(" "));
  }
  return out;
}

function hyphenForms(t) {
  const segs = t.split("-").filter(Boolean);
  if (segs.length <= 1) return aposForms(segs[0] ?? "");
  const clean = segs.map((x) => x.replace(/^'+|'+$/g, ""));
  const joined = clean.join("");
  const collapsed = joined.replace(/(.)\1+/gu, "$1");
  const out = new Set([joined, collapsed, clean.join(" ")]);
  const last = clean[clean.length - 1];
  if (last.length >= 3) {
    out.add(last);
    for (const d of dictAll(last)) out.add(d);
  }
  if (segs[segs.length - 1].endsWith("'")) {
    for (const base of [joined, collapsed]) for (const c of ["s", "d", "r", "g"]) out.add(base + c);
  }
  for (const base of [joined, collapsed]) for (const d of dictAll(base)) out.add(d);
  return out;
}

/**
 * Everything the player may type for one raw word.
 * @returns {{forms:Set<string>, phrases:Set<string>}} `forms` are plain
 *   (spaces removed); `phrases` are the multi-word forms, spaces kept.
 */
export function expandForms(raw) {
  const original = String(raw ?? "");
  const s = strip(mapHomoglyphs(original)).replace(/[^\p{L}\p{N}'\-:.]/gu, "");
  const forms = new Set();
  const phrases = new Set();
  const addAll = (arr) => {
    for (const f of arr) {
      const t = String(f).trim().replace(/\s+/g, " ");
      const p = t.replace(/ /g, "");
      if (!p) continue;
      forms.add(p);
      if (t.includes(" ")) phrases.add(t);
    }
  };
  addAll([plain(original)]);

  const num = s.match(/^(\d+)(?::(\d+))?$/);
  if (num) {
    const hour = Number(num[1]);
    if (num[2] !== undefined) addAll([num[1]]);
    addAll(NUMBER_WORDS[hour] ?? []);
    return { forms, phrases };
  }

  const t = s.replace(/[:.]/g, "").replace(/^-+|-+$/g, "");
  addAll(t.includes("-") ? hyphenForms(t) : aposForms(t));
  return { forms, phrases };
}

/** Plain forms (stripped of everything, spaces removed) the player may type. */
export function buildForms(rawWord) {
  return expandForms(rawWord).forms;
}

function holdsOf(phrases) {
  const holds = new Set();
  for (const phrase of phrases) {
    const words = phrase.split(" ").filter(Boolean);
    for (let k = 1; k < words.length; k++) {
      const prefix = words.slice(0, k).join("");
      holds.add(prefix);
      holds.add(looseKey(prefix));
    }
  }
  return holds;
}

function makeWordFields(raw, extraForms = null) {
  const { forms, phrases } = expandForms(raw);
  if (extraForms) {
    for (const f of extraForms) forms.add(f);
  }
  const keys = new Set();
  for (const f of forms) keys.add(looseKey(f));
  return { forms, keys, holds: holdsOf(phrases), key: looseKey(raw) };
}

/** The typed text equals a plain form or a phonetic key of the word. */
export function acceptsWord(word, typed) {
  const p = plain(typed);
  if (!p) return false;
  return word.forms.has(p) || word.keys.has(looseKey(p));
}

/** Typo tolerance on phonetic keys: 1 edit from 5 letters, 2 from 9. */
export function fuzzyAccepts(word, typed) {
  const p = plain(typed);
  if (!p) return false;
  const tk = looseKey(p);
  for (const k of word.keys) {
    const limit = k.length >= 9 ? 2 : k.length >= 5 ? 1 : 0;
    if (limit > 0 && levenshtein(tk, k) <= limit) return true;
  }
  return false;
}

/** The typed text is a strict prefix of a multi-word form (`voy` for `vo'a`). */
export function holdsWord(word, typed) {
  const p = plain(typed);
  if (!p) return false;
  return word.holds.has(p) || word.holds.has(looseKey(p));
}

/** Add AI-provided full forms (`"salgo del"`) to one word. */
export function addForms(word, extraRaw) {
  for (const raw of extraRaw ?? []) {
    const spaced = strip(mapHomoglyphs(String(raw))).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const p = spaced.replace(/ /g, "");
    if (!p) continue;
    word.forms.add(p);
    word.keys.add(looseKey(p));
    if (spaced.includes(" ")) {
      for (const h of holdsOf([spaced])) word.holds.add(h);
    }
  }
  return word;
}

// --- fillers -----------------------------------------------------------------

// Collapsed (letter runs reduced to one) interjections.
const INTERJECTIONS = new Set([
  "eh", "ey", "ah", "oh", "uh", "uy", "ay", "m", "hm", "yeah", "yeh", "yah",
  "wow", "woh", "woah", "uoh", "hey", "ja", "je", "aja", "pr", "br", "eah", "huh",
]);

function isInterjection(seg) {
  if (!seg) return false;
  const collapsed = seg.replace(/(.)\1+/gu, "$1");
  if (INTERJECTIONS.has(collapsed)) return true;
  for (const unit of INTERJECTIONS) {
    if (unit.length >= 2 && seg.length > unit.length && seg.length % unit.length === 0
      && seg === unit.repeat(seg.length / unit.length)) return true;
  }
  return false;
}

/** A token that is never typed: interjection or a chain of short syllables. */
export function isFillerText(core) {
  const c = strip(mapHomoglyphs(core)).replace(/'/g, "");
  if (!/^[a-z-]+$/.test(c)) return false;
  const segs = c.split("-").filter(Boolean);
  if (segs.length === 0) return false;
  if (segs.every(isInterjection)) return true;
  return segs.length >= 2 && segs.every((s) => s.length <= 3);
}

// --- tokenizing a line -------------------------------------------------------

const CORE_CHAR = /[\p{L}\p{N}'-]/u;
const HAS_ALNUM = /[\p{L}\p{N}]/u;
const SINGLE_LETTER = /^\p{L}$/u;

function splitChunk(chunk) {
  let a = 0;
  let b = chunk.length;
  while (a < b && !CORE_CHAR.test(chunk[a])) a++;
  while (b > a && !CORE_CHAR.test(chunk[b - 1])) b--;
  return { pre: chunk.slice(0, a), core: chunk.slice(a, b), post: chunk.slice(b) };
}

function prepareChunks(text) {
  const spaced = text
    .replace(/\s*[–—]+\s*/g, " — ")
    .replace(/([,;!?…]|\.{2,})(?=[\p{L}\p{N}])/gu, "$1 ");
  const chunks = spaced.split(/\s+/).filter(Boolean);
  const items = [];
  let depth = 0;
  let pendingPre = "";
  for (const chunk of chunks) {
    const back = depth > 0 || chunk.includes("(");
    for (const ch of chunk) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
    }
    const { pre, core, post } = splitChunk(chunk);
    if (!HAS_ALNUM.test(core)) {
      // Punctuation on its own sticks to its neighbor.
      if (items.length > 0) items[items.length - 1].post += ` ${chunk}`;
      else pendingPre += `${chunk} `;
      continue;
    }
    items.push({ pre: pendingPre + pre, core, post, back });
    pendingPre = "";
  }
  return items;
}

// 3+ consecutive single letters are one spaced-out word.
function mergeSpacedLetters(items) {
  const out = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    if (!it.back && SINGLE_LETTER.test(it.core)) {
      let j = i;
      while (j < items.length && !items[j].back && SINGLE_LETTER.test(items[j].core)) j++;
      if (j - i >= 3) {
        const run = items.slice(i, j);
        out.push({
          pre: run[0].pre,
          core: run.map((r) => r.core).join(" "),
          post: run[run.length - 1].post,
          back: false,
          spaced: true,
        });
        i = j;
        continue;
      }
    }
    out.push(it);
    i++;
  }
  return out;
}

function makeWord(item) {
  const fields = makeWordFields(item.spaced ? item.core.replace(/ /g, "") : item.core);
  if (item.spaced) {
    const letters = item.core.split(" ");
    for (const h of holdsOf([letters.join(" ")])) fields.holds.add(h);
  }
  return {
    kind: "word",
    text: item.core,
    pre: item.pre,
    post: item.post,
    wordIndex: -1,
    ...fields,
  };
}

function buildTokens(text) {
  const items = mergeSpacedLetters(prepareChunks(text));
  return items.map((item) => {
    if (item.back) return { kind: "backing", text: item.core, pre: item.pre, post: item.post };
    if (!item.spaced && isFillerText(item.core)) {
      return { kind: "filler", text: item.core, pre: item.pre, post: item.post };
    }
    return makeWord(item);
  });
}

// --- meta lines --------------------------------------------------------------

function isMetaLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^\[[^\]]*\]$/.test(t)) return true;
  if (/^[\p{L}\p{N}_][\p{L}\p{N}_ ]*:$/u.test(t)) return true;
  if (/^\(?\s*x\s*\d+\s*\)?$/i.test(t)) return true;
  return false;
}

// --- LRC ---------------------------------------------------------------------

/** `[mm:ss.xx]text` lines to `{ms,text}[]` sorted by time (multi-stamp aware). */
export function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc ?? "").split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (stamps.length === 0) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of stamps) {
      out.push({ ms: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

// --- parse -------------------------------------------------------------------

/**
 * @param {{text?:string, synced?:Array<{ms:number,text:string}>}} input
 * @returns {{lines:Array<{ms:number|null,endMs:number|null,text:string,tokens:object[],signature:string}>, words:object[]}}
 */
export function parseLyrics({ text, synced } = {}) {
  const useSynced = Array.isArray(synced) && synced.length > 0;
  const source = useSynced
    ? synced.map((e, i) => ({
        ms: e.ms,
        endMs: i + 1 < synced.length ? synced[i + 1].ms : null,
        text: String(e.text ?? ""),
      }))
    : String(text ?? "").split(/\r?\n/).map((t) => ({ ms: null, endMs: null, text: t }));

  const lines = [];
  const words = [];
  for (const entry of source) {
    const cleaned = cleanText(entry.text).trim();
    if (isMetaLine(cleaned)) continue;
    const tokens = buildTokens(cleaned);
    if (tokens.length === 0) continue;
    const lineIndex = lines.length;
    const lineWords = [];
    tokens.forEach((tok, tokenIndex) => {
      tok.line = lineIndex;
      tok.tokenIndex = tokenIndex;
      if (tok.kind === "word") {
        tok.wordIndex = words.length;
        words.push(tok);
        lineWords.push(tok);
      }
    });
    lines.push({
      ms: entry.ms,
      endMs: entry.endMs,
      text: cleaned,
      tokens,
      signature: lineWords.map((w) => w.key).join(" "),
    });
  }
  return { lines, words };
}
