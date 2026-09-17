// No-framework unit harness for src/storage.js (library codec + quota safety).
// Run with: node tests/storage.test.mjs  (exit code 0 = all pass, non-zero = failure)
//
// storage.js reads `window`/`localStorage` at call time, so the globals are
// stubbed before the module is imported.

const store = new Map();
let failWhen = null; // (key, value) => boolean — simulates QuotaExceededError

globalThis.window = { location: { origin: "http://127.0.0.1:8080", pathname: "/" } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (failWhen?.(k, String(v))) throw new DOMException("quota", "QuotaExceededError");
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { loadLibrary, saveLibrary } = await import("../src/storage.js");

const LIB_KEY = "deoido.v1.library";
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

function raw() {
  return JSON.parse(store.get(LIB_KEY));
}

function makeTrack(i, { albumId = `al${Math.floor(i / 10)}`, uri } = {}) {
  return {
    id: `t${i}`,
    ...(uri ? { uri } : {}),
    name: `Canción ${i}`,
    duration_ms: 180000 + i,
    artists: [{ id: `ar${i}`, name: `Artista ${i}` }],
    album: {
      id: albumId,
      name: `Álbum ${albumId}`,
      album_type: "album",
      release_date: "2019-04-01",
      total_tracks: 10,
      artists: [{ id: `ar${i}`, name: `Artista ${i}` }],
      images: [{ url: "https://i.scdn.co/image/aaa", width: 640, height: 640 }],
    },
  };
}

function makeLib(trackCount, poolCount = trackCount) {
  const tracks = {};
  const albums = {};
  for (let i = 0; i < trackCount; i++) {
    const t = makeTrack(i);
    tracks[t.id] = t;
    albums[t.album.id] = { ...t.album, fetchedAt: "2026-09-01T00:00:00.000Z", tracks: null };
  }
  return {
    version: 2,
    fetchedAt: "2026-09-01T00:00:00.000Z",
    tracks,
    albums,
    pool: Object.keys(tracks).slice(0, poolCount),
  };
}

// --- round trip keeps the in-memory shape the views expect -------------------

{
  store.clear();
  saveLibrary(makeLib(3));
  const lib = loadLibrary();
  check("round trip: version", lib.version, 2);
  check("round trip: pool", lib.pool, ["t0", "t1", "t2"]);
  check("round trip: uri rebuilt from id", lib.tracks.t0.uri, "spotify:track:t0");
  check("round trip: album nested again", lib.tracks.t0.album.name, "Álbum al0");
  check("round trip: album release_date (year game)", lib.tracks.t0.album.release_date, "2019-04-01");
  check("round trip: album images (covers)", lib.tracks.t0.album.images[0].url, "https://i.scdn.co/image/aaa");
  check("round trip: album fetchedAt (cover TTL)", lib.albums.al0.fetchedAt, "2026-09-01T00:00:00.000Z");
  check("round trip: artists", lib.tracks.t0.artists[0].name, "Artista 0");
}

// --- stored snapshot is compact (albums once, no duplicated covers) ----------

{
  store.clear();
  saveLibrary(makeLib(100));
  const snapshot = raw();
  const chars = store.get(LIB_KEY).length;
  check("compact: version 2 on disk", snapshot.version, 2);
  check("compact: track carries albumId", snapshot.tracks.t0.albumId, "al0");
  checkTrue("compact: track does not nest the album", snapshot.tracks.t0.album === undefined);
  checkTrue("compact: default uri is not stored", snapshot.tracks.t0.uri === undefined);
  check("compact: one album record per album", Object.keys(snapshot.albums).length, 10);
  checkTrue("compact: album holds the covers", snapshot.albums.al0.images.length === 1);
  checkTrue(`compact: < 250 chars per track (${Math.round(chars / 100)}/track)`, chars / 100 < 250);
}

// --- custom uri survives, pending tracks are not persisted -------------------

{
  store.clear();
  const lib = makeLib(3, 1);
  lib.tracks.t0.uri = "spotify:local:x:y";
  lib.tracks.t1.uri = "spotify:track:t1";
  saveLibrary(lib);
  const snapshot = raw();
  check("pending: only the pool is written", Object.keys(snapshot.tracks), ["t0"]);
  check("pending: albums pruned to the pool", Object.keys(snapshot.albums), ["al0"]);
  check("pending: pool unchanged", snapshot.pool, ["t0"]);
  check("uri: custom uri persisted", snapshot.tracks.t0.uri, "spotify:local:x:y");
  const reloaded = loadLibrary();
  check("uri: custom uri reloaded", reloaded.tracks.t0.uri, "spotify:local:x:y");
  check("pending: gone after reload", reloaded.tracks.t1, undefined);
  check("pending: pool track keeps its album", reloaded.tracks.t0.album.name, "Álbum al0");
}

// --- quota: retry without the re-fetchable tracklist caches ------------------

{
  store.clear();
  const lib = makeLib(2);
  lib.albums.al0.tracks = [{ id: "t0", name: "Canción 0", artists: [], duration_ms: 180000, track_number: 1 }];
  let attempts = 0;
  failWhen = (key, value) => {
    if (key !== LIB_KEY) return false;
    attempts++;
    return attempts === 1 && value.includes("track_number"); // first write too big
  };
  const result = saveLibrary(lib);
  failWhen = null;
  check("quota: second attempt wins", result.ok, true);
  check("quota: reported the tracklist drop", result.droppedTracklists, true);
  check("quota: two writes attempted", attempts, 2);
  check("quota: stored without tracklists", raw().albums.al0.tracks, null);
  check("quota: pool survived", loadLibrary().pool, ["t0", "t1"]);
}

{
  store.clear();
  const lib = makeLib(2);
  failWhen = () => true;
  const result = saveLibrary(lib);
  failWhen = null;
  check("quota: hard failure is reported (never silent)", result.ok, false);
  check("quota: nothing stored on hard failure", store.has(LIB_KEY), false);
}

// --- v1 migration: nested album copies are promoted, nothing is lost ---------

{
  store.clear();
  const v1 = {
    version: 1,
    fetchedAt: "2026-08-01T00:00:00.000Z",
    tracks: {
      t0: makeTrack(0, { albumId: "alA" }), // album copy inside the track
      t1: makeTrack(1, { albumId: "alB" }),
    },
    albums: {
      alA: { id: "alA", name: "Álbum alA", images: [{ url: "https://i.scdn.co/image/old", width: 640, height: 640 }], fetchedAt: "2026-07-01T00:00:00.000Z", tracks: [{ id: "t0", name: "Canción 0" }] },
    },
    pool: ["t0", "t1"],
  };
  store.set(LIB_KEY, JSON.stringify(v1));
  const lib = loadLibrary();
  check("v1: pool preserved", lib.pool, ["t0", "t1"]);
  check("v1: track keeps its album name", lib.tracks.t0.album.name, "Álbum alA");
  check("v1: album map wins over the track copy (covers + fetchedAt)", lib.tracks.t0.album.fetchedAt, "2026-07-01T00:00:00.000Z");
  check("v1: tracklist cache preserved", lib.tracks.t0.album.tracks.length, 1);
  check("v1: orphan album promoted from the track copy", lib.tracks.t1.album.name, "Álbum alB");
  saveLibrary(lib);
  const snapshot = raw();
  check("v1: rewritten as v2 on the next save", snapshot.version, 2);
  check("v1: two album records after compaction", Object.keys(snapshot.albums).length, 2);
}

// --- unknown versions are discarded (tokens are a separate key) --------------

{
  store.clear();
  store.set(LIB_KEY, JSON.stringify({ version: 99, tracks: { t0: {} }, albums: {}, pool: ["t0"] }));
  check("unknown version: load returns null", loadLibrary(), null);
  check("unknown version: key removed", store.has(LIB_KEY), false);
}

{
  store.clear();
  check("no library: load returns null", loadLibrary(), null);
}

// --- summary -----------------------------------------------------------------

console.log(`storage.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
