## Exploration: song-games — Song Guessing Games on the User's Spotify Library

> Greenfield app. No application code exists yet; this is a pre-proposal
> structuring of the idea against verified 2026 Spotify platform constraints.
> Product decisions in the brief are treated as fixed; this document refines
> and structures them into an implementable direction. No application code is
> written here.

### Problem & Target User

The user wants a **personal** web toy to play song-identification games against
the music they actually know — pulled from their own Spotify library, not a
global database. Target user: a Spanish-speaking individual (UI copy in neutral
Spanish; code and SDD artifacts in English), using the app alone on desktop
Chrome.

The core loop is recognition under degraded information: a tiny audio clip, a
blurred cover, or a year guess — each with a "reveal more" mechanic that trades
effort for certainty.

### Current State

- Project `de-oido` is greenfield: only `openspec/config.yaml`, `.gitignore`,
  `.atl/` exist. No `src/`, no HTML/CSS/JS, no package.json, no test runner.
- Stack (from `openspec/config.yaml`): vanilla HTML/CSS/JS ES modules, no
  framework, no bundler, served by a local static server. `strict_tdd: false`.
- `openspec/specs/` is empty — main specs do not exist yet; this change will
  seed them via delta specs later.
- Therefore "affected areas" below are **planned modules to be created**, not
  existing files.

### The Three Games as Concrete User Flows

**Game 1 — 0.1s clip (audio, Premium):**
1. System picks a random track from the library.
2. `Play` → user hears the first 0.1s (accumulated clip length).
3. `+0.1s` → clip length grows by 100ms; `Play` now plays the longer clip.
4. `Next` → pick another random track; clip length resets to 0.1s.
5. Guess: (a) **title** (normalized, accent/punctuation/typo-tolerant);
   (b) **ALL credited artists** — one input per slot; a correct guess fills a
   slot; (c) **album** — when correctly guessed, the cover image appears.

**Game 2 — album from a blurred cover (metadata only, Free OK):**
1. System picks a random album/EP/single present in the library.
2. Cover shown blurred; each click reduces `filter: blur()` by a step.
3. Guess: **album name** + **owner artist(s)**. On solve: unblur + reveal
   per-track guess fields for **every** track (track name + featured artists /
   "who else sings on it"). Visually mark which tracks are in the user's
   library (songs they should know) vs not.
4. `Next album` → new random album.

**Game 3 — release-year (bonus, audio, Premium):**
1. Same 0.1s clip mechanic as Game 1.
2. Guess the **release year** with `older / newer` feedback plus a
   close/far distance hint (e.g., "+12 / −3 / very close").

### Library-Building Flow

**Import sources (all read-only):**
- Playlists: `GET /me/playlists` → for each, `GET /playlists/{id}/items`
  (NOT `/tracks`, which now 403s for new apps).
- Liked songs: `GET /me/tracks`.
- Search: `GET /search?type=track` (for adding songs not in library).

**Selection UX:** import a source into a *pending* list, then the user checks
individual tracks to add to "songs I know". Multi-select with a "add all" aid.

**"Songs I know" operationally:** the curated subset of `track.id`s the user
explicitly selected. It is the random pool for Games 1 & 3, and the membership
set that marks album tracks in Game 2.

**Dedupe:** by `track.id` (Spotify track URIs are globally unique). Albums
present = the set of `album.id` across selected tracks.

**localStorage data model (direction):**
- `library`: `{ version, fetchedAt, tracks: { [trackId]: {id, name, artists:[{id,name}], album:{id,name,release_date,images}, duration_ms} }, albums: { [albumId]: {id, name, artists, release_date, images, total_tracks} } }`
- Maps keyed by id give O(1) dedupe and lookups; `images` URLs are stored but
  flagged perishable (see Risks).
- Cover images: store `fetchedAt` (or `urlExpiresAt` if a hint exists) to
  decide lazy re-fetch; on a broken image, re-request the album/cover.

### Playback Architecture Direction (SDK-only)

`preview_url` (30s previews) was removed for new apps (2024-11-27) → **no
preview fallback exists**. Audio MUST come from the **Spotify Web Playback SDK**.

**Engine direction (`player.js`):**
- Create `new Spotify.Player({name, getOAuthToken, volume})`; `connect()`.
- Capture `device_id` from the `ready` event.
- To play a specific track from position: `PUT /me/player/play?device_id=X`
  with `{ uris: ["spotify:track:ID"], position_ms: 0 }`.
- **Clip control:** on `Play`, `seek(0)` + `resume()`; poll
  `player.getCurrentState().position` (~50ms `setInterval`) and `pause()` when
  `position >= targetMs` (100ms × taps). Game 3 uses the same clip path.
- **Prime-on-select (recommended refinement):** during `Next`, preload the
  chosen track (connect + activate + `PUT play` then immediate pause) so `Play`
  only needs `seek(0)+resume` — minimizes start latency.
- **Activation gesture:** the `Play` click IS the user gesture required by
  autoplay/encrypted-media policy; `resume()` must fire synchronously in the
  handler.
- **Degradation (Free / non-Premium):** listen for `account_error` and
  `403 PREMIUM_REQUIRED` on the play endpoint; show a clear banner that Games 1
  & 3 are unavailable while Library + Game 2 remain fully usable. Do **not**
  let audio failure break the app.

**Latency reality (key constraint):** SDK connect/seek/network-decode latency
is typically 100–500ms, larger than the 100ms clip. The audible window will
therefore be somewhat longer than 0.1s. This is acceptable — even desirable —
because the "first instant" of a song (transient/attack) is exactly what the
game tests; we tolerate the imprecision rather than fighting it. Flagged as a
risk to confirm at runtime.

### Matching Strategy Direction (`match.js` — pure, no DOM)

- **Normalize:** lowercase → NFD + strip combining marks (diacritics) → strip
  punctuation via `[^\p{L}\p{N}\s]` → collapse whitespace.
- **Aliases:** before compare, strip parentheticals and edition suffixes —
  `(feat. …)`, `(featuring …)`, `(remaster)`, `(deluxe)`, `(explicit)`,
  `(deluxe edition)` — and trailing ` - remaster` / ` - expanded`. Accept a
  guess if it matches **either** the raw-normalized **or** the alias-normalized
  target.
- **Typo tolerance:** Levenshtein distance threshold scaled to length, e.g.
  `max(1, floor(len/10))`; small for short titles.
- **Per-artist slot matching:** each credited artist compared independently and
  order-independently; a correct guess fills one slot; the song is solved only
  when **all** credited artists are matched. One input per slot; wrong input
  does not consume a slot permanently (allow correction).
- **Album name match:** same normalization + alias (edition suffixes).

### Album Flow Data Needs (`album-game.js`)

- Pick a random `albumId` from `library.albums`.
- **Tracklist:** `GET /albums/{id}/tracks` (paged, max 50; paginate because some
  albums/collections exceed 50 tracks).
- **Feature detection:** for each track, `track.artists − album.artists`
  (by `artist.id`) = featured/"who else sings on it" artists.
- **Library-membership marking:** `track.id ∈ library.tracks` → "you should know
  this" vs not.
- **Cache:** store album tracklist + cover URL in localStorage keyed by
  `albumId` (cover marked perishable).

### Affected Areas (planned modules — none exist yet)

- `src/auth.js` — PKCE authorize/refresh, token storage, re-login on `invalid_grant`.
- `src/spotify-api.js` — fetch wrapper; rate-limit (429 / `Retry-After` /
  `QUOTA_EXCEEDED`) backoff; `fields` paging.
- `src/player.js` — Web Playback SDK engine; clip control; premium detection.
- `src/library.js` — import (playlists/liked/search), selection, dedupe,
  localStorage persistence.
- `src/match.js` — normalization + alias + Levenshtein (pure, unit-testable).
- `src/storage.js` — localStorage schema + perishable cover handling.
- `src/games/clip-game.js`, `src/games/album-game.js`, `src/games/year-game.js`.
- `index.html` / `src/main.js` / `styles.css` — shell + Spanish UI copy.

### Approaches (key forks)

1. **Prime-on-select + seek/resume + poll-pause (RECOMMENDED)** — preload track
   on `Next`, `Play` only seeks/resumes, poll to pause at targetMs.
   - Pros: lowest audible start latency; clean activation-gesture fit; same path
     for Games 1 & 3.
   - Cons: more state to manage; latency still exceeds 0.1s (accepted).
   - Effort: Medium.

2. **Lazy connect per Play** — connect/load only when `Play` is tapped.
   - Pros: simpler state; less to preload.
   - Cons: each Play pays full SDK latency; clip effectively longer/more
     variable; gesture must span full connect.
   - Effort: Low.

3. **Matching: normalize + alias + Levenshtein (RECOMMENDED)**.
   - Pros: tolerant of case/accents/punctuation/typos; predictable; pure &
     testable.
   - Cons: threshold tuning for very short titles; aliases need curation.
   - Effort: Low–Medium.

4. **Matching: exact-normalized only** (no typo tolerance).
   - Pros: trivial.
   - Cons: frustrating UX for minor typos; not recommended.
   - Effort: Low.

5. **Library storage: id-keyed maps + perishable cover metadata (RECOMMENDED)**.
   - Pros: O(1) dedupe/lookup; explicit cover expiry handling.
   - Cons: schema migration if `version` changes.
   - Effort: Low.

6. **Eager import + metadata cache, lazy cover refresh (RECOMMENDED)** vs
   on-demand fetch per game.
   - Pros (eager): fewer live calls, less rate-limit exposure in-game.
   - Cons: larger localStorage; cover staleness handled separately.
   - Effort: Medium.

### Recommendation

Adopt the recommended forks above. Seed `openspec/specs/` with domains
`library`, `playback`, `matching`, `games` (or a single `song-games` domain as
the orchestrator prefers) via delta specs in `sdd-spec`.

**In scope:** 3 games; library builder (playlists + liked + search); SDK-only
playback engine with clip control; premium degradation; normalization/alias/
Levenshtein matching; localStorage persistence; Spotify auth via PKCE.

**Out of scope / non-goals:** NO backend; NO server-side secrets (client_id
only, PKCE); NO Spotify writes beyond playback control (no playlist
create/modify, no library writes); NO recommendations / audio-features /
audio-analysis / related-artists (removed for new apps); NO multi-user accounts
or social/sharing; NO server; NO framework/bundler.

### Risks & Open Questions (carry into proposal)

1. **Token expiry** — refresh tokens expire after 6 months (2026); on
   `invalid_grant` the user must re-login. Need silent refresh + graceful
   re-auth UI.
2. **Cover URL expiry** — image URLs live < 1 day; treat as perishable,
   re-fetch on broken/stale.
3. **SDK latency vs 0.1s clip** — audible window longer than requested;
   confirm acceptable at runtime; document the tolerance.
4. **Blurred-cover reveal (Game 2)** — stepped CSS `blur()` reduction + unblur
   on solve; implementation detail but worth a small design note.
5. **Rate limits** — Dev Mode = 5 allowlisted users, rolling 30s window,
   `429`+`Retry-After`+`QUOTA_EXCEEDED`. Need fetch wrapper with backoff and a
   user-visible "slow down" state.
6. **No test runner** — `strict_tdd: false`, no framework. Matching logic is
   pure and SHOULD still be verified (a tiny browser/Node assert harness is
   possible without a framework); full audio/SDK flows can only be verified
   manually. Flag as a verification limit.
7. **CORS preflight uncertainty** — one 2026-07 community report of
   `api.spotify.com` CORS issues; verify at runtime (Web API is historically
   CORS-enabled for browsers).
8. **iOS no auto-start after transfer** — known SDK limitation; document.
9. **Redirect URI** — `localhost` prohibited; dev MUST use
   `http://127.0.0.1:PORT`; prod needs an HTTPS callback.

### Ready for Proposal

**Yes.** The idea is well-specified and the architecture forks are resolved.
The orchestrator should proceed to `sdd-propose`, then `sdd-spec` (seed delta
specs for the domains above). Before/while proposing, confirm two
user-facing choices the brief left open: (a) the exact blur-step count and
reveal feel for Game 2, and (b) whether the matching typo-tolerance threshold
should be strict or lenient by default. Neither blocks the proposal.
