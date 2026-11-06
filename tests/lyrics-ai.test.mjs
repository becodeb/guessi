// No-framework unit harness for src/lyrics-ai.js (no network: a fake fetch).
// Run with: node tests/lyrics-ai.test.mjs  (exit code 0 = all pass)
// Every lyric line below is invented.

const store = new Map();
globalThis.window = { location: { origin: "http://127.0.0.1:8080", pathname: "/" } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

const {
  candidateWords, buildMessages, decodeSse, extractJson, normalizeAnswer, enrichForms, MAX_WORDS_PER_REQUEST,
} = await import("../src/lyrics-ai.js");
const { parseLyrics, acceptsWord } = await import("../src/lyrics-parse.js");

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** The router's wire format: one `data: <raw token>` event per token. */
const sse = (tokens, { done = true } = {}) =>
  tokens.map((t) => `data: ${t}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");

// --- decodeSse ----------------------------------------------------------------
check("plain tokens join", decodeSse(sse(["{", '"a"', ":", "1", "}"])), '{"a":1}');
check("a token with a leading space keeps it", decodeSse(sse(["hola", " mundo"])), "hola mundo");
check("two spaces survive (no trim)", decodeSse(sse(["a", "  b"])), "a  b");
check("a token ending in a newline does not break framing", decodeSse(sse(["{\n", '  "x": 1\n', "}"])), '{\n  "x": 1\n}');
check("stops at [DONE]", decodeSse(sse(["a", "b"]) + "data: ignored\n\n"), "ab");
check("works without [DONE]", decodeSse(sse(["a", "b"], { done: false })).startsWith("ab"), true);
check("empty body", decodeSse(""), "");
{
  let threw = false;
  try { decodeSse('data: {"error":"all providers failed"}\n\n'); } catch { threw = true; }
  check("a router error event throws", threw, true);
}

// --- extractJson ----------------------------------------------------------------
check("bare object", extractJson('{"a":["b"]}'), { a: ["b"] });
check("fenced", extractJson('```json\n{"a":["b"]}\n```'), { a: ["b"] });
check("chatter around it", extractJson('Claro:\n{"a":["b"]}\nListo.'), { a: ["b"] });
check("nested braces use the outermost", extractJson('x {"a":{"b":1}} y'), { a: { b: 1 } });
check("garbage", extractJson("no json here"), null);
check("truncated", extractJson('{"a":["b"'), null);
check("an array is not an answer", extractJson('["a"]'), null);

// --- candidates ------------------------------------------------------------------
{
  const parsed = parseLyrics({ text: "Pasa'o cuerpo y pa' ti\nPa' ti, vamo' la'o\nsolo palabras limpias" });
  const c = candidateWords(parsed);
  check("only words with ' or -", c.includes("cuerpo"), false);
  check("keeps the raw spelling", c.includes("Pasa'o"), true);
  check("unique case-insensitively", c.filter((w) => w.toLowerCase() === "pa'").length, 1);
  check("order of appearance", c[0], "Pasa'o");
}

// --- prompt ------------------------------------------------------------------------
{
  const m = buildMessages(["pa'l"]);
  check("system then user", m.map((x) => x.role), ["system", "user"]);
  check("user message is the word list", JSON.parse(m[1].content), ["pa'l"]);
  check("asks for JSON only", /SOLO un objeto JSON/.test(m[0].content), true);
}

// --- normalize -----------------------------------------------------------------------
{
  const out = normalizeAnswer({ "Pa'L": ["para el", "  ", 7, "x".repeat(80), "para el"], extra: ["no"], "to'a": "toda" }, ["pa'l", "to'a"]);
  check("matches keys case-insensitively, keyed by asked spelling", Object.keys(out), ["pa'l"]);
  check("filters junk and dupes", out["pa'l"], ["para el"]);
}

// --- enrichForms ------------------------------------------------------------------------
function fakeFetch(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return {
      ok: r.ok ?? true,
      headers: { get: () => r.type ?? "text/event-stream; charset=utf-8" },
      text: async () => r.body,
    };
  };
  fn.calls = calls;
  return fn;
}
const songOf = (text) => parseLyrics({ text });
const askedWords = (call) => JSON.parse(call.body.messages[1].content);
// A word the local rules cannot guess: an invented elision.
const ODD = "zor'ba";

{
  store.clear();
  const parsed = songOf(`Uno dos tres cuatro cinco seis\n${ODD} siete ocho nueve`);
  const word = parsed.words.find((w) => w.text === ODD);
  check("setup: the local rules do not know the AI form", acceptsWord(word, "zorrobar"), false);
  const fetchFn = fakeFetch([{ body: sse(["{", `"${ODD}"`, ": [", '"zorrobar"', "]}"]) }]);
  const changed = await enrichForms(parsed, { fetchFn });
  check("one request", fetchFn.calls.length, 1);
  check("posts to the router", fetchFn.calls[0].url, "https://ai-router.becode.com.ar/chat");
  check("sent the candidate", askedWords(fetchFn.calls[0]), [ODD]);
  check("word gained forms", changed, 1);
  check("the AI form is now accepted", acceptsWord(word, "zorrobar"), true);
  check("result is cached", JSON.parse(store.get("deoido.v1.aiForms"))[ODD], ["zorrobar"]);

  // Second song with the same word: served from cache, no request.
  const again = songOf(`${ODD} uno dos tres cuatro cinco seis`);
  const f2 = fakeFetch([{ body: "" }]);
  await enrichForms(again, { fetchFn: f2 });
  check("cached word makes no request", f2.calls.length, 0);
  check("cached forms are applied", acceptsWord(again.words[0], "zorrobar"), true);
}

// retry once when the reply is not JSON
{
  store.clear();
  const parsed = songOf(`${ODD} uno dos tres cuatro cinco`);
  const fetchFn = fakeFetch([
    { body: sse(["Lo siento, no puedo"]) },
    { body: sse(["```json\n", `{"${ODD}": ["zorrobar"]}`, "\n```"]) },
  ]);
  await enrichForms(parsed, { fetchFn });
  check("unparseable reply is retried once", fetchFn.calls.length, 2);
  check("retry result applied", acceptsWord(parsed.words[0], "zorrobar"), true);
}
{
  store.clear();
  const parsed = songOf(`${ODD} uno dos tres cuatro cinco`);
  const fetchFn = fakeFetch([{ body: sse(["nope"]) }]);
  const changed = await enrichForms(parsed, { fetchFn });
  check("gives up after one retry", fetchFn.calls.length, 2);
  check("nothing changed", changed, 0);
  check("a failed ask is not cached", store.has("deoido.v1.aiForms"), false);
}

// transport problems are silent and not retried
{
  store.clear();
  const parsed = songOf(`${ODD} uno dos tres cuatro cinco`);
  for (const [label, reply] of [
    ["network error", new Error("offline")],
    ["http 502", { ok: false, type: "text/plain", body: "bad gateway" }],
    ["json instead of a stream", { type: "application/json", body: '{"error":"x"}' }],
    ["router error event", { body: 'data: {"error":"all providers failed"}\n\n' }],
  ]) {
    const fetchFn = fakeFetch([reply]);
    const changed = await enrichForms(parsed, { fetchFn });
    check(`${label}: no throw, no change`, changed, 0);
    check(`${label}: not retried`, fetchFn.calls.length, 1);
  }
}

// at most 40 words per request
{
  store.clear();
  const words = Array.from({ length: 95 }, (_, i) => `w${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}'x`);
  const parsed = songOf(words.join(" "));
  const fetchFn = fakeFetch([{ body: sse(["{}"]) }]);
  await enrichForms(parsed, { fetchFn });
  check("batches of at most 40", fetchFn.calls.map((c) => askedWords(c).length), [40, 40, 15]);
  check("max size constant", MAX_WORDS_PER_REQUEST, 40);
  check("words answered with nothing are remembered", Object.keys(JSON.parse(store.get("deoido.v1.aiForms"))).length, 95);
}

// an aborted signal sends nothing
{
  store.clear();
  const parsed = songOf(`${ODD} uno dos tres cuatro cinco`);
  const controller = new AbortController();
  controller.abort();
  const fetchFn = fakeFetch([{ body: sse(["{}"]) }]);
  await enrichForms(parsed, { fetchFn, signal: controller.signal });
  check("aborted before start: no request", fetchFn.calls.length, 0);
}

// a song with nothing to ask makes no request
{
  store.clear();
  const fetchFn = fakeFetch([{ body: "" }]);
  const changed = await enrichForms(songOf("uno dos tres cuatro cinco seis siete"), { fetchFn });
  check("nothing to ask", [fetchFn.calls.length, changed], [0, 0]);
}

if (failures.length > 0) {
  console.error(`lyrics-ai.test.mjs: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`lyrics-ai.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
