# Design: Song-Guessing Games on the User's Spotify Library

## Technical Approach

Static SPA (vanilla ES modules, zero deps, no build step) served over a local static server at `http://127.0.0.1:PORT`. Auth via PKCE (no client secret possible in a static SPA); audio exclusively via the Spotify Web Playback SDK (`preview_url` is dead for new apps). Clip control = prime-on-select + `seek(0)`+`resume()` in the click gesture + 50ms position poll → `pause()` at `targetMs`. Library persisted as id-keyed maps in versioned localStorage with perishable covers. Three game views + library view behind a hash router in `main.js`. Matching is a pure, framework-free module. UI copy in neutral Spanish; code/artifacts in English. Maps to proposal approach; all forks from `exploration.md` adopted; specs: spotify-auth, library, playback, matching, games.

## Architecture Decisions

| # | Decision | Alternatives | Rationale |
|---|----------|--------------|-----------|
| D1 | Vanilla ES modules, hash router, no framework/bundler | React/Vite | Project constraint; toy scale; zero-dep keeps it maintainable and matches `config.yaml` |
| D2 | SDK-only audio; no preview fallback | `preview_url` | Removed for new apps (2024-11-27); no fallback exists |
| D3 | Prime-on-select + seek/resume + 50ms poll-pause | Lazy connect per Play | Lowest audible start latency; `resume()` in gesture satisfies autoplay policy; one path for Games 1 & 3 |
| D4 | PKCE + silent refresh + re-login on `invalid_grant` | Implicit flow, client secret | Static SPA cannot hold secrets; refresh tokens die at ~6 months → graceful re-login |
| D5 | id-keyed maps (`tracks`, `albums`) in localStorage | Arrays | O(1) dedupe/lookup; deterministic merge |
| D6 | Perishable covers: `fetchedAt` + lazy re-fetch on stale/broken | Trust stored URLs | Spotify image URLs expire < 1 day |
| D7 | Eager import + metadata cache, lazy cover refresh | On-demand fetch per game | Fewer live calls in-game → less 429 exposure |
| D8 | Single `apiFetch` wrapper: 401→refresh-retry, 429→`Retry-After` backoff, `QUOTA_EXCEEDED` | Per-module fetch | One rate-limit policy + one slow-down signal to UI |
| D9 | Dark-first single theme (deviation from dual-mode default) | Dual `prefers-color-scheme` | Listening/record-deck context; user preference; contrast targets: WCAG AA min, hero AAA |
| D10 | Lenient matching `max(1, floor(len/10))` cap 2 + alias strip | Exact-normalized only | Typo/alias tolerance without false positives |
| D11 | All credited artists required, slot per artist, order-independent; wrong guess never consumes a slot | First-artist-only | Spec requirement; recognition of collaborators is the game |
| D12 | Album tracklists cached by `albumId` | Refetch every round | Game 2 reveal needs full tracklists; paginate >50 |
| D13 | Single PR / single delivery unit (`size:exception`) | Chained slices | Pre-approved; greenfield rollback = revert the PR |
| D14 | No demo/mock mode | Fake tracks | Playing against the real library is the point; empty-library guide covers onboarding |

**Accepted limitations**: SDK latency (100–500ms) makes the audible window longer than `targetMs` — tolerated, pause fires at `position ≥ targetMs` + one poll interval, no compensation. iOS: no auto-start after device transfer (documented in help). Dev Mode: 5 users / 30s quota → backoff + slow-down banner. CORS: verify at runtime.

## File Tree & Module Contracts

```
index.html            Shell: <link> fonts, SDK script NOT loaded here (loaded lazily by player.js), #app root, inline SVG sprite
styles.css            Tokens, components, views, reduced-motion block
src/config.js         CLIENT_ID ("REPLACE_ME"), REDIRECT_URI "http://127.0.0.1:8080/", SCOPES (exact 8), endpoints, SDK_URL, COVER_TTL_MS
src/main.js           App shell: hash router, view mount/unmount, app state, nav, banners/toasts
src/auth.js           PKCE authorize/callback/refresh; token lifecycle; session-expired hook
src/spotify-api.js    apiFetch wrapper + typed endpoints (playlists, liked, search, album, album tracks)
src/player.js         SDK engine: init/connect/device_id, prime, playClip, stop, volume, premium detection
src/library.js        Import, selection pool, dedupe, albums set, random draws, tracklist cache
src/storage.js        Versioned localStorage schema, tokens, transient auth state, cover staleness
src/match.js          normalize/alias/Levenshtein/slots/year-hint — pure, no DOM
src/ui.js             Small helpers: el(), toast(), skeleton(), formatMs, icon(name)
src/games/clip-game.js  Game 1 view
src/games/album-game.js Game 2 view
src/games/year-game.js  Game 3 view
```

**Module contracts** (each module MUST NOT do the forbidden thing):

| Module | Public API | MUST NOT |
|--------|-----------|----------|
| `auth.js` | `authorize()`, `handleCallback()` → bool, `getAccessToken()`, `refreshToken()`, `logout()`, `isAuthenticated()`, `onSessionExpired(cb)` | touch DOM, log/emit tokens |
| `spotify-api.js` | `apiFetch(path, {method, body, params})`, `getPlaylists()`, `getPlaylistItems(id)`, `getLikedTracks()`, `searchTracks(q)`, `getAlbum(id)`, `getAlbumTracks(id)` (pages ≤50, cached), `onRateLimited(cb)` | hold app state, render |
| `player.js` | `initPlayer(getToken)`, `prime(uri)`, `playClip(targetMs, {onEnd})`, `stop()`, `setVolume(v)`, `getDeviceId()`, `isPremium()`, `onPremiumError(cb)`, `onPlayerError(cb)` | touch DOM, do HTTP (uses `apiFetch` for play endpoint) |
| `library.js` | `importFromPlaylist(id)`, `importLiked()`, `search(q)` → pending, `addToPool(ids)`, `removeFromPool(id)`, `getPool()`, `getPoolTracks()`, `getAlbums()`, `getRandomTrack()`, `getRandomAlbum()`, `getAlbumTracklist(albumId)` | render, know views |
| `storage.js` | `loadLibrary()`, `saveLibrary()`, `loadTokens()`, `saveTokens()`, `clearTokens()`, `getAuthState()/setAuthState()/clearAuthState()`, `isStaleCover(fetchedAt)` | know Spotify API |
| `match.js` | `normalize(s)`, `stripAliases(s)`, `levenshtein(a,b)`, `isMatch(guess, target)`, `matchTitle(g,t)`, `matchArtistSlots(guesses, credited)`, `matchAlbum(g,a)`, `yearHint(g,a)` | DOM, state, I/O — pure & deterministic |
| `ui.js` | `el(tag, attrs, children)`, `toast(msg, kind)`, `skeleton(rows)`, `formatMs(ms)`, `icon(name)` | business logic |
| `games/*.js` | `mount(container, ctx)`, `unmount()`; `ctx = {library, player, match, api, navigate, state}` | import each other |

## State Model & Routing

```js
// main.js — single source of truth
appState = {
  view: "login" | "library" | "hub" | "clip" | "album" | "year",
  auth: { status: "anon"|"ok"|"expired", scopes: [] },
  library: { pendingCount, poolCount, loading, slowDown, error },
  player: { status: "off"|"connecting"|"ready"|"premium-denied"|"error", deviceId, volume, playing, position, targetMs },
  game: { round, solved, clipTaps }  // per active game
}
```

Hash routes: `#/login`, `#/library`, `#/juegos`, `#/juegos/clip`, `#/juegos/album`, `#/juegos/año`; unknown → hub. `hashchange` listener; view modules own their DOM subtree (mount/unmount), router owns the top bar + banners.

## Integration Flows

### PKCE Authorization + Silent Refresh

```
[user] ──click "Iniciar sesión con Spotify"──▶ auth.authorize()
   gen code_verifier(43-128) + state → store transient (deoido.v1.auth_state)
   location = https://accounts.spotify.com/authorize
     ?client_id&response_type=code&code_challenge_method=S256
     &code_challenge&state&redirect_uri=http://127.0.0.1:8080/
[Spotify] ──redirect──▶ /?code&state
   handleCallback(): state ≠ stored → abort, clear, banner "Vuelve a iniciar sesión"
   POST /api/token {grant_type=authorization_code, code, verifier, redirect_uri}
   → save {access_token, refresh_token, expires_at=now+expires_in, scopes}
   → clear transient state → view = library
[t+~1h] apiFetch → expires_at passed OR 401
   → POST /api/token {grant_type=refresh_token} → update tokens → retry request once
[t+~6mo] refresh → invalid_grant
   → clearTokens() → session-expired banner + login view (tokens never in URLs/logs/UI)
```

`localhost` redirect MUST NOT be used — Spotify rejects it; dev uses `http://127.0.0.1:PORT` (default 8080 in `config.js`).

**Scopes** (exact 8, from `src/config.js`): `streaming`, `user-read-email`, `user-read-private`, `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`.

### Web Playback SDK Lifecycle + Clip Control

```
main (hub/audio game mount) → inject <script src=sdk.scdn.co/spotify-player.js>
onSpotifyWebPlaybackSDKReady
  → new Spotify.Player({ name: "de oído", getOAuthToken, volume })
  → player.connect()
ready {device_id} → store id (all commands target it)
account_error | autoplay_failed | 403 PREMIUM_REQUIRED (from play endpoint)
  → premium banner: audio games (1 y 3) disabled, Library + Game 2 intact
not_ready | initialization_error → error banner, app stays usable

[select / Next]  prime(uri):
   PUT /me/player/play?device_id=X  { uris:[uri], position_ms:0 } → immediate pause()
[Play click]     playClip(targetMs):
   player.seek(0) + player.resume()   ← synchronous inside the gesture handler
   setInterval 50ms → getCurrentState().position
   position ≥ targetMs (100ms × taps) → pause() + clearInterval + onEnd
[+0,1 s]  targetMs += 100   (clip bar UI reflects targetMs)
[Next]    reset targetMs = 100, draw another track (avoid immediate repeat), prime it
[exit game] stop(): pause + clearInterval + leave device active (session kept for reuse)
```

### Data Fetch & Rate-Limit Strategy

```
apiFetch(path)
  GET with `fields` param where supported (playlist/album items: id,name,artists,album,duration_ms)
  paging: limit=50, iterate next/offset until exhausted
  200 → return body
  401 → auth.refreshToken() once → retry once
  429 | body.message QUOTA_EXCEEDED → read Retry-After (s) → backoff setTimeout
        → onRateLimited() → UI "Spotify va lento ahora mismo" state (banner + disabled actions)
  other → Error with status; caller shows error banner + Retry
```

Import is eager (D7): playlists → `/me/playlists` → per playlist `/playlists/{id}/items` (never `/tracks`); liked → `/me/tracks`; search → `/search?type=track`.

## Data Model (localStorage)

```js
// deoido.v1.tokens
{ access_token, refresh_token, expires_at, scopes: [] }

// deoido.v1.auth_state — transient, cleared after exchange
{ state, code_verifier }

// deoido.v1.library — v2 (compact): albums once, referenced by albumId
{
  version: 2,
  fetchedAt: "<ISO>",
  tracks: { [trackId]: { id, name, artists: [{id, name}], albumId, duration_ms } },
  albums: { [albumId]: { id, name, type, artists: [{id,name}], release_date,
      total_tracks, images, fetchedAt,          // fetchedAt = cover perishability
      tracks: [{id, name, artists, duration_ms, track_number}] } },  // Game 2 cache
  pool: [trackId, …]                            // only pooled tracks are persisted
}
```

- **Quota safety (v2)**: v1 nested a full album copy (covers included) inside every track and kept every imported track forever, so a big pool ("Me gusta") exceeded the ~5 MB localStorage quota, `setItem` threw and the write was silently swallowed → the library vanished on reload. v2 stores each album once (`albumId` reference; `uri` derives from the id), persists only the pool (the pending list is per-session), and `saveLibrary()` returns `{ ok, droppedTracklists }`: on quota it retries once without the re-fetchable Game 2 tracklist caches and, if it still fails, the view shows a persistent «no se pudo guardar» banner (`library.onSaveResult`).
- **Migration policy**: v1 loads through the same codec (nested album copies are promoted to `albums`) and is rewritten as v2 on the next save. Unknown versions (`version ∉ {1, 2}`) → discard library (keep tokens), show empty-library guide → re-import.
- **Perishable covers**: `fetchedAt` per album; `isStaleCover()` = now − fetchedAt > `COVER_TTL_MS` (12h); `<img onerror>` → `getAlbum(id)` refresh + update + re-render.
- **Feature detection (Game 2 tracklist)**: featured artists = `track.artists` − `album.artists`, compared by `artist.id`.
- **Operations**: import → upsert into `tracks` (dedupe by `track.id`), upsert album into `albums`; `pool` = tracked selected ids (subset of `tracks`); remove → drop from pool (album set recomputed from pool tracks); «Vaciar» (`clearPool()`) empties the pool and the snapshot shrinks to it; counts = `Object.keys(tracks).length` / pool size.

## Matching (`match.js`)

```js
normalize(s)      // toLowerCase → NFD + strip combining marks → strip [^\p{L}\p{N}\s] → collapse whitespace
stripAliases(s)   // remove "(feat. …)" "(featuring …)" "(remaster)" "(deluxe)" "(explicit)" "(deluxe edition)", trailing "- remaster" / "- expanded"
levenshtein(a,b)  // classic DP
isMatch(g,t)      // lev(g,t) ≤ min(2, max(1, floor(t.length/10)))
matchTitle(g,t)   // isMatch(normalize(g), normalize(t)) || isMatch(normalize(g), normalize(stripAliases(t)))
matchArtistSlots(guesses, credited)  // per slot: guess compared (same normalize+alias) against every UNSOLVED
                                     // credited artist, order-independent; first hit fills that slot; wrong guess
                                     // flags slot "incorrect" but stays editable; solved ⇔ all credited matched
matchAlbum(g,a)   // same as matchTitle
yearHint(g,a)     // { direction: "older"|"newer"|"equal", closeness: "very-close"(≤2)|"close"(≤10)|"far" }
```

Pure functions only — no DOM, no state (spec: deterministic, repeat calls identical). A guess is accepted on raw-normalized OR alias-normalized target.

## UI & Visual Direction

**Design Read**: *"Reading this as: a personal music-trivia game console for a Spanish-speaking listener, with a record-deck / listening-station language, leaning toward dark charcoal + warm bone type + one signal-emerald accent — a hand-built studio instrument, not a SaaS template."*

**Dials**: `DESIGN_VARIANCE: 6` (asymmetric hub, left-aligned, functional product UI) · `MOTION_INTENSITY: 5` (fluid, motivated, no idle loops) · `VISUAL_DENSITY: 5` (daily app).

**Self-critique pass**: rejected warm-cream+brass (premium-consumer tell), near-black+acid-green (AI tell), Inter, purple gradients, ALL-CAPS eyebrows, mono data labels, 3-equal-cards hub. Hub cards deliberately differentiated (wide featured clip card + stacked cover/year cards).

### Tokens

| Token | Value | Role |
|-------|-------|------|
| `--bg` | `#121110` | warm near-black page (no pure black) |
| `--surface` | `#1c1a18` | cards/panels |
| `--surface-2` | `#26231f` | inputs, hover |
| `--line` | `#3a3631` | hairlines/borders |
| `--text` | `#f2ede4` | bone primary text — **AAA** on `--bg` (~15:1) |
| `--text-dim` | `#a89f92` | secondary — **AA/AAA** (~7:1) |
| `--accent` | `#3ecf8e` | ONE accent: signal emerald ("on air" light) — **AAA** (~9:1) |
| `--accent-dim` | `#2a9d6f` | accent borders/hover |
| `--danger` | `#e5604d` | semantic errors only |

Contrast targets: WCAG AA minimum everywhere (4.5:1), AAA hero (7:1) — all tokens exceed. Dark-first single theme is a documented deviation from dual-mode default (context: music listening; `prefers-color-scheme` ignored by design).

**Type**: Display **Bricolage Grotesque** (700/800 — page titles, game names, year numerals); Text **Karla** (400/500/700 — body, buttons, inputs, labels). Both Google Fonts `<link>` with `font-display: swap` and latin-ext (Spanish accents) — acceptable for this local, no-bundler app (documented deviation from self-host default). Sentence-case labels only; no eyebrows, no mono.

**Radius scale (locked)**: cards 16px · inputs 10px · buttons/chips pill · cover corners 12px. **Spacing**: 4px base; gaps 16/24/32; gutter `clamp(16px, 4vw, 32px)`; section gap 40px.

### Layout Wireframes

```
LOGIN                          LIBRARY
┌────────────────────────────┐ ┌────────────────────────────────────┐
│ ● de oído                  │ │ ● de oído [Biblioteca][Juegos][Salir]
├────────────────────────────┤ ├────────────────────────────────────┤
│  Juega de oído             │ │ Tu biblioteca            ░░ (skeleton)
│  Reconoce canciones de tu  │ │ [Playlists ▾][Me gusta][Buscar…]  │
│  biblioteca por un instante│ │ Pendientes 12 · En tu biblioteca 214
│  de sonido.                │ │ ┌cover┐ Título        [Añadir]     │
│  [▶ Iniciar sesión con     │ │ ┌cover┐ Título        [Añadir]     │
│   Spotify]                 │ │ …                    [Añadir todo] │
│  Necesitas Spotify Premium │ └────────────────────────────────────┘
│  para los juegos de audio. │
└────────────────────────────┘

HUB (asymmetric)               GAME 1 — clip
┌────────────────────────────┐ ┌────────────────────────────────────┐
│ ● de oído [Biblioteca][Juegos][Salir]
├────────────────────────────┤ ├────────────────────────────────────┤
│ Juegos                     │ │ ▓▓▓▓░░░░ 0,1 s (clip bar)           │
│ ⚠ banner Premium si Free   │ │ [▶ Reproducir][+0,1 s][Siguiente]   │
│ ┌──────────────────┐ ┌────┐│ │ Título  [__________] ✓/✗           │
│ │ ▁▂▃▅▇ 0,1 s      │ │ ▒▒ ││ │ Artista [__________] ✓ (relleno)   │
│ │ La primera décima│ │ ▒▒ ││ │ Artista [__________] (abierto)      │
│ │ [Jugar]          │ │ ▒▒ ││ │ Álbum   [__________]               │
│ └──────────────────┘ └─┬──┘│ │ (cover oculta → aparece al          │
│                        │ ┌─┴─┐│  resolver el álbum)                 │
│                        │ │'79│└────────────────────────────────────┘
│                        │ │Año│
│                        │ └───┘
└────────────────────────┴────┘

GAME 2 — blurred cover + tracklist reveal
┌────────────────────────────────────┐
│ ● de oído [Biblioteca][Juegos][Salir]
├────────────────────────────────────┤
│ ▒▒▒▒▒▒▒▒  (blur 30→0px)            │
│ ▒▒▒▒▒▒▒▒  [Clic para enfocar]      │
│ Álbum   [__________]               │
│ Artista [__________]               │
│ ── resuelto ──                      │
│ ✓ 1. Tusa (feat. Karol G) [en tu biblioteca]
│   2. …                      [no está]
│ [Siguiente álbum]                  │
└────────────────────────────────────┘
```

### Motion Spec (what animates, and why)

| Motion | Trigger | Spec | Why |
|--------|---------|------|-----|
| View switch | route change | 180ms fade + 8px rise, `cubic-bezier(.2,0,0,1)` | state-transition feedback |
| Clip bar fill | playing | width steps every 50ms toward `targetMs` | the mechanic is *visible* while listening |
| Cover reveal (G1) | album solved | 300ms opacity/blur-out | reward |
| Blur steps (G2) | click | `filter: blur()` transition 200ms per step | the mechanic |
| Chip verdict | guess submit | 160ms fill + 1px scale pop; incorrect = brief red flash, stays editable | feedback, no dead-ends |
| Buttons | `:active` | `scale(.98)` | tactile push |
| Toasts | transient | 220ms slide-in, auto-dismiss 3.5s | non-blocking |

Only `transform`/`opacity`/`filter` animate. No idle loops, no marquees, no scroll-hijack. `@media (prefers-reduced-motion: reduce)` → all transitions/animations collapse to instant (states still update). Icons: small inline SVG set (play, plus, next, note, cover, calendar, search, trash, check, warn, volume, logout), 24px stroke 1.75, drawn by hand per project constraint (no bundler → no icon libs). No emoji anywhere.

### Component Inventory & States

| Component | States |
|-----------|--------|
| Buttons (Reproducir / +0,1 s / Siguiente / Jugar / Añadir) | default · hover · active (scale .98) · disabled (dim, blocked during priming/rate-limit) · focus-visible ring (accent 2px) |
| Guess inputs + verdict | empty · typing · **correct** (accent fill + check, locked) · **incorrect** (red flash, editable) · solved chip |
| Artist slots | open (dashed) · filled (accent chip, artist name) · incorrect (red, editable) — all-slots-filled = solved |
| Cover blur (G2) | steps 30/24/18/12/6/0px · unblurred on solve · broken-image fallback (surface-2 + note icon + re-fetch) |
| Tracklist rows | album track (name, track_number) · featured-artist suffix · membership badge: `en tu biblioteca` (accent dot) vs `no está` (dim) |
| Banners | premium (warn icon, persistent) · rate-limit slow-down · session-expired re-login · error (danger, with Retry) |
| Toasts | info · success · error; auto-dismiss |
| Volume | slider 0–100, disabled when player off |
| Nav | logo · Biblioteca · Juegos · Cerrar sesión; active route underlined |

### Copy Deck Starter (neutral Spanish — consistent action names reused in toasts)

- Hero: "Juega de oído" / "Reconoce canciones de tu biblioteca por un instante de sonido." / "Iniciar sesión con Spotify"
- Premium banner: "Necesitas Spotify Premium para los juegos de audio. Tu biblioteca y el juego de portadas siguen disponibles."
- Nav: "Biblioteca" · "Juegos" · "Cerrar sesión"
- Library: "Importar" · "Playlists" · "Me gusta" · "Buscar" · "Añadir" · "Añadir todo" · "Quitar" · empty: "Tu biblioteca está vacía. Importa canciones para empezar a jugar."
- Games: "Reproducir" · "+0,1 s" · "Siguiente" · "Siguiente álbum" · "Adivina el título" · "Adivina el artista" · "Adivina el álbum" · "Adivina el año" · "Más nuevo" · "Más viejo" · "Muy cerca" · "Cerca" · "Lejos" · solved: "¡Correcto!" / "Resuelta"
- Rate limit: "Spotify va lento ahora mismo. Esperando…" · session: "Vuelve a iniciar sesión" · generic error: "Algo salió mal." + "Reintentar"

## Testing Strategy

`strict_tdd: false`, no runner. Verification is manual + one lightweight harness.

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (pure) | `match.js`: normalize, alias strip, Levenshtein thresholds (cap 2), slots order-independence, yearHint bounds | Tiny no-framework assert harness (plain HTML page or browser console) run before/after changes |
| Unit (storage) | schema round-trip, version mismatch → discard, stale-cover flag | Manual console checks against `storage.js` API |
| Integration | PKCE login/state-mismatch/refresh/`invalid_grant`; import 3 sources + dedupe; 429 backoff (simulated by stub); premium degradation | Scripted manual checklist in browser (local server on 127.0.0.1) |
| E2E | All 3 games end-to-end: clip poll-pause timing, blur steps, tracklist reveal, empty-library guide, Next without immediate repeats | Manual scripted run; success criteria in proposal |

## Threat Matrix

`N/A` — no routing (client-side hash view switching only, no network routing), no shell commands, no subprocesses, no VCS/PR automation, no executable-file classification, no process-integration boundary. No RED tests required.

## Migration / Rollout

No migration: greenfield. Rollout = run local static server on the port in `config.js`; fill `CLIENT_ID` in the Spotify Dashboard (redirect `http://127.0.0.1:PORT`); allowlist user; PR revert is the rollback. localStorage versioning (v1) protects future schema changes.

## Open Questions

- [ ] None blocking. Runtime-tuning items (carry to verify): clip audible-window feel vs `targetMs`; blur-step feel; Dev-Mode 30s quota pressure in practice. `CLIENT_ID` and server port are per-user setup values.

## Design Rules Compliance

- `rules.design` (config.yaml): architecture decisions with rationale ✅ (D1–D14); Spotify authorization + Web Playback SDK integration diagrams ✅ (Integration Flows).
- Threat matrix: not applicable, recorded as such (no invented tasks).