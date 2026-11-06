// Optional enrichment for the lyrics game: asks the AI router how a few
// elided words (`salgo'el`, `pa'llá`) would be written out in full, so the
// player can type them either way. Never exposed in the UI, never awaited by
// the game, and every failure is silent: the local rules always work alone.

import { addForms } from "./lyrics-parse.js";
import { loadAiForms, saveAiForms } from "./storage.js";

export const ENDPOINT = "https://ai-router.becode.com.ar/chat";
export const MAX_WORDS_PER_REQUEST = 40;
const MAX_REQUESTS = 3; // never more than 120 words for one song
const TIMEOUT_MS = 25000;
const MAX_FORMS_PER_WORD = 6;
const MAX_FORM_LENGTH = 40;

// --- candidate words -----------------------------------------------------------

/** Raw spellings with an apostrophe or a hyphen, unique, in order of appearance. */
export function candidateWords(parsed) {
  const seen = new Set();
  const out = [];
  for (const w of parsed?.words ?? []) {
    const raw = String(w.text ?? "").trim();
    if (!/['-]/.test(raw) || raw.length > 40) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

// --- prompt ----------------------------------------------------------------------

export function buildMessages(words) {
  const system = [
    "Ayudas a un juego en el que alguien escribe la letra de una canción.",
    "Recibes palabras tal como están escritas en la letra: el habla urbana latina las acorta con apóstrofes y guiones.",
    "Para cada palabra devuelve cómo se escribiría completa, tal como la diría alguien sin acortarla.",
    "Si el apóstrofe une dos palabras, devuelve las dos separadas por un espacio.",
    "Puedes dar hasta tres formas por palabra, de la más probable a la menos probable. Si una palabra ya está completa o no sabes, devuelve una lista vacía.",
    'Ejemplos inventados del formato: {"pa\'l": ["para el"], "to\'a": ["toda"], "vo\'a": ["voy a"]}',
    "Responde SOLO un objeto JSON, sin texto alrededor ni markdown. Las claves son las palabras recibidas, exactamente como llegaron.",
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(words) },
  ];
}

// --- response decoding -----------------------------------------------------------

/**
 * Turns the router's event stream body into the model's text.
 * Each token travels as `data: <token>` plus a blank line, raw and untrimmed:
 * a token may start with a space or end with a newline. So: split on
 * "\n\ndata: ", drop the first prefix by position, never trim.
 * @param {string} body
 * @returns {string}
 */
export function decodeSse(body) {
  let text = String(body ?? "");
  if (text.startsWith("data: ")) text = text.slice(6);
  let out = "";
  for (const part of text.split("\n\ndata: ")) {
    if (part.startsWith("[DONE]") && part.slice(6).trim() === "") break;
    if (part.startsWith('{"error"')) throw new Error("router error");
    out += part;
  }
  return out;
}

/** The outermost `{...}` of a reply, tolerant of fences and chatter around it. */
export function extractJson(text) {
  const raw = String(text ?? "");
  const from = raw.indexOf("{");
  const to = raw.lastIndexOf("}");
  if (from === -1 || to <= from) return null;
  try {
    const value = JSON.parse(raw.slice(from, to + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Keeps only what was asked for, as short lists of plain strings.
 * @param {object} answer parsed model reply
 * @param {string[]} asked the raw words sent
 * @returns {Record<string, string[]>} keyed by the asked spelling
 */
export function normalizeAnswer(answer, asked) {
  const byLower = new Map(asked.map((w) => [w.toLowerCase(), w]));
  const out = {};
  for (const [key, value] of Object.entries(answer ?? {})) {
    const word = byLower.get(String(key).trim().toLowerCase());
    if (!word || !Array.isArray(value)) continue;
    const forms = [];
    for (const f of value) {
      if (typeof f !== "string") continue;
      const form = f.trim();
      if (!form || form.length > MAX_FORM_LENGTH || !/[\p{L}\p{N}]/u.test(form)) continue;
      if (!forms.includes(form)) forms.push(form);
      if (forms.length >= MAX_FORMS_PER_WORD) break;
    }
    out[word] = forms;
  }
  return out;
}

// --- network -----------------------------------------------------------------------

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** One round trip. Resolves the model's text; rejects on any transport problem. */
async function ask(words, { signal, fetchFn }) {
  const guard = withTimeout(signal, TIMEOUT_MS);
  try {
    const res = await fetchFn(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: buildMessages(words) }),
      signal: guard.signal,
    });
    const type = res.headers?.get?.("content-type") ?? "";
    if (!res.ok || !type.includes("event-stream")) throw new Error("router unavailable");
    return decodeSse(await res.text());
  } finally {
    guard.done();
  }
}

/** Parses one batch; one retry when the reply is not usable JSON (the next try often lands on another model). */
async function askBatch(words, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ask(words, opts);
    const parsed = extractJson(text);
    if (parsed) return normalizeAnswer(parsed, words);
  }
  return null;
}

// --- apply ---------------------------------------------------------------------------

function applyForms(parsed, formsByWord) {
  let changed = 0;
  for (const w of parsed.words) {
    const forms = formsByWord[String(w.text ?? "").trim().toLowerCase()];
    if (forms && forms.length > 0) {
      const before = w.forms.size;
      addForms(w, forms);
      if (w.forms.size !== before) changed++;
    }
  }
  return changed;
}

/**
 * Adds AI-suggested full forms to the elided words of a parsed song.
 * Resolves how many words gained forms; never rejects.
 * @param {{words: object[]}} parsed
 * @param {{signal?: AbortSignal, fetchFn?: typeof fetch}} [opts]
 */
export async function enrichForms(parsed, { signal, fetchFn } = {}) {
  try {
    const doFetch = fetchFn ?? ((...a) => fetch(...a));
    const cache = loadAiForms();
    const lowerCache = {};
    for (const [k, v] of Object.entries(cache)) lowerCache[k.toLowerCase()] = v;

    const candidates = candidateWords(parsed);
    let changed = applyForms(parsed, lowerCache);
    const missing = candidates.filter((w) => !(w.toLowerCase() in lowerCache));

    for (let i = 0; i < missing.length && i / MAX_WORDS_PER_REQUEST < MAX_REQUESTS; i += MAX_WORDS_PER_REQUEST) {
      if (signal?.aborted) break;
      const batch = missing.slice(i, i + MAX_WORDS_PER_REQUEST);
      const answer = await askBatch(batch, { signal, fetchFn: doFetch });
      if (!answer) break;
      const fresh = {};
      for (const w of batch) fresh[w.toLowerCase()] = answer[w] ?? [];
      Object.assign(lowerCache, fresh);
      saveAiForms(lowerCache);
      changed += applyForms(parsed, fresh);
    }
    return changed;
  } catch {
    return 0; // silent by design
  }
}
