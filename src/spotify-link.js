// Pure parser for Spotify references pasted into the library search:
// share URLs (open.spotify.com, with or without the /intl-xx/ prefix) and
// URIs (spotify:type:id, legacy spotify:user:…:playlist:id).
// No DOM, no I/O — deterministic, unit-testable without a framework.

const ID = "[A-Za-z0-9]{22}";
const TYPE = "(track|album|playlist|artist)";

const URI_RE = new RegExp(`^spotify:${TYPE}:(${ID})$`, "i");
const LEGACY_PLAYLIST_URI_RE = new RegExp(`^spotify:user:[^:]+:playlist:(${ID})$`, "i");
const URL_RE = new RegExp(
  `^https?://(?:open\\.)?spotify\\.com/(?:intl-[a-z]{2,3}(?:-[a-z]{2,4})?/)?${TYPE}/(${ID})(?:[/?#].*)?$`,
  "i"
);

/**
 * Parse a pasted Spotify link or URI.
 * @param {string} input
 * @returns {{type:"track"|"album"|"playlist"|"artist", id:string}|null}
 *   The reference when the input is a well-formed link; null for plain search
 *   text (or malformed links — see `looksLikeSpotifyLink`).
 */
export function parseSpotifyRef(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const uri = raw.match(URI_RE);
  if (uri) return { type: uri[1].toLowerCase(), id: uri[2] };

  const legacy = raw.match(LEGACY_PLAYLIST_URI_RE);
  if (legacy) return { type: "playlist", id: legacy[1] };

  const url = raw.match(URL_RE);
  if (url) return { type: url[1].toLowerCase(), id: url[2] };

  return null;
}

/**
 * True when the input looks like a Spotify link even if it could not be
 * parsed (e.g. short spotify.link URLs or truncated ids). Lets the view show a
 * "cannot read this link" message instead of an empty search.
 */
export function looksLikeSpotifyLink(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return false;
  return /^spotify:/i.test(raw) || /^https?:\/\/(?:open\.)?spotify\.(?:com|link)\//i.test(raw);
}
