```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:018b6fe3174b1d9ff3bda580437087c6c8938d1e421db697db038e304e89504e
verdict: fail
blockers: 1
critical_findings: 1
requirements: 21/22
scenarios: 31/38
test_command: node tests/match.test.mjs
test_exit_code: 0
test_output_hash: sha256:50ed0fa86d37a10baa2ee7e2aed905cd20dd6edf4b68286e514fd3fe72e98def
build_command: "for f in src/config.js src/main.js src/auth.js src/spotify-api.js src/player.js src/library.js src/storage.js src/match.js src/ui.js src/games/clip-game.js src/games/album-game.js src/games/year-game.js tests/match.test.mjs; do cp \"$f\" /tmp/$(basename \"$f\" .js).mjs; node --check /tmp/$(basename \"$f\" .js).mjs && echo OK || echo FAIL; done"
build_exit_code: 0
build_output_hash: sha256:1eb5951c26ec8cf8f41835acea8c8985e6714858ea1bd1c5eda32d7d089dd990
```

## Verification Report

**Change**: song-games
**Version**: N/A (greenfield, no spec version)
**Mode**: Standard (strict_tdd: false)

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 18 |
| Tasks complete | 18 |
| Tasks incomplete | 0 |

### Build & Tests Execution
**Build** (syntax sweep, no build step in this project): ✅ Passed
```text
OK  src/config.js  OK  src/main.js  OK  src/auth.js  OK  src/spotify-api.js
OK  src/player.js  OK  src/library.js  OK  src/storage.js  OK  src/match.js
OK  src/ui.js      OK  src/games/clip-game.js  OK  src/games/album-game.js
OK  src/games/year-game.js  OK  tests/match.test.mjs
ALL SYNTAX OK   (13/13 files, exit 0)
```

**Tests**: ✅ 58 assertions passed, 0 failed (exit 0)
```text
$ node tests/match.test.mjs
match.test.mjs: 58 assertions passed, 0 failed
```

**Static smoke** (port 8099; 8080/8081 busy with external listeners): ✅ 17/17 files HTTP 200
```text
200  index.html · styles.css · src/*.js (11) · tests/match.test.mjs · README.md · docs/smoke-checklist.md
server killed afterwards — port confirmed free
```

**Coverage**: ➖ Not available (no coverage tooling; config.yaml `coverage.available: false`)

### Spec Compliance Matrix
Classification: `verified-by-test` (harness), `verified-by-code` (static trace, file+function), `not-verifiable-here` (needs credentials/Premium/browser audio/network), `failing` (code contradicts spec).

| Requirement | Scenario | Evidence | Result |
|-------------|----------|----------|--------|
| spotify-auth · PKCE Authorization Code Flow | First-time login completes | `auth.js authorize()/handleCallback()` full flow in code; runtime round-trip needs real Spotify redirect + token exchange | ⚠️ NOT-VERIFIABLE-HERE |
| | localhost redirect is rejected | `config.js` REDIRECT_URI `http://127.0.0.1:8080/` — localhost never used (app-side compliant); Spotify-side rejection needs live authorize | ⚠️ NOT-VERIFIABLE-HERE |
| spotify-auth · State Validation | Matching state proceeds | `auth.js handleCallback()`: state === stored.state → exchange proceeds | ✅ COMPLIANT (verified-by-code) |
| | State mismatch aborts login | `handleCallback()` mismatch → `clearAuthState()` + boot() → "Vuelve a iniciar sesión" toast/banner, login view | ✅ COMPLIANT (verified-by-code) |
| spotify-auth · Token Storage and Silent Refresh | Silent refresh before an API call | `auth.js getAccessToken()` expiry check (−30 s) + `spotify-api.js` 401 → `refreshToken()` + retry once | ✅ COMPLIANT (verified-by-code) |
| | invalid_grant forces re-login | `refreshToken()` 400/401 → `clearTokens()` + `notifySessionExpired` → main.js banner + `#/login` | ✅ COMPLIANT (verified-by-code) |
| matching · Normalization | Accent and case insensitivity | `match.test.mjs` normalize("Déjame Ir") → "dejame ir" | ✅ COMPLIANT (verified-by-test) |
| | Punctuation stripped | `match.test.mjs` normalize("Livin' on a Prayer!") | ✅ COMPLIANT (verified-by-test) |
| matching · Alias Strip | Featuring alias stripped | `match.test.mjs` stripAliases/matchTitle "Tusa (feat. Karol G)" → "Tusa" | ✅ COMPLIANT (verified-by-test) |
| matching · Typo Tolerance | Typo within threshold accepted | `match.test.mjs` "Bichote"→"Bichota" (lev 1 ≤ max(1,⌊7/10⌋)) | ✅ COMPLIANT (verified-by-test) |
| | Cap of 2 for long titles | `match.test.mjs` len-40 target, 3 edits rejected, 1 edit accepted | ✅ COMPLIANT (verified-by-test) |
| matching · Title and Artist Slot Matching | All credited artists required | `match.test.mjs` Dua Lipa + Angèle: one solved → not solved, slot open | ✅ COMPLIANT (verified-by-test) |
| | Artist order independence | `match.test.mjs` "Angèle" in first slot fills (credited second) | ✅ COMPLIANT (verified-by-test) |
| matching · Album Matching | Edition suffix ignored | `match.test.mjs` matchAlbum "Future Nostalgia" vs "(Deluxe Edition)" | ✅ COMPLIANT (verified-by-test) |
| matching · Deterministic Pure Functions | Repeat calls return identical verdicts | `match.test.mjs` determinism block (title/slots/yearHint) | ✅ COMPLIANT (verified-by-test) |
| library · Import Sources | Playlist import pages to completion | `spotify-api.js getPlaylistItems()` `/playlists/{id}/items` limit=50 + `pageAll()` next/offset; `library.js importFromPlaylist()` → pending (120 tracks → 3 pages) | ✅ COMPLIANT (verified-by-code) |
| | Search import | `searchTracks()` `GET /search?type=track` → `pushPending()` | ✅ COMPLIANT (verified-by-code) |
| library · Selection and "Songs I Know" Pool | Selecting tracks into the pool | `library.js addToPool()` (id-only, pending shrinks) + main.js counts | ✅ COMPLIANT (verified-by-code) |
| | Removing a known song | `removeFromPool()` + album prune; games draw only from pool | ✅ COMPLIANT (verified-by-code) |
| library · Dedupe and Persistence | Dedupe across sources | `upsertTrack()` id-keyed maps + `pushPending()` id-set; albums keyed by album.id | ✅ COMPLIANT (verified-by-code) |
| | Perishable cover re-fetch | `storage.js isStaleCover()` + `library.js refreshAlbum()` on stale/broken (`img onerror`) in games 1/2 | ✅ COMPLIANT (verified-by-code) |
| library · Empty State and Import Guidance | Empty pool shows import guide | `ui.js emptyGuide()` gating all 3 games before a round starts | ✅ COMPLIANT (verified-by-code) |
| games · Game 1 — Clip Guessing | Full solve reveals the cover | `clip-game.js`: matchTitle + matchArtistSlots + matchAlbum → `checkSolved()` banner; `revealCover()` on album solve | ✅ COMPLIANT (verified-by-code) |
| | Next draws a different track | `library.js getRandomTrack()` excludes `lastTrackId`; `drawRound()` resets taps=1/targetMs=100 | ✅ COMPLIANT (verified-by-code) |
| games · Game 2 — Blurred Album Cover | Blur steps and solve reveal | `album-game.js` BLUR_STEPS 30/24/18/12/6/0; `unblur()` on album+artist solve; `revealTracklist()` | ✅ COMPLIANT (verified-by-code) |
| | Album with no featured artists on a track | `tracklistElement()` featured = track.artists − album.artists by artist.id → empty suffix, no error | ✅ COMPLIANT (verified-by-code) |
| | Album exceeding 50 tracks | `getAlbumTracks()` `GET /albums/{id}/tracks` paged limit=50 via `pageAll()`, cached by albumId | ✅ COMPLIANT (verified-by-code) |
| games · Game 3 — Release Year | Year feedback (2019 vs 2015, \|d\|=4 → newer + close) | `match.test.mjs` `yearHint(2015, 2019)` → newer + close (exact scenario inputs); `year-game.js` renders copy | ✅ COMPLIANT (verified-by-test) |
| | Far year guess (2019 vs 1990, \|d\|=29 → newer + far) | `match.test.mjs` `yearHint(2000, 2019)` d=19 → far (same `>10` branch as d=29) | ✅ COMPLIANT (verified-by-test, same branch) |
| games · Game Edge Cases | Single-track album | `tracklistElement()` renders 1 row + membership mark, no crash | ✅ COMPLIANT (verified-by-code) |
| | Empty library blocks rounds | render() shows guide before `drawRound()` in all 3 games | ✅ COMPLIANT (verified-by-code) |
| playback · Web Playback SDK Initialization | SDK connects and yields a device | `player.js loadSdk()/onSpotifyWebPlaybackSDKReady/Spotify.Player/connect()/ready→device_id`; runtime needs Premium | ⚠️ NOT-VERIFIABLE-HERE |
| | SDK failure shows a banner | `not_ready`/`initialization_error` → `notifyError()` → main.js error banner, app stays usable; runtime needs SDK | ⚠️ NOT-VERIFIABLE-HERE |
| playback · Prime-on-Select Preloading | Track is primed before Play | `player.js prime()` PUT `/me/player/play?device_id=X` `{uris, position_ms:0}` + pause, on select and Next; device load is runtime | ✅ COMPLIANT (verified-by-code) |
| playback · Clip Control | Play stops at the accumulated length | `playClip()` seek(0)+resume() in gesture, 50 ms poll, pause ≥ targetMs = 100 ms × taps; audible latency accepted | ⚠️ NOT-VERIFIABLE-HERE |
| | Next resets the clip | `drawRound()` taps=1/targetMs=100 + `stop()` before redraw | ✅ COMPLIANT (verified-by-code) |
| playback · Premium Degradation | Free account keeps the app usable | `account_error`/`autoplay_failed`/403 PREMIUM_REQUIRED → `notifyPremium()`; gates only games 1/3; Library + Game 2 ungated; runtime event | ⚠️ NOT-VERIFIABLE-HERE |
| playback · Volume Control and Cleanup | Game exit stops audio and polling | `main.js route()` never assigns `current` → game `unmount()` (→ `player.stop()`: pause + clearInterval) is dead code; exit mid-clip leaves the 50 ms poll and audio running until position ≥ targetMs | ❌ FAILING (verified-by-code contradiction) |

**Compliance summary**: 31/38 scenarios compliant (11 verified-by-test, 20 verified-by-code) · 6 not-verifiable-here (environment-limited) · 1 failing · Requirements 21/22 complete.

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| PKCE params / state / 8 scopes / storage / silent refresh / invalid_grant | ✅ Implemented | `auth.js` + `config.js`; verifier 86 chars (43–128 ✓), S256 challenge, state validation, expiry pre-refresh, 401 refresh-once, invalid_grant → clear + re-login |
| `/playlists/{id}/items` usage; `/tracks` never used | ✅ Implemented | `spotify-api.js getPlaylistItems()`; grep: no `/tracks` endpoint in code |
| Paging ≤ 50 | ✅ Implemented | `pageAll()` limit=50 via next/offset; playlists, liked, album tracks |
| 401 → refresh-once, 429 → Retry-After backoff | ✅ Implemented | `request()` retried flag; Retry-After (default 5 s, capped 30 s); QUOTA_EXCEEDED 403 handled |
| Prime-on-select + seek(0)+resume() in gesture + 50 ms poll at 100 ms × taps + reset on Next | ✅ Implemented | `player.js playClip()`; `drawRound()` reset in games 1/3 |
| Premium degradation keeping Library + Game 2 usable | ✅ Implemented | premium gate only in clip/year games; album game + library ungated |
| Cleanup on view unmount | ❌ NOT WIRED | `main.js` `current` never assigned → `unmount()` hooks never invoked (CRITICAL) |
| Three game flows + reveals + membership marks | ✅ Implemented | clip solve/cover reveal; blur steps + tracklist + featured-by-id + marks; year hints + reveal |
| Empty-library guide | ✅ Implemented | `ui.emptyGuide()` in all 3 games + library view |
| No secrets | ✅ Implemented | grep: no client_secret/api key/password; CLIENT_ID placeholder only in config.js + main.js guard |
| No removed endpoints in code | ✅ Implemented | grep: only comments stating they are never called |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 vanilla ES modules + hash router | ✅ Yes | `main.js` ROUTES; module-per-area split matches file tree |
| D2 SDK-only audio, no preview fallback | ✅ Yes | `player.js` lazy SDK inject (no script tag in index.html) |
| D3 prime-on-select + seek/resume + 50 ms poll | ✅ Yes | `playClip()`/`prime()`; no latency compensation |
| D4 PKCE + silent refresh + invalid_grant re-login | ✅ Yes | `auth.js` |
| D5 id-keyed maps in localStorage | ✅ Yes | `storage.js`/`library.js` `tracks`/`albums`/`pool` |
| D6 perishable covers (fetchedAt + lazy re-fetch) | ✅ Yes | `isStaleCover()` + `refreshAlbum()` in games 1/2 |
| D7 eager import + metadata cache | ✅ Yes | import upserts + `getAlbumTracklist()` cache by albumId |
| D8 single apiFetch wrapper (401/429/QUOTA) | ✅ Yes | `spotify-api.js request()` |
| D9 dark-first single theme | ✅ Yes | styles.css tokens (`--bg #121110` etc.), no dual-mode |
| D10 lenient matching cap 2 + alias strip | ✅ Yes | `match.js` |
| D11 all artists required, slot per artist, order-free, no slot burn | ✅ Yes | `matchArtistSlots()` |
| D12 album tracklists cached by albumId, paginate >50 | ✅ Yes | `getAlbumTracklist()` |
| D13 single PR / size exception | ✅ Yes (n/a here) | delivery contract in tasks.md |
| D14 no demo/mock mode | ✅ Yes | empty-library guide instead |
| Router owns mount/unmount (file-tree contract) | ❌ No | mount wired, unmount never assigned to `current` — the only design-coherence break, and it is the CRITICAL |

### Issues Found
**CRITICAL**:
1. **Cleanup-on-exit is never wired** — `src/main.js` declares `current` (line 42) and calls `current?.unmount()` on route change (lines 66–73), but no code ever assigns the mounted game's unmount handle; grep confirms `current` is only ever set to `null`. The games export `unmount()` (`src/games/clip-game.js:15`, `src/games/year-game.js:17`) whose body calls `ctx.player.stop()` (pause + clearInterval + onEnd), but those hooks are dead code. Consequence: navigating away from an audio game mid-clip does NOT pause playback or clear the 50 ms position poll at exit — playback continues until the poll self-stops at position ≥ targetMs (then the interval clears itself), and a game exited before its threshold leaves a dangling interval. This contradicts playback spec "Volume Control and Cleanup" ("MUST clean up on game exit: pause playback, clear the position poll interval") and its scenario "Game exit stops audio and polling". Fix is one wiring line in `route()`/`renderClip()`/`renderYear()` (e.g. `current = { unmount: () => clipGame.unmount() }`); NOT applied here (read-only verification).

**WARNING**:
1. **Runtime items not verifiable in this environment** (no Spotify credentials, no Premium, no browser automation): real PKCE login round-trip and token exchange; SDK connect / `device_id`; clip audible window vs targetMs (100–500 ms SDK latency, 0.1 s feel); CORS behavior; Dev-Mode 30 s quota and real 429 backoff; iOS no-auto-start. All are already carried in `docs/smoke-checklist.md`. No code changes made; re-verify manually after setup.
2. **Prime race on slow SDK init** — `renderClip()`/`renderYear()` call `ensurePlayer()` without awaiting, and `drawRound()` primes immediately; if the device is not ready yet, `prime()` returns false and `round.primed` stays false, so Play is a no-op for that round until Next re-draws and re-primes. Browser-timing only; cannot be reproduced here.
3. **Smoke-checklist wording vs blur guard** — checklist says «Clic para enfocar ×6» but `album-game.js` guards at `step >= BLUR_STEPS.length - 1` (5 effective clicks across the 6 blur levels 30→0 px). Cosmetic; all 6 spec steps exist.

**SUGGESTION**:
1. `pageAll()` caps at 200 pages (10 000 items) — pathological playlists silently truncate vs spec "until exhausted". Acceptable guard; consider documenting.
2. Prime failures surface the generic player banner ("No se pudo conectar el reproductor de Spotify") — a distinct "no se pudo preparar el tema" message would be clearer.
3. `stop()` leaves the SDK device connected (design: session kept for reuse); spec wording says "stop the playback session" — pause + poll-clear satisfies the scenario, but the CRITICAL fix should explicitly decide whether disconnect() is wanted on exit.

### Verdict
**FAIL** — 18/18 tasks complete, 58/58 harness assertions pass, 31/38 scenarios compliant, but 1 CRITICAL spec contradiction (game-exit cleanup never wired in the router) blocks archive; 6 scenarios remain environment-limited (carried in smoke checklist).