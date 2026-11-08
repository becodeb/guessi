# Feature: servidor-stats

A small server so lyrics-game history and users live somewhere shared, to show progress
and compare with friends later.

## Objective

Store every play record (see `src/letra-stats.js`) per user on a server, identify users by
their Spotify account, and expose what a future progress/friends screen needs.

## Constraints

- Tiny on purpose: Spotify keeps the app in development mode (5 allowed accounts), so this
  serves the owner and a couple of friends. No scaling work, no own passwords.
- Node 24 + Express, SQLite through built-in `node:sqlite` (no native builds). Only
  dependency: express.
- Deployed by Coolify from `docker-compose.yml` (build pack dockercompose, app
  `ludaqpv0n6zrqs3aecuhyqsk`, domain mapped to service `web`). Keep `web` (nginx) as is,
  add service `api`; nginx proxies `/api/` to it. Data in a named volume mounted at `/data`.
  Coolify prefixes named volumes with the app uuid; that's fine for a new volume, and the
  name stays stable between deploys.
- The game must work exactly as today if the server is down or slow: sync is
  fire-and-forget, never blocks, never shows errors to the player.
- Copy in Spanish with "tú", like the app. Code and comments in English.
- TDD off; ordinary checks. Root `npm test` keeps working without server deps; the server
  has its own `npm test` in `server/`.

## Tasks

- [x] S1 Server: `server/` with Express app, SQLite schema, Spotify-token auth, endpoints, tests, Dockerfile. Route: delegated.
- [x] S2 Compose + nginx proxy + healthcheck. Route: delegated with S1.
- [x] S3 Client sync from the game, never blocking. Route: delegated with S1.
- [x] S4 Deploy and verify persistence across a redeploy. Route: parent.

## S1 spec

- `server/app.js` exports `createApp({ db, fetchMe, now })` so tests inject a fake Spotify
  and a temp database; `server/index.js` wires real ones and listens on `PORT` (3000).
- Auth: `Authorization: Bearer <spotify access token>`. Middleware calls `fetchMe(token)`
  (real one: `GET https://api.spotify.com/v1/me`), caches token -> user for 10 minutes in
  memory (bounded, e.g. 200 entries), upserts `users(id, display_name, image_url,
  created_at, last_seen_at)`. Missing or rejected token: 401 JSON. Spotify unreachable:
  503. Never log tokens.
- `plays` table: primary key `(user_id, id)`; columns for the fields a list or summary
  needs (`started_at`, `ended_at`, `track_id`, `track_name`, `status`, `pct`,
  `words_typed`, `active_ms`) plus the whole record as JSON. Upsert replaces a play only
  when the incoming `endedAt` is not older than the stored one.
- `meta` table with `created_at` set once on first start, returned by health: the signal
  that a redeploy kept the data.
- Endpoints, all JSON:
  - `GET /api/health`: `{ ok, dbCreatedAt, users }`, no auth.
  - `GET /api/me`: the user plus `summarize()` of their plays.
  - `POST /api/plays`: body `{ plays: [...] }`, at most 200 per request, body limit 1 MB.
    Validate each record (schema `v` 1, `game` "letra", `id` string up to 64 chars, ISO
    dates, finite non-negative numbers, strings length-capped); skip invalid ones and
    report `{ saved, skipped }`.
  - `GET /api/me/plays?limit=`: newest first, default 50, max 500.
  - `GET /api/friends`: every user of the app with display name, image, last played, and
    their summary, ordered by words typed this week then all time.
- Reuse `src/letra-stats.js` `summarize()` (copy it into the image; don't fork it).
- Tests (`server/test/*.test.mjs`, `node --test`): auth (missing, invalid, cached, Spotify
  down), upsert and the older-record rule, validation and caps, me, friends ordering,
  health, and that one user can't see or overwrite another's plays by reusing an id.
- `server/Dockerfile`: `node:24-alpine`, `npm ci --omit=dev`, non-root user, `/data`
  owned by it, `HEALTHCHECK` or compose healthcheck hitting `/api/health`.

## S2 spec

`docker-compose.yml`: add `api` (build context `.`, `dockerfile: server/Dockerfile`,
`restart: unless-stopped`, `expose: ["3000"]`, volume `guessi-data:/data`, env `DB_PATH=/data/guessi.db`,
healthcheck with node or wget). `web` keeps everything and `depends_on: api`.
`nginx.conf`: `location /api/ { proxy_pass http://api:3000; ... }` with `no-store`, correct
`Host`/`X-Forwarded-*`, body size 1m, and nginx must still start if `api` is down (use a
resolver + variable, or make the failure a 502 only on `/api/`). `.dockerignore` must
not exclude what the api image needs (`server/`, `src/letra-stats.js`) and must keep
`server/node_modules` out.

## S3 spec

`src/stats-sync.js`: `syncPlays(getToken)` posts records not yet synced (tracked in
`deoido.v1.letraSynced`: id -> endedAt sent) in batches of 100, newest last; debounced
after each save in `letra-game.js` (about 3 s), once at game mount for anything pending,
and with `fetch(..., { keepalive: true })` on page hide. Any failure: silent, retried at
the next trigger. A 401 does nothing special. Pure parts (what is pending, batching) get
tests in root `tests/`. Harness: `/api/*` stubs answering 200 so screenshots stay clean,
plus a request log to assert syncing happens and never blocks typing.

## Progress

S1-S3 in 3822499, c922377, 65d0865, f8773ae. Writer ran the real compose locally: both
services healthy, health 200, bad token 401, app served with api down, dbCreatedAt kept
after down/up. Parent reran root tests (pass) and server tests (16/16).

S4 (2026-11-08): deployed as 94f65ff. Coolify puts both services only on the app's own
network (no name clash with other apps). Live: health 200, bad token 401, no token 401.
Forced redeploy: dbCreatedAt stayed 2026-11-08T03:14:06.551Z, so the volume
`ludaqpv0n6zrqs3aecuhyqsk_guessi-data` survives deploys. Not verified: a real sync with a
real Spotify token (only the owner can do it); no backup of the volume is scheduled.

## Next step

The user plays one song; then `/api/health` should show users: 1. After that, a progress
and friends screen on top of `/api/me` and `/api/friends`.
