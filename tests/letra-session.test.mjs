// No-framework unit harness for src/letra-session.js and the snapshot/restore
// pairs of the typing engine and the queue.
// Run with: node tests/letra-session.test.mjs  (exit code 0 = all pass)
// Every lyric below is invented.

import { parseLyrics } from "../src/lyrics-parse.js";
import { createTypingGame } from "../src/lyrics-typing.js";
import { createQueue, restoreQueue } from "../src/lyrics-queue.js";
import {
  encodeHow, decodeHow, lyricsSignature, compactTrack, expandTrack, encodeSong, decodeSong,
  buildSession, parseSession, sessionSummary, SESSION_TTL_MS, SESSION_VERSION,
} from "../src/letra-session.js";

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else failures.push(`${name}: expected ${e}, got ${a}`);
}

const TEXT = [
  "luna de papel sobre el mar",
  "luna de papel sobre el mar",
  "canta la noche sin hablar",
  "nadie sabe adonde va",
].join("\n");
const parse = (text = TEXT) => parseLyrics({ text });
const game = (text = TEXT) => createTypingGame(parse(text));
const roundTrip = (v) => JSON.parse(JSON.stringify(v));

// --- how codes ----------------------------------------------------------------
{
  const how = [null, "typed", "hint", "line", "repeat", "giveup"];
  check("how: encoded one character per word", encodeHow(how), ".thlrg");
  check("how: round trip", decodeHow(encodeHow(how)), how);
  check("how: unknown character", decodeHow(".tx"), null);
  check("how: not a string", decodeHow(42), null);
}

// --- signature ----------------------------------------------------------------
{
  const a = lyricsSignature(parse());
  check("signature: stable", lyricsSignature(parse()), a);
  check("signature: starts with the word count", a.startsWith(`${parse().words.length}:`), true);
  check("signature: one word changed", lyricsSignature(parse(TEXT.replace("noche", "tarde"))) !== a, true);
  check("signature: a word added", lyricsSignature(parse(`${TEXT}\nuna mas`)) !== a, true);
  check("signature: boundaries matter", lyricsSignature({ words: [{ text: "ab" }, { text: "c" }] })
    !== lyricsSignature({ words: [{ text: "a" }, { text: "bc" }] }), true);
  check("signature: no lyrics", lyricsSignature(null).startsWith("0:"), true);
}

// --- engine round trip ----------------------------------------------------------
{
  const g = game();
  g.type("luna de papel sobre el mar "); // line 1 done, line 2 repeats it
  g.nextWord(); // skip one on purpose
  g.hint(); // one hint letter on the cursor word
  g.hint();
  const snap = roundTrip(g.snapshot());
  const h = game();
  check("engine: restore accepts its own snapshot", h.restore(snap), true);
  check("engine: stats equal", h.stats(), g.stats());
  check("engine: cursor", h.cursor(), g.cursor());
  check("engine: hint level", h.hintLevel(h.cursor()), g.hintLevel(g.cursor()));
  check("engine: hint text", h.hintText(h.cursor()), g.hintText(g.cursor()));
  const total = parse().words.length;
  const same = Array.from({ length: total }, (_, i) => h.howRevealed(i) === g.howRevealed(i) && h.isRevealed(i) === g.isRevealed(i));
  check("engine: every word the same", same.every(Boolean), true);
  check("engine: chorus repeat kept", h.howRevealed(6), "repeat");
  check("engine: streak", h.streak(), g.streak());
  check("engine: buffer starts empty", h.buffer(), "");
  // And it plays on from there like the original.
  const evG = g.type("papel");
  const evH = h.type("papel");
  check("engine: same events afterwards", evH.map((e) => e.type), evG.map((e) => e.type));
  check("engine: same state afterwards", h.snapshot(), g.snapshot());
}

// --- restored progress is not new typing ------------------------------------------
{
  const g = game();
  g.type("luna de papel sobre el mar ");
  g.setBuffer("cant"); // half-typed word: not kept
  const snap = roundTrip(g.snapshot());
  const h = game();
  h.restore(snap);
  check("restore: half-typed word is not kept", h.buffer(), "");
  check("restore: best streak restored", h.stats().bestStreak, g.stats().bestStreak);
  check("restore: not done", h.isDone(), false);
  const done = h.type("canta la noche sin hablar nadie sabe adonde va");
  check("restore: finishing still emits done once", done.filter((e) => e.type === "done").length, 1);
}

// --- jumps, misses, give up -----------------------------------------------------------
{
  const g = game("uno dos tres cuatro cinco seis siete ocho");
  g.type("tres "); // typed ahead of the cursor: a jump
  g.type("zzzz "); // a miss
  const snap = roundTrip(g.snapshot());
  const h = game("uno dos tres cuatro cinco seis siete ocho");
  h.restore(snap);
  check("restore: jumps", h.stats().jumps, 1);
  check("restore: misses", h.stats().misses, g.stats().misses);
  check("restore: the skipped words stay open", h.isRevealed(0), false);
  check("restore: the jumped word stays revealed", h.isRevealed(2), true);

  g.giveUp();
  const fin = game("uno dos tres cuatro cinco seis siete ocho");
  fin.restore(roundTrip(g.snapshot()));
  check("give up: done after restore", fin.isDone(), true);
  check("give up: cursor is -1", fin.cursor(), -1);
  check("give up: given up count", fin.stats().givenUp, g.stats().givenUp);
  check("give up: no second done event", fin.setBuffer("x").length, 0);
}

// --- hints and confirmed letters ---------------------------------------------------------
{
  const g = game("hola mundo cruel adios ahora siempre luego");
  g.hint();
  g.hint();
  g.type("h"); // retyping the first hint letter confirms it
  const snap = roundTrip(g.snapshot());
  check("hints: sparse in the snapshot", Object.keys(snap.hints), ["0"]);
  const h = game("hola mundo cruel adios ahora siempre luego");
  h.restore(snap);
  check("hints: level", h.hintLevel(0), 2);
  check("hints: parts", h.hintParts(0), g.hintParts(0));
}

// --- restore refuses what does not fit ----------------------------------------------------
{
  const g = game();
  g.type("luna ");
  const snap = roundTrip(g.snapshot());
  const other = game("uno dos tres cuatro cinco seis siete");
  const before = JSON.stringify(other.snapshot());
  check("mismatch: another word count", other.restore(snap), false);
  check("mismatch: game untouched", JSON.stringify(other.snapshot()), before);
  check("mismatch: null", game().restore(null), false);
  check("mismatch: unknown mode", game().restore({ ...snap, how: snap.how.map((m) => (m ? "magic" : m)) }), false);
  const odd = game();
  odd.restore({ ...snap, cursor: 0, hints: { 99: 3, x: 2, 1: -4 }, streak: -2, misses: "a" });
  check("mismatch: bad cursor falls back to the first open word", odd.cursor(), 1);
  check("mismatch: junk counters become zero", [odd.stats().misses, odd.streak(), odd.hintLevel(1)], [0, 0, 0]);
}

// --- queue ------------------------------------------------------------------------------------
{
  const tracks = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}` }));
  let k = 0;
  const q = createQueue(tracks, { startIndex: 2, rng: () => [0.9, 0.1, 0.5][k++ % 3] });
  q.next();
  const plain = restoreQueue(roundTrip(q.snapshot()));
  check("queue: plain restore: same order", plain.tracks().map((t) => t.id), q.tracks().map((t) => t.id));
  check("queue: plain restore: current", plain.current().id, "t3");
  check("queue: plain restore: shuffle off", plain.isShuffled(), false);

  q.setShuffle(true);
  const snap = roundTrip(q.snapshot());
  const s = restoreQueue(snap);
  check("queue: shuffled restore: same order", s.tracks().map((t) => t.id), q.tracks().map((t) => t.id));
  check("queue: shuffled restore: index", s.index(), q.index());
  check("queue: shuffled restore: shuffle on", s.isShuffled(), true);
  s.setShuffle(false);
  check("queue: shuffle off brings back the original order around the same song",
    s.tracks().map((t) => t.id), ["t0", "t1", "t2", "t3", "t4", "t5"]);
  check("queue: and keeps the current song", s.current().id, "t3");
  check("queue: next still works", s.next().id, "t4");

  const bad = (patch) => restoreQueue({ ...snap, ...patch });
  check("queue: order with a stranger", bad({ order: ["t0", "t1", "t2", "t3", "t4", "zz"] }), null);
  check("queue: order with a repeat", bad({ order: ["t0", "t0", "t2", "t3", "t4", "t5"] }), null);
  check("queue: order too short", bad({ order: ["t0"] }), null);
  check("queue: index out of range", bad({ index: 9 }), null);
  check("queue: index not a number", bad({ index: "1" }), null);
  check("queue: no tracks", restoreQueue({ tracks: [], order: [], index: 0 }), null);
  check("queue: nothing", restoreQueue(undefined), null);
}

// --- tracks ---------------------------------------------------------------------------------------
{
  const full = {
    id: "a1", uri: "spotify:track:a1", name: "Una canción", duration_ms: 200000,
    artists: [{ id: "x", name: "Nadie", uri: "spotify:artist:x" }, { name: "Alguien" }],
    album: { id: "al", name: "Disco", release_date: "2020", images: [{ url: "u1", width: 640, height: 640 }, { url: "u2" }] },
    popularity: 50,
  };
  const c = compactTrack(full);
  check("track: compact keeps only what is shown", Object.keys(c).sort(), ["album", "artists", "id", "images", "ms", "name", "uri"]);
  check("track: artist names", c.artists, ["Nadie", "Alguien"]);
  check("track: image without a size", c.images, [{ url: "u1", width: 640 }, { url: "u2" }]);
  const back = expandTrack(roundTrip(c));
  check("track: expand: id and uri", [back.id, back.uri], ["a1", "spotify:track:a1"]);
  check("track: expand: artists as objects", back.artists, [{ name: "Nadie" }, { name: "Alguien" }]);
  check("track: expand: album and duration", [back.album.name, back.album.images.length, back.duration_ms], ["Disco", 2, 200000]);
  check("track: uri rebuilt from the id", compactTrack({ id: "q" }).uri, "spotify:track:q");
}

// --- a whole session -------------------------------------------------------------------------------------
const NOW = Date.UTC(2026, 10, 8, 20, 0, 0);
function sample() {
  const tracks = ["a", "b", "c"].map((id) => ({ id, name: `Canción ${id}`, artists: [{ name: "Nadie" }], album: { name: "Disco", images: [{ url: `u-${id}`, width: 300 }] }, duration_ms: 1000 }));
  const q = createQueue(tracks, { startIndex: 1 });
  const g = game();
  g.type("luna de papel ");
  g.hint();
  return {
    q,
    session: buildSession({
      queue: q.snapshot(), repeat: true, now: NOW,
      songs: {
        b: { sig: lyricsSignature(parse()), engine: g.snapshot(), pos: 42500.7, playId: "play-1", t0: NOW - 60000, activeMs: 31000 },
        zz: { sig: "x", engine: g.snapshot(), pos: 1 }, // not in the queue
      },
    }),
    g,
  };
}
{
  const { session, g } = sample();
  check("session: version and time", [session.v, session.savedAt], [SESSION_VERSION, NOW]);
  check("session: only songs of the queue", Object.keys(session.songs), ["b"]);
  check("session: how is one string", typeof session.songs.b.how, "string");
  check("session: how has one character per word", session.songs.b.how.length, parse().words.length);
  check("session: hints are sparse", session.songs.b.hints, { 3: 1 });
  const parsed = parseSession(roundTrip(session), NOW + 1000);
  check("parse: repeat", parsed.repeat, true);
  check("parse: queue position", [parsed.queue.index, parsed.queue.shuffle], [1, false]);
  const q = restoreQueue(parsed.queue);
  check("parse: queue plays", q.current().id, "b");
  const song = parsed.songs.b;
  check("parse: song identity", [song.playId, song.t0, song.activeMs, song.pos], ["play-1", NOW - 60000, 31000, 42501]);
  const h = game();
  check("parse: engine restores", h.restore(song.engine), true);
  check("parse: same progress", h.snapshot(), roundTrip(g.snapshot()));
  const sum = sessionSummary(parsed);
  check("summary", [sum.track.name, sum.number, sum.size], ["Canción b", 2, 3]);
}

// --- expiry, version, corruption --------------------------------------------------------------------------------
{
  const { session } = sample();
  check("expiry: just inside the window", parseSession(roundTrip(session), NOW + SESSION_TTL_MS) !== null, true);
  check("expiry: dropped after 7 days", parseSession(roundTrip(session), NOW + SESSION_TTL_MS + 1), null);
  check("version: another version", parseSession({ ...session, v: 2 }, NOW), null);
  check("corrupt: null", parseSession(null, NOW), null);
  check("corrupt: a string", parseSession("{oops", NOW), null);
  check("corrupt: an array", parseSession([], NOW), null);
  check("corrupt: no savedAt", parseSession({ ...session, savedAt: undefined }, NOW), null);
  check("corrupt: tracks not a list", parseSession({ ...session, tracks: {} }, NOW), null);
  check("corrupt: a track without id", parseSession({ ...session, tracks: [{ name: "x" }] }, NOW), null);
  check("corrupt: order with a stranger", parseSession({ ...session, order: ["a", "b", "q"] }, NOW), null);
  check("corrupt: index out of range", parseSession({ ...session, index: 7 }, NOW), null);
  const dropBad = parseSession({ ...session, songs: { b: { sig: "1:x", how: ".t?" }, a: "no", c: { how: "..." } } }, NOW);
  check("corrupt: bad song records are skipped, the queue survives", [dropBad !== null, Object.keys(dropBad.songs)], [true, []]);
  check("corrupt: a song of nobody is ignored", Object.keys(parseSession({ ...session, songs: { ...session.songs, ghost: session.songs.b } }, NOW).songs), ["b"]);
  check("corrupt: decodeSong needs a signature", decodeSong({ how: "..." }), null);
}

// --- a song with no progress is not written -----------------------------------------------------------------------
{
  const q = createQueue([{ id: "a" }, { id: "b" }]);
  const s = buildSession({ queue: q.snapshot(), repeat: false, songs: {}, now: NOW });
  check("empty songs: nothing stored", s.songs, {});
  check("encodeSong: minimal record has no empty fields", Object.keys(encodeSong({ sig: "1:x", engine: game().snapshot(), pos: 0 })).sort(),
    ["best", "cur", "how", "jumps", "miss", "sig", "streak"]);
}

if (failures.length > 0) {
  console.error(`letra-session.test.mjs: ${failures.length} failed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`letra-session.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
