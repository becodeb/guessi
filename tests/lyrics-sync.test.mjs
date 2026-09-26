// No-framework unit harness for src/lyrics.js's LRC synced-lyrics parsing
// (task T3, "Escuchar el fragmento"). Pure text parsing only — no network —
// but lyrics.js pulls in storage.js → config.js, whose REDIRECT_URI reads
// `window.location.origin` at module load time (same reason
// tests/storage.test.mjs stubs `window`/`localStorage` before importing).
// See tests/storage.test.mjs for that style of harness if the cache-schema
// (refetch-once-per-schema-bump) behavior ever needs its own direct coverage.
// Run with: node tests/lyrics-sync.test.mjs  (exit code 0 = all pass, non-zero = failure)

globalThis.window = { location: { origin: "http://127.0.0.1:8080", pathname: "/" } };
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
};

const { parseSyncedLyrics } = await import("../src/lyrics.js");

let passed = 0;
const failures = [];

function checkDeep(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- basic tag shapes ----------------------------------------------------------

checkDeep(
  "single tag per line",
  parseSyncedLyrics("[00:01.00]Primera línea\n[00:05.50]Segunda línea"),
  [{ ms: 1000, text: "Primera línea" }, { ms: 5500, text: "Segunda línea" }],
);

checkDeep(
  "two-digit minutes",
  parseSyncedLyrics("[01:02.34]Una línea"),
  [{ ms: 62340, text: "Una línea" }],
);

checkDeep(
  "fraction with 2 digits (hundredths)",
  parseSyncedLyrics("[00:00.50]Media segundo"),
  [{ ms: 500, text: "Media segundo" }],
);

checkDeep(
  "fraction with 3 digits (milliseconds)",
  parseSyncedLyrics("[00:00.500]Media segundo también"),
  [{ ms: 500, text: "Media segundo también" }],
);

checkDeep(
  "no fraction at all",
  parseSyncedLyrics("[00:10]Sin fracción"),
  [{ ms: 10000, text: "Sin fracción" }],
);

// --- multiple tags per line (repeated chorus stamped at each occurrence) -----

checkDeep(
  "multiple tags on one line produce one entry per tag",
  parseSyncedLyrics("[00:12.00][00:45.00]Estribillo repetido"),
  [{ ms: 12000, text: "Estribillo repetido" }, { ms: 45000, text: "Estribillo repetido" }],
);

// --- empty / pause lines ---------------------------------------------------------

checkDeep(
  "a timed line with no text after the tag is dropped",
  parseSyncedLyrics("[00:01.00]Hola\n[00:03.00]\n[00:05.00]Chau"),
  [{ ms: 1000, text: "Hola" }, { ms: 5000, text: "Chau" }],
);

checkDeep(
  "a truly blank line (no tag at all) is dropped",
  parseSyncedLyrics("[00:01.00]Hola\n\n[00:05.00]Chau"),
  [{ ms: 1000, text: "Hola" }, { ms: 5000, text: "Chau" }],
);

// --- metadata tags (`[length: 03:45]`, `[ar:Artist]`, …) are ignored --------------

checkDeep(
  "a length metadata tag never becomes a lyric line",
  parseSyncedLyrics("[length: 03:45]\n[00:01.00]Hola"),
  [{ ms: 1000, text: "Hola" }],
);

checkDeep(
  "an artist/title metadata tag never becomes a lyric line",
  parseSyncedLyrics("[ar:Artista de prueba]\n[ti:Canción de prueba]\n[00:02.00]Hola"),
  [{ ms: 2000, text: "Hola" }],
);

// --- ordering ------------------------------------------------------------------

checkDeep(
  "output is sorted chronologically even if the source wasn't",
  parseSyncedLyrics("[00:10.00]Después\n[00:01.00]Antes"),
  [{ ms: 1000, text: "Antes" }, { ms: 10000, text: "Después" }],
);

// --- degenerate input ------------------------------------------------------------

checkDeep("null input → empty array", parseSyncedLyrics(null), []);
checkDeep("undefined input → empty array", parseSyncedLyrics(undefined), []);
checkDeep("empty string → empty array", parseSyncedLyrics(""), []);
checkDeep("plain untagged text → empty array", parseSyncedLyrics("Solo texto plano\nsin marcas de tiempo"), []);

check("result is always an array", Array.isArray(parseSyncedLyrics(null)), true);

// --- summary -----------------------------------------------------------------

console.log(`lyrics-sync.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
