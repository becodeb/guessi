# Tasks: Song-Guessing Games on the User's Spotify Library

## Review Workload Forecast

| Field | Value |
|---|---|
| Estimated changed lines | ~2,800–3,500 (greenfield) |
| 400-line budget risk | High |
| Chained PRs recommended | No (pre-approved) |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Test command | Runtime harness | Rollback |
|---|---|---|---|---|
| 1 | Scaffold shell + router | — | browser `#/login` | revert scaffold |
| 2 | Storage/auth/API | — | real PKCE login | revert files |
| 3 | match.js + harness | `node tests/match.test.mjs` | node CLI | revert match+tests |
| 4 | player + library | `node tests/match.test.mjs` | Premium clip; imports | revert player/library |
| 5 | games + docs | `node tests/match.test.mjs` | manual E2E | revert games/docs |

## Phase 1: Foundation

- [x] 1.1 `index.html` — fonts (Bricolage Grotesque + Karla), `#app`, SVG sprite; no SDK tag
- [x] 1.2 `styles.css` — D9 tokens, components (buttons, inputs, chips, cards, banners, nav, toasts), reduced-motion
- [x] 1.3 `src/config.js` — CLIENT_ID "REPLACE_ME", REDIRECT_URI `http://127.0.0.1:8080/`, 8 scopes, SDK_URL, COVER_TTL_MS
- [x] 1.4 `src/ui.js` — el(), toast(), skeleton(), formatMs(), icon()
- [x] 1.5 `src/main.js` — hash router (5 routes), appState, nav, mount/unmount

## Phase 2: Persistence, Auth, API

- [x] 2.1 `src/storage.js` — deoido.v1.* (tokens, auth_state, library maps); load/save/clear; isStaleCover; version mismatch → discard
- [x] 2.2 `src/auth.js` — PKCE authorize (verifier+S256+state, 8 scopes); state check (mismatch → abort); exchange; silent refresh; invalid_grant → clear + re-login; no token leaks
- [x] 2.3 `src/spotify-api.js` — apiFetch: 401→refresh+retry; 429/QUOTA_EXCEEDED→backoff; endpoints: playlists, liked, search, album(+tracks) ≤50 pages cached

## Phase 3: Core Logic

- [x] 3.1 `src/match.js` — pure: normalize, stripAliases, levenshtein, isMatch (cap 2), matchTitle, matchArtistSlots (order-free, no slot burn), matchAlbum, yearHint
- [x] 3.2 `tests/match.test.mjs` — `node tests/match.test.mjs`: accent/case, punctuation, feat. alias, typo (Bichote), cap 2 (len 40), all artists, order, deluxe album, determinism
- [x] 3.3 `src/player.js` — lazy SDK inject; initPlayer; device_id on ready; prime; playClip (seek+resume, 50ms poll, pause ≥targetMs); stop cleanup; volume; premium/error
- [x] 3.4 `src/library.js` — import playlist/liked/search (limit=50), pending, pool add/remove, getPoolTracks/getAlbums, random draws (no repeat), getAlbumTracklist cached; dedupe by id

## Phase 4: Games

- [x] 4.1 `src/games/clip-game.js` — clip flow (targetMs=100×taps, reset on Next); title+slots+album guesses; cover reveal on solve; solved state; empty → guide
- [x] 4.2 `src/games/album-game.js` — blur 30→0px steps; solve unblurs; album+artist guesses; tracklist: name, featured, membership mark; pages >50; single-track safe
- [x] 4.3 `src/games/year-game.js` — clip + year guess; hints older/newer + very-close/close/far
- [x] 4.4 Wire `main.js`: hub cards, mount/unmount, premium gates 1/3, Library+2 intact

## Phase 5: Docs & Verification

- [x] 5.1 `README.md` — Dashboard app, Client ID → config.js, redirect, `python3 -m http.server 8080`, Premium, iOS caveat
- [x] 5.2 `docs/smoke-checklist.md` — manual: auth flows, import+dedupe, 429, premium, games E2E, empty guide, no repeat, cleanup