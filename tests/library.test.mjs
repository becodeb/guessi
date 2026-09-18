// No-framework unit harness for src/library.js (the in-session shape views
// rely on). Run with: node tests/library.test.mjs  (exit code 0 = all pass)
//
// library.js reads `window`/`localStorage` at call time (through storage.js),
// so the globals are stubbed before the module is imported.

const store = new Map();

globalThis.window = { location: { origin: "http://127.0.0.1:8080", pathname: "/" } };
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const library = await import("../src/library.js");

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ALBUM_ARTISTS = [{ id: "ar1", name: "Dueña" }, { id: "ar2", name: "Invitado" }];

function makeTrack(i) {
  return {
    id: `t${i}`,
    name: `Canción ${i}`,
    duration_ms: 180000 + i,
    artists: [{ id: "ar1", name: "Dueña" }],
    album: {
      id: `al${Math.floor(i / 3)}`,
      name: `Álbum ${Math.floor(i / 3)}`,
      album_type: "album",
      release_date: "2019-04-01",
      total_tracks: 3,
      artists: ALBUM_ARTISTS,
      images: [{ url: "https://i.scdn.co/image/aaa", width: 640, height: 640 }],
    },
  };
}

// --- in-session imports carry the album artists (round album card slots) -----
// The round's album card reads the album artists to build its album-level slots
// and to auto-fill the owner on every track row. After the first reload the
// nested album comes from the albums map; right after importing it must already
// be complete, or the card would ask for the artist on every single song.

{
  library.addTracks([makeTrack(0)]);
  library.addToPool(["t0"]);
  const track = library.getRandomTrack();
  check("in-session: track album artists available", track.album.artists, ALBUM_ARTISTS);
  check("in-session: album map record keeps artists", library.getAlbums()[0].artists, ALBUM_ARTISTS);
}

// --- commitTracks: importing IS adding ---------------------------------------
// The import sheet hands back only the tracks the user kept. They must land in
// the pool directly — there is no pending step to walk through afterwards.

{
  const offered = [makeTrack(10), makeTrack(11), makeTrack(12)];
  const result = library.commitTracks(offered, ["t10", "t12"]);
  check("commit: added count", result.added, 2);
  check("commit: nothing was already known", result.already, 0);
  check("commit: kept tracks are in the pool", library.isInPool("t10") && library.isInPool("t12"), true);
  check("commit: the unchecked track stayed out", library.isInPool("t11"), false);
  check("commit: the unchecked track was not queued either", library.isPending("t11"), false);
}

// Re-committing the same source must not duplicate the pool or lie about it.
{
  const offered = [makeTrack(10), makeTrack(13)];
  const before = library.getPoolCount();
  const result = library.commitTracks(offered, ["t10", "t13"]);
  check("recommit: only the new one counts as added", result.added, 1);
  check("recommit: the known one is reported", result.already, 1);
  check("recommit: pool grew by exactly one", library.getPoolCount(), before + 1);
  check("recommit: no duplicate entry", library.getPool().filter((id) => id === "t10").length, 1);
}

// An empty selection is a no-op, not a crash or a silent full import.
{
  const before = library.getPoolCount();
  const result = library.commitTracks([makeTrack(20), makeTrack(21)], []);
  check("empty selection: nothing added", result.added, 0);
  check("empty selection: pool untouched", library.getPoolCount(), before);
}

// --- summary -----------------------------------------------------------------
console.log(`library.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
