// No-framework unit harness for the pure shape helpers in src/spotify-api.js.
// Run with: node tests/spotify-api.test.mjs  (exit code 0 = all pass)
//
// These cover the February 2026 playlist rename: /playlists/{id}/items nests
// the track under `item`, so any code that reads a row as if it were the track
// itself loses the whole page. A 71-track playlist used to import 21 songs —
// the first page of 50 came back masked and empty.

globalThis.window = { location: { origin: "http://127.0.0.1:8080", pathname: "/" } };
globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
  clear: () => {},
  key: () => null,
  length: 0,
};

const { unwrapTrackRows, playlistTrackTotal } = await import("../src/spotify-api.js");

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const track = (id) => ({ id, name: `Canción ${id}`, type: "track", artists: [], album: { id: "al1" } });

// --- playlist rows: the new `item` key ---------------------------------------
{
  const page = { items: [{ added_at: "x", is_local: false, item: track("a") }, { item: track("b") }] };
  const out = unwrapTrackRows(page);
  check("item rows → tracks", out.tracks.map((t) => t.id), ["a", "b"]);
  check("item rows → nothing skipped", out.skipped, 0);
}

// --- playlist rows: the mirrored legacy `track` key --------------------------
{
  const page = { items: [{ added_at: "x", track: track("a") }] };
  check("legacy track key", unwrapTrackRows(page).tracks.map((t) => t.id), ["a"]);
}

// --- /me/tracks rows carry only `track` --------------------------------------
{
  const page = { items: [{ added_at: "x", track: track("liked") }] };
  check("saved-track rows", unwrapTrackRows(page).tracks.map((t) => t.id), ["liked"]);
}

// --- bare track objects (album tracklists) -----------------------------------
{
  check("bare rows", unwrapTrackRows({ items: [track("solo")] }).tracks.map((t) => t.id), ["solo"]);
}

// --- rows that cannot be imported are counted, not silently dropped ----------
{
  const page = {
    items: [
      { item: track("ok") },
      { is_local: true, item: { id: null, name: "Mi archivo.mp3", type: "track" } },
      { item: { id: "ep1", name: "Episodio", type: "episode" } },
      { item: null },
      null,
    ],
  };
  const out = unwrapTrackRows(page);
  check("only importable tracks survive", out.tracks.map((t) => t.id), ["ok"]);
  check("local + episode + empty rows are counted", out.skipped, 4);
}

// --- a masked page must not look like an empty playlist ----------------------
// This is the exact regression: `fields=items(id,name,…)` on /items returned
// rows with no keys at all. They now count as skipped, so the UI can react.
{
  const masked = { items: [{}, {}, {}] };
  const out = unwrapTrackRows(masked);
  check("masked page yields no tracks", out.tracks.length, 0);
  check("masked page is fully skipped", out.skipped, 3);
}

// --- empty / missing pages ---------------------------------------------------
{
  check("no items key", unwrapTrackRows({}).tracks.length, 0);
  check("null page", unwrapTrackRows(null).skipped, 0);
}

// --- playlist totals across the rename ---------------------------------------
{
  check("new items.total", playlistTrackTotal({ items: { total: 71 } }), 71);
  check("legacy tracks.total", playlistTrackTotal({ tracks: { total: 12 } }), 12);
  check("items wins over tracks", playlistTrackTotal({ items: { total: 71 }, tracks: { total: 20 } }), 71);
  check("zero is a real count", playlistTrackTotal({ items: { total: 0 } }), 0);
  check("unknown total", playlistTrackTotal({}), null);
  check("no playlist", playlistTrackTotal(null), null);
}

if (failures.length > 0) {
  console.error(`spotify-api.test.mjs: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`spotify-api.test.mjs: ${passed} assertions passed, 0 failed`);
