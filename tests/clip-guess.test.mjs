// No-framework unit harness for src/clip-guess.js.
// Run with: node tests/clip-guess.test.mjs  (exit code 0 = all pass, non-zero = failure)

import {
  shareArtist, isCorrectPick, dedupeByTitleArtist, searchSuggestions,
  evaluateFreeText, eligibleTracks,
} from "../src/clip-guess.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function checkTrue(name, value) {
  check(name, Boolean(value), true);
}

function track(id, name, artists, extra = {}) {
  return { id, name, artists: artists.map((n, i) => ({ id: `${id}-a${i}`, name: n })), ...extra };
}

// --- shareArtist ---------------------------------------------------------------

{
  const a = { id: "t1", artists: [{ name: "Charly García" }] };
  const b = { id: "t2", artists: [{ name: "Charly García" }] };
  checkTrue("shareArtist: same artist name, neither side has an id", shareArtist(a, b));
}
{
  const a = { id: "t1", artists: [{ id: "ar1", name: "Spinetta" }] };
  const b = { id: "t2", artists: [{ id: "ar1", name: "Luis Alberto Spinetta" }] };
  checkTrue("shareArtist: matches by id even if names differ", shareArtist(a, b));
}
{
  const a = track("t1", "Song A", ["Fito Páez"]);
  const b = track("t2", "Song B", ["Cerati"]);
  checkTrue("shareArtist: no overlap", !shareArtist(a, b));
}

// --- isCorrectPick ---------------------------------------------------------------

{
  const answer = { id: "t1", name: "De Música Ligera", artists: [{ id: "ar1", name: "Soda Stereo" }] };
  const same = { id: "t2", name: "de musica ligera", artists: [{ id: "ar1", name: "Soda Stereo" }] };
  checkTrue("isCorrectPick: same title + same artist id, different track id", isCorrectPick(same, answer));
}
{
  const answer = track("t1", "Persiana Americana", ["Soda Stereo"]);
  const cover = track("t2", "Persiana Americana", ["Otra Banda"]);
  checkTrue("isCorrectPick: same title, different artist is NOT correct", !isCorrectPick(cover, answer));
}
{
  const answer = track("t1", "Track One", ["Artist"]);
  const other = track("t2", "Track Two", ["Artist"]);
  checkTrue("isCorrectPick: different title is NOT correct", !isCorrectPick(other, answer));
}

// --- dedupeByTitleArtist ---------------------------------------------------------

{
  const list = [
    track("t1", "Zapada", ["Bersuit"]),
    track("t2", "zapada", ["Bersuit"]), // same title + main artist, normalized
    track("t3", "Zapada", ["Otro"]), // same title, different main artist
  ];
  const out = dedupeByTitleArtist(list);
  check("dedupe: collapses same title + main artist, keeps first", out.map((t) => t.id), ["t1", "t3"]);
}

// --- searchSuggestions -----------------------------------------------------------

const pool = [
  track("t1", "De Música Ligera", ["Soda Stereo"]),
  track("t2", "Persiana Americana", ["Soda Stereo"]),
  track("t3", "Zapada", ["Bersuit Vergarabat"]),
  track("t4", "Flaca", ["Andrés Calamaro"]),
];

check("search: below 2 chars returns nothing", searchSuggestions(pool, "d"), []);
check("search: matches title (accent/case insensitive)", searchSuggestions(pool, "musica").map((t) => t.id), ["t1"]);
check("search: matches artist substring", searchSuggestions(pool, "soda").map((t) => t.id), ["t1", "t2"]);
check("search: matches artist regardless of word position", searchSuggestions(pool, "vergarabat").map((t) => t.id), ["t3"]);
{
  const big = Array.from({ length: 10 }, (_, i) => track(`b${i}`, `Canción ${i}`, ["Mismo Artista"]));
  check("search: capped at 6 results", searchSuggestions(big, "cancion").length, 6);
}

// --- evaluateFreeText --------------------------------------------------------------

{
  const answer = track("t1", "De Música Ligera", ["Soda Stereo"]);
  check("freeText: tolerant match to the answer is correct", evaluateFreeText("de musica ligera", answer, pool).result, "correct");
  check("freeText: single-character typo still correct (Levenshtein tolerance)", evaluateFreeText("de musica ligwra", answer, pool).result, "correct");
}
{
  const answer = track("t1", "De Música Ligera", ["Soda Stereo"]);
  const result = evaluateFreeText("zapada", answer, pool);
  check("freeText: matches another pool song -> wrong", result.result, "wrong");
  check("freeText: wrong carries the other track", result.track?.id, "t3");
}
{
  const answer = track("t1", "De Música Ligera", ["Soda Stereo"]);
  check("freeText: matches nothing -> unknown", evaluateFreeText("una cancion inventada", answer, pool).result, "unknown");
}
{
  // Ambiguous: text tolerant-matches the answer AND another pool song's title.
  const answer = track("t1", "Flaca", ["Andrés Calamaro"]);
  const decoy = track("t9", "Flaca", ["Otro Artista"]);
  const ambiguousPool = [answer, decoy];
  const result = evaluateFreeText("flaca", answer, ambiguousPool);
  check("freeText: ambiguous title (also matches another song) does not count as correct", result.result, "wrong");
  check("freeText: ambiguous case reports the other song", result.track?.id, "t9");
}

// --- eligibleTracks ------------------------------------------------------------------

{
  const p = [track("a", "A", []), track("b", "B", []), track("c", "C", [])];
  const out = eligibleTracks(p, ["a", "b"]);
  check("eligible: excludes recent ids when the pool allows it", out.map((t) => t.id), ["c"]);
}
{
  const p = [track("a", "A", []), track("b", "B", [])];
  const out = eligibleTracks(p, ["a", "b"]);
  check("eligible: falls back to the full pool when everything is recent", out.map((t) => t.id), ["a", "b"]);
}
{
  const p = [track("a", "A", [])];
  check("eligible: single-track pool with no recent history", eligibleTracks(p, []).map((t) => t.id), ["a"]);
}

// --- summary -----------------------------------------------------------------

console.log(`clip-guess.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
