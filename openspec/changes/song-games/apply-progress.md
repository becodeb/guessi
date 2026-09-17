# Apply Progress — song-games (de-oido)

**Change**: song-games · **Batch**: 1 (first and only) · **Mode**: Standard (strict_tdd: false)
**Delivery**: single-pr (size-exception pre-approved in tasks.md) · **State**: all 18 tasks complete
**Prior batches**: none (confirmed via Engram search `sdd/song-games/apply-progress` — no results)

## Completed Tasks

- [x] 1.1 `index.html` — fonts (Bricolage Grotesque 700/800 + Karla 400/500/600/700, latin-ext), `#app`, inline SVG sprite (14 icons, 24px stroke 1.75); no SDK tag
- [x] 1.2 `styles.css` — D9 tokens, components (buttons, inputs, chips, cards, banners, nav, toasts, skeleton, clip bar, slots, tracklist, volume), reduced-motion block
- [x] 1.3 `src/config.js` — CLIENT_ID "REPLACE_ME", REDIRECT_URI `http://127.0.0.1:8080/`, exact 8 scopes, SDK_URL, COVER_TTL_MS (12h)
- [x] 1.4 `src/ui.js` — el(), toast(), skeleton(), formatMs() ("0,1 s" Spanish comma), icon() via sprite, liveRegion(), emptyGuide(), premiumGate()
- [x] 1.5 `src/main.js` — hash router (5 routes incl. `#/juegos/año`, decoded), appState, nav, banners, mount/unmount, login/library/hub views

- [x] 2.1 `src/storage.js` — deoido.v1.tokens / auth_state / library; load/save/clear; isStaleCover(); version mismatch → discard library (tokens kept)
- [x] 2.2 `src/auth.js` — PKCE (verifier 86 chars S256, state, 8 scopes), state check → abort+clear, exchange, silent refresh, invalid_grant → clear + re-login, single-flight refresh, tokens never in URLs/logs/UI
- [x] 2.3 `src/spotify-api.js` — apiFetch: 401→refresh+retry once, 429/QUOTA_EXCEEDED→Retry-After backoff + onRateLimited, 403 PREMIUM_REQUIRED surfaced; endpoints: playlists, playlist items (fields, never `/tracks`), liked, search, album, album tracks (pages ≤50, cached in library)

- [x] 3.1 `src/match.js` — pure: normalize, stripAliases, levenshtein, isMatch (cap 2), matchTitle, matchArtistSlots (order-free, no slot burn), matchAlbum, yearHint
- [x] 3.2 `tests/match.test.mjs` — `node tests/match.test.mjs`: **58 assertions, 0 failures** (accents/case, punctuation, feat./edition/trailing-remaster aliases, typo Bichote, cap 2 len-40, cap-floor len-3, all-artists-required, order independence, no-slot-burn, duplicate-guess, accent-insensitive artist, deluxe album, determinism, yearHint bounds, levenshtein sanity)
- [x] 3.3 `src/player.js` — lazy SDK inject, initPlayer, device_id on ready, prime (PUT play + immediate pause), playClip (seek+resume in gesture, 50ms poll, pause ≥ targetMs), stop cleanup, setVolume, account_error/autoplay_failed/403 → premium
- [x] 3.4 `src/library.js` — import playlist/liked/search (limit 50, paginated), pending list, pool add/remove/addAll, getPoolTracks/getAlbums, random draws (no immediate repeat), getAlbumTracklist cached by albumId, dedupe by id

- [x] 4.1 `src/games/clip-game.js` — clip flow (targetMs=100×taps, Next resets), title+artist-slot+album guesses, cover reveal on album solve, solved state, empty→guide, premium gate
- [x] 4.2 `src/games/album-game.js` — 6 blur steps 30→0px, unblur on solve, album+artist guesses, tracklist (name, featured by artist.id diff, membership marks), >50 paginated, single-track safe, next-album button
- [x] 4.3 `src/games/year-game.js` — clip + year guess, older/newer + very-close/close/far hints, null-year guard, solved reveal
- [x] 4.4 `main.js` wiring — hub cards (differentiated: featured clip + stacked album/year), mount/unmount, premium gates for games 1/3, Library + Game 2 intact, volume control

- [x] 5.1 `README.md` — Dashboard app creation (Web API + Web Playback SDK), redirect `http://127.0.0.1:8080/`, Client ID → config.js, `python3 -m http.server 8080`, Premium, iOS caveat, Dev Mode 5-user note, structure, tests
- [x] 5.2 `docs/smoke-checklist.md` — manual: auth flows (login/state-mismatch/refresh/invalid_grant/logout), import+dedupe (3 sources, pending, pool, persistence, version mismatch), 429, premium degradation, games E2E, empty guide, no-repeat, cleanup, reduced-motion, keyboard

## Verification Evidence (exact commands + results)

### 1. Syntax check — every JS/MJS file (`cp` to `/tmp/<name>.mjs` + `node --check`)

```
$ for f in src/config.js src/main.js src/auth.js src/spotify-api.js src/player.js \
  src/library.js src/storage.js src/match.js src/ui.js src/games/clip-game.js \
  src/games/album-game.js src/games/year-game.js tests/match.test.mjs; do ...
OK  src/config.js  OK  src/main.js  OK  src/auth.js  OK  src/spotify-api.js
OK  src/player.js  OK  src/library.js  OK  src/storage.js  OK  src/match.js
OK  src/ui.js      OK  src/games/clip-game.js  OK  src/games/album-game.js
OK  src/games/year-game.js  OK  tests/match.test.mjs
ALL SYNTAX OK   (0 failures)
```

### 2. Matching harness

```
$ node tests/match.test.mjs
match.test.mjs: 58 assertions passed, 0 failed   (exit 0)
```

### 3. Static smoke — `python3 -m http.server` from repo root + `curl -s -o /dev/null -w "%{http_code}"`

```
$ python3 -m http.server 8092 &   # NOTE: 8080 AND 8081 are occupied by pre-existing
                                  # external listeners in this shared environment
                                  # (verified with `ss -tln`; not ours to kill).
                                  # App REDIRECT_URI stays http://127.0.0.1:8080/ per design.
200  index.html                200  styles.css
200  src/config.js             200  src/main.js
200  src/auth.js               200  src/spotify-api.js
200  src/player.js             200  src/library.js
200  src/storage.js            200  src/match.js
200  src/ui.js                 200  src/games/clip-game.js
200  src/games/album-game.js   200  src/games/year-game.js
200  tests/match.test.mjs      200  README.md
200  docs/smoke-checklist.md
ALL 17 FILES → HTTP 200 · server killed afterwards (port confirmed free)
```

### 4. No `REPLACE_ME` leaks / no secrets

```
$ grep -rn "REPLACE_ME" --include=... .
./src/config.js:4:  export const CLIENT_ID = "REPLACE_ME";        ← the required placeholder (only config.js)
./src/main.js:270,281: CLIENT_ID === "REPLACE_ME"                ← INTENTIONAL setup guard: shows
                                        "Falta configurar: copia tu Client ID en src/config.js"
                                        banner on the login view when unconfigured (documented deviation)
./README.md / docs/smoke-checklist.md                            ← setup instructions (documentation)
$ grep -rniE "(client_secret|api[_-]?key|secret\s*=|password\s*=)" src/ index.html
no secret patterns found
```

## Deviations from Design (documented, deliberate)

1. **`package.json` added** — a minimal manifest with `name: "de-oido"`, `private: true`, `version: "1.0.0"`, `type: "module"`, a `description`, and two `scripts` (`test`: `node tests/match.test.mjs`; `serve`: `python3 -m http.server 8080`). It declares **zero dependencies and zero devDependencies** (no `dependencies`/`devDependencies` fields at all) — the vanilla/no-build constraint is fully preserved. The file exists so `node tests/match.test.mjs` can `import "../src/match.js"` as ESM without a bundler or flags. The static server ignores it.
2. **`main.js` `REPLACE_ME` guard** — the placeholder string appears in `main.js` only as an equality check that renders the "falta configurar" notice (UX guard, not a leak).
3. **`yearHint` bounds follow design.md** (`very-close` ≤2, `close` ≤10, else `far`) — the games spec scenario "Year feedback" (2015 vs 2019 → "far") contradicts the design's numeric bounds (|2019−2015|=4 → "close" ≤10). Design.md is the authoritative artifact per apply instructions; the scenario is flagged for verify: if the game should answer "Lejos" at distance 4, the `close` bound in `src/match.js` needs to drop below 4 (one-line change, no ripple).
4. **Storage schema adds `pool: [trackId]`** to `deoido.v1.library` — the design's data model describes the pool ("tracked selected ids") but doesn't show the field in the JSON; it is the persisted pool per D5/D7.
5. **Smoke test port** — ran on 8092 (8080/8081 busy externally); app config unchanged (`REDIRECT_URI` = 8080).

## Work Unit Evidence

| Evidence | Value |
|---|---|
| Focused test command + result | `node tests/match.test.mjs` → 58 assertions passed, 0 failed, exit 0 |
| Runtime harness | Static HTTP smoke: 17/17 files 200 (port 8092); browser E2E deferred to `docs/smoke-checklist.md` (no browser automation available; SDK/auth need real Spotify creds) |
| Rollback boundary | Greenfield: `git clean`/revert of the untracked files (index.html, styles.css, src/, tests/, README.md, docs/, package.json) — no pre-existing code to disturb |

## Risks / Notes for Verify

- **yearHint scenario conflict** (see deviation 3) — the only spec-vs-design discrepancy found.
- SDK latency (100–500ms) makes the audible window exceed `targetMs` — by design, no compensation.
- Dev-Mode 30s quota pressure and CORS verified only at runtime with real credentials.
- `#/juegos/año` uses a non-ASCII hash; router decodes `location.hash` (browsers percent-encode it) — covered in main.js.
- 8080 was occupied by an external listener in this environment during apply; smoke used 8092. On the user's machine, `python3 -m http.server 8080` is the documented setup and nothing in the code depends on the smoke port.

## Remediation (maintainer-authorized, ONE bounded correction)

### Defect (CRITICAL-1, from failed verification)

`src/main.js` declared `let current = null` and the router ran `current?.unmount` on
view change, but **`current` was never assigned**. Game views' `unmount()` →
`player.stop()` cleanup was dead code; exiting a game mid-clip left audio and the
50ms position poll running (playback spec "Volume Control and Cleanup" violated).

### Fix

| File | Change |
|---|---|
| `src/main.js` | Game route defs now carry `game: clipGame / albumGame / yearGame`; `route()` assigns `current = def.game ?? null` after render, so the existing `current?.unmount` path fires on every route change (3 ROUTES lines + 1 assignment + 1 comment) |
| `src/games/clip-game.js` | Prime race guard: the prime promise is stored on the round (`round.priming`); Play click awaits an in-flight prime before playing instead of silently dropping the tap |
| `src/games/year-game.js` | Same prime race guard (Game 3 uses the identical clip path) |

`album-game.js` unmount was already exported and is now reachable via the router
wiring too (no audio, but its `handle = null` cleanup runs on exit).

**Changed-line count: 15** (main.js 5, clip-game.js 5, year-game.js 5). No
spec/design/tasks edits, no refactors, no style churn. No git commits.

### Static trace (wiring fix)

```
ROUTES "/juegos/clip|album|año" → game: clipGame|albumGame|yearGame   (main.js:33-35)
route() → current = def.game ?? null                                 (main.js:84)
next route change → current?.unmount() fires:
  clip-game.js:15 unmount() → player.stop()          year-game.js:17 unmount() → player.stop()
  album-game.js:18 unmount() → handle = null
player.stop() (player.js:175-179) → clearInterval(pollId) + player.pause() + onEnd
```

### Prime race guard trace (bounded hardening, games 1 & 3)

```
drawRound: round.priming = ctx.player.prime(uri)          (clip:66 / year:90)
Play click: if (!round.primed && round.priming) await round.priming;   (clip:99-100 / year:119-120)
            if (!round.primed) return;                    (clip:102 / year:122)
```

### Work Unit Evidence (remediation)

| Evidence | Value |
|---|---|
| Focused test command + result | `node tests/match.test.mjs` → `match.test.mjs: 58 assertions passed, 0 failed`, exit 0 |
| Runtime harness | Static HTTP smoke on port 8099 (8080/8081 occupied by external listeners here): `python3 -m http.server 8099` + `curl -s -o /dev/null -w "%{http_code}"` → **17/17 files HTTP 200**, server killed, port free. Browser E2E of the unmount cleanup requires a real Premium session — deferred to `docs/smoke-checklist.md` item 5 (game exit stops audio/poll), now reachable because the router wiring is live |
| Rollback boundary | The three touched files (`src/main.js`, `src/games/clip-game.js`, `src/games/year-game.js`) — revert those hunks to restore pre-remediation state; nothing else was modified |

### Re-verification evidence (exact commands + results)

```
$ node tests/match.test.mjs
match.test.mjs: 58 assertions passed, 0 failed        (exit 0)

$ for f in src/*.js src/games/*.js tests/match.test.mjs (13 files, copied to /tmp/rem-*.mjs)
  node --check → OK ×13 — "ALL SYNTAX OK (13/13)"

$ python3 -m http.server 8099 &  →  curl -s -o /dev/null -w "%{http_code}" each of 17 assets
200 × 17 (index.html, styles.css, 13 JS, tests/match.test.mjs, README.md, docs/smoke-checklist.md)
server killed afterwards; port 8099 confirmed free

$ grep static traces (above) — unmount reachable from router path; player.stop() clears poll + pauses
```

### Candidate state after fix

- `current` assigned on every route render → game `unmount()` runs on view change (audio + poll cleanup live).
- Play before prime completes → waits for the in-flight prime (≤ SDK prime duration, within transient user activation) then plays; failed prime still degrades to a no-op without new state.
- Unrelated pre-existing note (not introduced here, not touched): album-game `revealTracklist` late callback could throw after unmount if the user navigates away mid-fetch — out of remediation scope.

## Remediation round 2 (maintainer-authorized, native rescope)

Three defects found in the user's real manual smoke test (Premium account, Windows
Chrome, app served over an SSH tunnel).

### Defects

1. **False fatal banner** — `player.js` treated `not_ready` (a NORMAL SDK lifecycle
   event: device session briefly inactive) as fatal (`notifyError("not_ready")`), and
   `main.js` mapped any player error to the persistent «No se pudo conectar el
   reproductor de Spotify.» banner; nothing cleared it when the device reconnected.
2. **Prime left the track PLAYING** — `prime()` sent `PUT /me/player/play` then a
   single immediate `pause()` without waiting for the stream to start, so the pause
   was lost. `playClip()` could also run away if `getCurrentState()` returned null:
   the 50ms poll never reached `targetMs` and nothing ever paused.
3. **Game 1 album cover visible before the guess** — `.cover--hidden` was
   `opacity: 0.22; filter: blur(6px)` (recognizable).

### Fix

| File | Change |
|---|---|
| `src/player.js` | `not_ready` no longer fatal (clears `deviceId` only); new `onReady(cb)` listener set fired on SDK `ready`; `prime()` now awaits `ensurePaused()` — poll ~100ms up to 1200ms for `paused === false`, `pause()`, then verify `paused === true` with ≤6 bounded retries (~120ms apart, each retrying `pause()` so unreadable state can never be left playing); `playClip()` calls `bestEffortActivate()` and sets a wall-clock failsafe (`setTimeout(stop, targetMs + 600)`) cleared inside `stop()`; `autoplay_failed` no longer sets `premium = false` — best-effort `activateElement()` + `console.warn` |
| `src/main.js` | `onPlayerError`: `prime-failed` → transient toast «No se pudo preparar la canción. Probá de nuevo.» instead of the persistent banner (banner kept for `sdk-load`, `initialization_error`, `authentication_error`, `connect-failed`); subscribes `player.onReady(...)` → status `ready` + `updateBanners()` (banner self-heals unless `premium-denied`); `ensurePlayer()` calls `updateBanners()` on all exit paths |
| `styles.css` | `.cover--hidden` → `opacity: 0; filter: blur(24px);` (300ms transitions kept; `.cover--revealed` untouched) |
| `src/games/clip-game.js` | Hidden cover uses neutral `alt: "Portada del álbum"`; `revealCover()` sets the real `alt` (`Portada de ${album.name}`) |

**Changed-line count: ~112 touched (player.js +80/-7, main.js +15/-2, clip-game.js +3/-1, styles.css +2/-2) ≈ 100 net added** — within the ~120 budget. No other files touched, no refactors, no commits.

### Static traces (evidence)

```
(a) prime wait→pause→verify:  ensurePaused() player.js:174 → waitForPlaying(1200):176 → pause():177
    → verify loop ≤6:178-183 (paused === true → return; else pause() again); called by prime():198
(b) failsafe: state.failsafeId declared :16 · set in playClip :226 (targetMs + 600)
    · cleared in stop :244-246
(c) not_ready non-fatal: notifyError("not_ready") removed (grep count 0); ready → notifyReady() :96;
    onReady exported :36; main.js wires player.onReady :238; prime-failed → toast :227-229
(d) cover hidden: styles.css .cover--hidden opacity 0 / blur 24px :844-847;
    neutral alt "Portada del álbum" :284; real alt set in revealCover :313
```

### Work Unit Evidence (remediation round 2)

| Evidence | Value |
|---|---|
| Focused test command + result | `node tests/match.test.mjs` → `match.test.mjs: 58 assertions passed, 0 failed`, exit 0 |
| Runtime harness | Static HTTP smoke on port 8099: `python3 -m http.server 8099` (repo root) + `curl -sI` for 17 assets → **17/17 HTTP 200**; server killed, port 8099 confirmed free. Real reset is in-app: with the fixes, an SDK `not_ready` → `ready` cycle must clear the banner without reload, and priming must leave the track paused (verify via the smoke checklist with a Premium session) |
| Rollback boundary | The four touched files (`src/player.js`, `src/main.js`, `src/games/clip-game.js`, `styles.css`) — revert those hunks to restore the round-1 state; `remediation-evidence.json` was NOT modified |

### Re-verification evidence (exact commands + results)

```
$ node tests/match.test.mjs
match.test.mjs: 58 assertions passed, 0 failed        (exit 0)

$ for f in 13 JS/MJS files (copied to /tmp/r2-*.mjs); node --check each
OK ×13 — "ALL SYNTAX OK (13/13)"

$ python3 -m http.server 8099 &  →  curl -sI -o /dev/null -w "%{http_code}" (17 assets)
200 ×17 (index.html, styles.css, 9 src/*.js, 3 src/games/*.js, tests/match.test.mjs, README.md, docs/smoke-checklist.md)
server killed afterwards; port 8099 confirmed free

$ static traces (a)-(d) above — all paths verified by grep line references
```

### Candidate state after round 2

- `not_ready` is informational only; a later `ready` fires `onReady` → `main.js` resets status to `ready` and re-renders banners (self-heal). `prime-failed` surfaces as a transient toast, never a persistent banner.
- Priming is guaranteed to end paused (wait-for-start → pause → bounded verify); clip playback has both the 50ms position poll and a wall-clock failsafe cleared by `stop()`.
- Game 1 artwork is fully invisible (`opacity: 0`) and alt-neutral until the album is solved.
- Out-of-scope observation for verify: `album-game.js` cover alt is `Portada borrosa de ${album.name}` — same spoiler class as defect 3 but not in the authorized scope; left untouched.

## Remediation round 3 (maintainer-authorized, ACTUAL root cause)

### Root cause (confirmed by code reading)

`src/spotify-api.js` `request()` ended with `return res.json()` unconditionally.
`PUT /me/player/play` returns **204 No Content** (empty body) → `res.json()` throws
`SyntaxError` → the throw propagated to `prime()`'s catch in `src/player.js`
(`notifyError("prime-failed")`) **even though Spotify had already received the play
command and started the track**. Consequences: the «No se pudo preparar la canción»
toast (round 2) / persistent «No se pudo conectar el reproductor» banner (round 1),
`prime()` returning false → `ensurePaused()` never ran → the track kept playing
with no pause, and the game's Play button was dead (`if (!round.primed) return`).
Rounds 1 and 2 symptoms shared this single cause.

### Fix

| File | Change |
|---|---|
| `src/spotify-api.js` | `request()` success path: `204`/`205` → `return null`; otherwise read text, empty → `null`, else `JSON.parse`. A successful play PUT now resolves. Other behaviors (401 refresh+retry, 429/QUOTA backoff, 403 handling) untouched |
| `src/player.js` | `state.clipActive` flag (`false` initial); `playClip()` sets `true`, `stop()` sets `false`; new `player_state_changed` listener pauses when `!state.clipActive && st.paused === false` — silence guard so the device is never left playing outside a clip |
| `src/games/clip-game.js` | Play handler: if not primed, retry once with a fresh prime (`round.priming = ctx.player.prime(round.track.uri); round.primed = await round.priming;`); still not primed → toast «El reproductor todavía no está listo. Probá de nuevo.» and return |
| `src/games/year-game.js` | Same retry+toast path (Game 3 shares the clip mechanic) |

**Changed-line count: 33 touched (30 added, 3 removed)** — spotify-api +5/−1, player +7/−0, clip-game +9/−1, year-game +9/−1 — within the ~60 budget. No other files touched, no refactors, no commits.

### Static traces (evidence)

```
(a) spotify-api.js:100-104 — 204/205 → null (no throw path for the play PUT);
    otherwise text → JSON.parse or null; the old `return res.json()` is gone
(b) prime() player.js:199 apiFetch → :203 await ensurePaused(); notifyError("prime-failed") only in the catch :210
(c) silence guard player.js:114-116 — player_state_changed → if (!state.clipActive && st && st.paused === false) state.player?.pause()
(d) clipActive: declared :17, guard :116, set true in playClip :225, cleared in stop :250
(e) retry+toast: clip-game.js:103-109 (retry :103-105, toast :108) · year-game.js:123-129 (retry :123-125, toast :128)
```

### Work Unit Evidence (remediation round 3)

| Evidence | Value |
|---|---|
| Focused test command + result | `node tests/match.test.mjs` → `match.test.mjs: 58 assertions passed, 0 failed`, exit 0 |
| Runtime harness | Static HTTP smoke on port 8099: `python3 -m http.server 8099` (repo root) + `curl -sI` for 17 assets → **17/17 HTTP 200**; server killed, port 8099 confirmed free. The reset that matters is in-app with a Premium session: Play must now work on first tap (prime resolves on 204) and no audio may continue after the clip (silence guard + failsafe) |
| Rollback boundary | The four touched files (`src/spotify-api.js`, `src/player.js`, `src/games/clip-game.js`, `src/games/year-game.js`) — revert those hunks to restore the round-2 state; `remediation-evidence.json` and `remediation-evidence-2.json` were NOT modified |

### Re-verification evidence (exact commands + results)

```
$ node tests/match.test.mjs
match.test.mjs: 58 assertions passed, 0 failed        (exit 0)

$ for f in 13 JS/MJS files (copied to /tmp/r3-*.mjs); node --check each
OK ×13 — "ALL SYNTAX OK (13/13)"

$ python3 -m http.server 8099 &  →  curl -sI -o /dev/null -w "%{http_code}" (17 assets)
200 ×17 (index.html, styles.css, 9 src/*.js, 3 src/games/*.js, tests/match.test.mjs, README.md, docs/smoke-checklist.md)
server killed afterwards; port 8099 confirmed free

$ static traces (a)-(e) above — all paths verified by grep line references
```

### Candidate state after round 3

- `PUT /me/player/play` (204) resolves normally → `prime()` reaches `ensurePaused()` → the track ends paused; the «No se pudo preparar la canción» toast and the dead-Play symptom lose their cause.
- Play never stays dead: one fresh-prime retry, then a clear toast with a next step.
- Silence guard: any `player_state_changed` with `paused === false` and no active clip pauses the device — covers missed/late pauses from any source.