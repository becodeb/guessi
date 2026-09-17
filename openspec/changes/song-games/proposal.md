# Proposal: Song-Guessing Games on the User's Spotify Library

## Intent

Personal web toy: song-recognition games against the user's curated Spotify library. Recognition under degraded info — 0.1s clip, blurred cover, year guess — with "reveal more" mechanics. Vanilla JS SPA; UI in neutral Spanish.

## Scope

### In Scope
- Library builder: import from playlists (`/items`), liked songs, search; selection; dedupe by `track.id`; localStorage.
- Game 1 (clip): Play / +0.1s / Next; guess title + all credited artists + album; cover revealed on album solve.
- Game 2 (blurred cover): albums/EPs/singles; guess album + owner artists, then per-track name + featured artists with library-membership marking; next-album button. Blur: 6 clicks (30→0px), unblur on solve.
- Game 3 (year): older/newer + close/far feedback; same clip mechanic.
- Auth: PKCE + silent refresh + re-login on `invalid_grant`; SDK-only playback; lenient matching (`max(1, floor(len/10))`, cap 2) + aliases.

### Out of Scope
- Backend / server-side secrets; Spotify writes beyond playback.
- Removed endpoints (audio-features/analysis, recommendations, related-artists); multi-user/social; framework/bundler.
- Delivery: single PR, single unit — `size:exception` pre-approved.

## Capabilities

### New Capabilities
- `spotify-auth`: PKCE authorize/refresh, re-login.
- `library`: import, selection, dedupe, persistence.
- `playback`: SDK engine, clip control, Premium degradation.
- `matching`: normalize + alias strip + length-scaled Levenshtein.
- `games`: clip/album/year flows, reveal mechanics.

### Modified Capabilities
None.

## Approach

Exploration's forks: prime-on-select + seek/resume + 50ms poll-to-pause clip control; SDK-only audio (previews dead); PKCE + silent refresh + re-login; id-keyed localStorage maps, perishable cover URLs; eager import + metadata cache; 429 backoff.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/auth.js` | New | PKCE, re-login |
| `src/spotify-api.js` | New | Fetch wrapper, backoff |
| `src/player.js` | New | SDK engine, clip control |
| `src/library.js` | New | Import/selection/dedupe |
| `src/match.js` | New | Normalize + alias + Levenshtein |
| `src/storage.js` | New | Schema, perishable covers |
| `src/games/*.js` | New | clip-game, album-game, year-game |
| `index.html`, `src/main.js`, `styles.css` | New | Shell, Spanish UI copy |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Token expiry (6mo) → `invalid_grant` | Med | Silent refresh + re-login |
| Cover URLs expire (<1 day) | High | Perishable flag; lazy re-fetch |
| SDK latency (100–500ms) vs 0.1s clip | High | Prime-on-select; accept longer window |
| Blur reveal feel | Med | Stepped preset; tune after play |
| Dev Mode limits (5 users; 30s quota) | High | 429/`Retry-After` backoff; cache |
| No test runner | Med | Harness for `match.js`; manual checks |
| CORS preflight uncertainty | Low | Verify at runtime |
| iOS no auto-start after transfer | Low | Document |
| `localhost` redirect prohibited | Med | Dev uses `http://127.0.0.1:PORT` |

## Rollback Plan

Greenfield, no deployment: rollback = revert the single PR. No server-side state; localStorage versioned.

## Dependencies

- Spotify Developer app (Client ID, PKCE, redirect `http://127.0.0.1:PORT`); allowlisted user; Premium.
- Web Playback SDK (`sdk.scdn.co/spotify-player.js`).

## Success Criteria

- [ ] Library builds from all 3 sources, dedupes by id, persists across reloads.
- [ ] All 3 games playable end-to-end with correct reveals/solves/misses.
- [ ] Matching accepts typos/accents/aliases; all credited artists required.
- [ ] Free: banner; Library + Game 2 usable; 429 backoff; cover re-fetch; re-login.