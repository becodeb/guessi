// No-framework unit harness for src/spotify-link.js.
// Run with: node tests/spotify-link.test.mjs  (exit 0 = all pass)

import { parseSpotifyRef, looksLikeSpotifyLink } from "../src/spotify-link.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const TRACK = "4cOdK2wGLETKBW3PvgPWqT";
const ALBUM = "1ATL5GLyefJaxhQzSPVrLX";
const PLAYLIST = "37i9dQZF1DXcBWIGoYBM5M";
const ARTIST = "0OdUWJ0sBjDrqHygGUXeCF";
const SHORT_ID = "abc123";

// --- URIs --------------------------------------------------------------------
check("uri track", parseSpotifyRef(`spotify:track:${TRACK}`), { type: "track", id: TRACK });
check("uri album", parseSpotifyRef(`spotify:album:${ALBUM}`), { type: "album", id: ALBUM });
check("uri playlist", parseSpotifyRef(`spotify:playlist:${PLAYLIST}`), { type: "playlist", id: PLAYLIST });
check("uri artist", parseSpotifyRef(`spotify:artist:${ARTIST}`), { type: "artist", id: ARTIST });
check("uri uppercase type", parseSpotifyRef(`spotify:TRACK:${TRACK}`), { type: "track", id: TRACK });
check("legacy user playlist uri", parseSpotifyRef(`spotify:user:spotify:playlist:${PLAYLIST}`), { type: "playlist", id: PLAYLIST });

// --- share URLs ---------------------------------------------------------------
check("url track", parseSpotifyRef(`https://open.spotify.com/track/${TRACK}`), { type: "track", id: TRACK });
check("url album with si", parseSpotifyRef(`https://open.spotify.com/album/${ALBUM}?si=AbC123`), { type: "album", id: ALBUM });
check("url playlist intl prefix", parseSpotifyRef(`https://open.spotify.com/intl-es/playlist/${PLAYLIST}`), { type: "playlist", id: PLAYLIST });
check("url playlist intl region", parseSpotifyRef(`https://open.spotify.com/intl-pt-BR/playlist/${PLAYLIST}`), { type: "playlist", id: PLAYLIST });
check("url artist", parseSpotifyRef(`https://open.spotify.com/artist/${ARTIST}`), { type: "artist", id: ARTIST });
check("url trailing slash", parseSpotifyRef(`https://open.spotify.com/track/${TRACK}/`), { type: "track", id: TRACK });
check("url http", parseSpotifyRef(`http://open.spotify.com/track/${TRACK}`), { type: "track", id: TRACK });
check("url host without open subdomain", parseSpotifyRef(`https://spotify.com/track/${TRACK}`), { type: "track", id: TRACK });
check("url surrounded by spaces", parseSpotifyRef(`  https://open.spotify.com/track/${TRACK}  `), { type: "track", id: TRACK });

// --- plain text is not a link --------------------------------------------------
check("plain title", parseSpotifyRef("top canciones 2025"), null);
check("artist name", parseSpotifyRef("Dua Lipa"), null);
check("empty", parseSpotifyRef(""), null);
check("null", parseSpotifyRef(null), null);

// --- malformed links -----------------------------------------------------------
check("short id rejected", parseSpotifyRef(`spotify:track:${SHORT_ID}`), null);
check("short url id rejected", parseSpotifyRef(`https://open.spotify.com/track/${SHORT_ID}`), null);
check("unknown type rejected", parseSpotifyRef(`https://open.spotify.com/episode/${TRACK}`), null);
check("non-spotify url rejected", parseSpotifyRef(`https://example.com/track/${TRACK}`), null);
check("missing id rejected", parseSpotifyRef("https://open.spotify.com/track/"), null);

// --- looksLikeSpotifyLink -------------------------------------------------------
check("looks like uri", looksLikeSpotifyLink(`spotify:track:${TRACK}`), true);
check("looks like short link", looksLikeSpotifyLink("https://spotify.link/abcDEF"), true);
check("looks like open url", looksLikeSpotifyLink(`https://open.spotify.com/track/${TRACK}`), true);
check("looks like truncated url", looksLikeSpotifyLink("https://open.spotify.com/track/"), true);
check("plain text is not a link", looksLikeSpotifyLink("top canciones"), false);
check("empty is not a link", looksLikeSpotifyLink(""), false);

console.log(`spotify-link.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
