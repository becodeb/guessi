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

// --- summary -----------------------------------------------------------------
console.log(`library.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
