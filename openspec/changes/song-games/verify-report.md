```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:2a1d250807de8ce3d191c9650d9f6b69a37f42bda1f85f3106813bb2e5fe631d
verdict: fail
blockers: 0
critical_findings: 0
requirements: 22/22
scenarios: 32/38
test_command: node tests/match.test.mjs
test_exit_code: 0
test_output_hash: sha256:50ed0fa86d37a10baa2ee7e2aed905cd20dd6edf4b68286e514fd3fe72e98def
build_command: "for f in src/config.js src/main.js src/auth.js src/spotify-api.js src/player.js src/library.js src/storage.js src/match.js src/ui.js src/games/clip-game.js src/games/album-game.js src/games/year-game.js tests/match.test.mjs; do cp \"$f\" /tmp/$(basename \"$f\" .js).mjs; node --check /tmp/$(basename \"$f\" .js).mjs; done"
build_exit_code: 0
build_output_hash: sha256:1eb5951c26ec8cf8f41835acea8c8985e6714858ea1bd1c5eda32d7d089dd990
```

## Verification Report (admitted refresh after remediation)

**Change**: song-games
**Version**: N/A (greenfield, no spec version)
**Mode**: Standard (strict_tdd: false) — **verification refresh** admitted by the native runtime against failed evidence revision `sha256:018b6fe3174b1d9ff3bda580437087c6c8938d1e421db697db038e304e89504e` (remediation `sha256:97b9377234782a24f2642ccf731001fab2fefef30afaf13cfb3054d694ce30f6`). This is the single admitted re-verification of the remediation; it is NOT a new independent verification and NOT another correction cycle. The historical failed report is preserved verbatim — see "Previous failed verification (preserved)" below.

### Completeness
| Metric | Value |
|--------|-------|
| Tasks total | 18 |
| Tasks complete | 18 |
| Tasks incomplete | 0 |
| Remediation files changed | 3 (`src/main.js` +5, `src/games/clip-game.js` +5, `src/games/year-game.js` +5; 15 changed lines) |
| Remediation scope | router unmount wiring (`game` field on route defs, `current = def.game ?? null`) + prime-race guard (games 1 & 3) |

### Build & Tests Execution
**Build** (syntax sweep, no build step in this project): ✅ Passed (exit 0)
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
Output bytes identical to the pre-remediation run (hash unchanged), consistent with the remediation touching no matching code.

**Static smoke** (port 8099; 8080/8081 busy with external listeners): ✅ 17/17 files HTTP 200
```text
index.html · styles.css · src/*.js (11) · tests/match.test.mjs · README.md · docs/smoke-checklist.md → 200 each
server killed afterwards — port 8099 confirmed free
```

**Coverage**: ➖ Not available (no coverage tooling; config.yaml `coverage.available: false`)

### Remediation Static Trace (CRITICAL-1 resolution)

| Chain link | Evidence |
|-----------|----------|
| Route defs carry the game module | `src/main.js:33–35` — `/juegos/clip → game: clipGame`, `/juegos/album → game: albumGame`, `/juegos/año → game: yearGame` |
| Router assigns the current view handle | `src/main.js:83` — `current = def.game ?? null` after `def.render(viewHost)`; `current` is no longer permanently null |
| Router runs cleanup on route change | `src/main.js:66–72` — `current?.unmount()` inside try/catch before `app.replaceChildren` |
| Game cleanup bodies | `clip-game.js:15–18` and `year-game.js:17–20` — `unmount()` → `ctx.player.stop()`; `album-game.js:18–19` — `handle = null` (no audio in Game 2) |
| `player.stop()` clears poll + pauses | `src/player.js:174–185` — `clearInterval(pollId)`, `state.player.pause()`, fires `onEnd` once |
| Auth-guard early returns cannot leak | early `return` paths redirect via `location.hash` → the follow-up `hashchange` route call passes the guard and runs `current?.unmount()`; logout additionally calls `player.stop()` directly |

**Prime-race guard (bounded hardening, games 1 & 3)**: `drawRound()` stores the promise (`round.priming = ctx.player.prime(...)` — `clip-game.js:66`, `year-game.js:90`); the Play click handler is async and awaits the in-flight prime before playing (`clip-game.js:96–102`, `year-game.js:119–122`), then re-checks `round.primed`; a failed prime still degrades to a silent no-op with no new state. Continuation ordering is safe: `round.priming.then(...)` is registered before the click's `await`, so `round.primed` is set before the resumed click checks it. `if (round.playing) return` still precedes the await, so no double-play. No new failure mode found by inspection; the `await` crossing the click gesture is a runtime-only nuance (see WARNING 3).

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
| playback · Volume Control and Cleanup | Game exit stops audio and polling | **Remediated**: route defs carry `game:` (main.js:33–35), `route()` assigns `current = def.game ?? null` (main.js:83), `current?.unmount()` runs on route change (main.js:66–72) → `clip-game.js`/`year-game.js` `unmount()` → `player.stop()` clears the 50 ms poll and pauses (player.js:174–185); album-game unmount nulls its handle | ✅ COMPLIANT (verified-by-code — full wiring trace, formerly FAILING) |

**Compliance summary**: 32/38 scenarios compliant (11 verified-by-test, 21 verified-by-code) · 6 not-verifiable-here (environment-limited) · 0 failing · Requirements 22/22 complete (playback "Volume Control and Cleanup" now complete).

### Correctness (Static Evidence)
| Requirement | Status | Notes |
|------------|--------|-------|
| PKCE params / state / 8 scopes / storage / silent refresh / invalid_grant | ✅ Implemented | `auth.js` + `config.js`; unchanged by remediation |
| `/playlists/{id}/items` usage; `/tracks` never used | ✅ Implemented | `spotify-api.js getPlaylistItems()`; grep: no `/tracks` endpoint in code |
| Paging ≤ 50 | ✅ Implemented | `pageAll()` limit=50 via next/offset; playlists, liked, album tracks |
| 401 → refresh-once, 429 → Retry-After backoff | ✅ Implemented | `request()` retried flag; Retry-After (default 5 s, capped 30 s); QUOTA_EXCEEDED 403 handled |
| Prime-on-select + seek(0)+resume() in gesture + 50 ms poll at 100 ms × taps + reset on Next | ✅ Implemented | `player.js playClip()`; `drawRound()` reset in games 1/3; prime race guard added (await in-flight prime) |
| Premium degradation keeping Library + Game 2 usable | ✅ Implemented | premium gate only in clip/year games; album game + library ungated |
| Cleanup on view unmount | ✅ FIXED (was CRITICAL-1) | `current = def.game ?? null` — router lifecycle now live; trace in "Remediation Static Trace" above |
| Three game flows + reveals + membership marks | ✅ Implemented | clip solve/cover reveal; blur steps + tracklist + featured-by-id + marks; year hints + reveal |
| Empty-library guide | ✅ Implemented | `ui.emptyGuide()` in all 3 games + library view |
| No secrets | ✅ Implemented | grep: no client_secret/api key/password; CLIENT_ID placeholder only in config.js + main.js guard |
| No removed endpoints in code | ✅ Implemented | grep: only comments stating they are never called |

### Coherence (Design)
| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 vanilla ES modules + hash router | ✅ Yes | `main.js` ROUTES; module-per-area split matches file tree |
| D2 SDK-only audio, no preview fallback | ✅ Yes | `player.js` lazy SDK inject (no script tag in index.html) |
| D3 prime-on-select + seek/resume + 50 ms poll | ✅ Yes | `playClip()`/`prime()`; no latency compensation; prime-race guard strengthens it |
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
| Router owns mount/unmount (file-tree contract) | ✅ Yes (fixed) | was ❌ in the failed run; now `current = def.game ?? null` per route |

### Issues Found
**CRITICAL**: None. CRITICAL-1 (cleanup-on-exit dead code) is resolved by the remediation: route defs carry `game:` (main.js:33–35), `route()` assigns `current = def.game ?? null` (main.js:83), and the existing `current?.unmount()` lifecycle (main.js:66–72) now runs each mounted view's cleanup on route change — `player.stop()` (clearInterval + pause) for games 1 & 3, handle null for game 2. No new CRITICAL found by the re-trace.

**WARNING** (environment-limited / pre-existing — no code changes made):
1. **Runtime-only items not verifiable here** (no Spotify credentials, no Premium, no browser automation): real PKCE login round-trip; SDK connect / `device_id`; clip audible window vs targetMs (100–500 ms SDK latency, 0.1 s feel); CORS behavior; Dev-Mode 30 s quota and real 429 backoff; iOS no-auto-start. All already carried in `docs/smoke-checklist.md`; manual re-verification required after setup.
2. **Pre-existing album-game late-callback note** (out of remediation scope, left untouched): async callbacks in `album-game.js` (`refreshAlbum().then` in `drawAlbum`, `revealTracklist` after fetch) touch `handle.container` / captured elements; if the user navigates away mid-fetch, `handle` is null and the late callback can throw an unhandled rejection (app stays usable; no crash of the running view). Not introduced by this remediation; tracked here and in `remediation-evidence.json`.
3. **Prime-guard gesture nuance (runtime)**: the Play click `await round.priming` resumes in a microtask after the prime PUT completes; a sub-second wait stays within browser transient-activation windows, but this is only provable in a real browser with a real device. Failed primes still degrade to a silent no-op — by design.

**SUGGESTION**:
1. `pageAll()` caps at 200 pages (10 000 items) — pathological playlists silently truncate vs spec "until exhausted". Acceptable guard; consider documenting.
2. Prime failures surface the generic player banner ("No se pudo conectar el reproductor de Spotify") — a distinct "no se pudo preparar el tema" message would be clearer.
3. `stop()` keeps the SDK device connected (design: session kept for reuse); spec wording says "stop the playback session" — pause + poll-clear satisfies the scenario; decide explicitly if `disconnect()` is wanted on exit.

### Previous failed verification (preserved)
The historical failed report is preserved **verbatim** (exact admitted bytes, no edits):
- File: `openspec/changes/song-games/verify-report-018b-failed.md` (sha256 `e89f62ff29282ef1e5dcc9f0e2a14d5c3e0ea94a28b902920c0847006c0cdbf0`)
- Failed evidence revision: `sha256:018b6fe3174b1d9ff3bda580437087c6c8938d1e421db697db038e304e89504e` (verdict `fail`, 1 CRITICAL: cleanup-on-exit dead code; 31/38 scenarios, 21/22 requirements)
- Remediation evidence: `openspec/changes/song-games/remediation-evidence.json` (revision `sha256:97b9377234782a24f2642ccf731001fab2fefef30afaf13cfb3054d694ce30f6`, 3 files / 15 changed lines, focused test 58/58, syntax 13/13, smoke 17/17, wiring + prime traces)
- Attempt ledger: verify attempt 1 `failed` (evidence 018b…), remediation attempt 2 `passed` (`remediates_evidence_revision` 018b…, evidence 97b937…), current verify objective generation 3 with the orchestrator's acquired attempt.

### Verdict
**FAIL (evidence incomplete — no code defect)** — The native validator admits a passing verdict only with complete evidence (`completed == total`), and 6 of 38 scenarios remain environment-unverifiable here (no Spotify credentials, no Premium, no browser automation). Counting them complete would fabricate PASS, which this refresh refuses. Therefore the envelope verdict is `fail` with `blockers: 0` and `critical_findings: 0`: CRITICAL-1 is resolved and re-traced end-to-end; all executable evidence passes (58/58 harness, 13/13 syntax, 17/17 smoke); 32/38 scenarios compliant, 0 failing, requirements 22/22. The change is NOT archive-ready until the 6 runtime scenarios are exercised manually per `docs/smoke-checklist.md` (or an explicit project convention admits code-trace evidence for them). No code was modified by this verification.

**Admission note**: `gentle-ai sdd-verify-validate --requirements 22 --scenarios 38` admitted these exact bytes (`valid: true`, verdict `fail`; evidence_revision as declared in the envelope above). The pass_with_warnings form of this report (32/38) was tested and denied by the validator ("passing verdict contradicts failing or incomplete evidence"); a fail-with-incomplete-evidence report is valid and persistable but not archive-ready.