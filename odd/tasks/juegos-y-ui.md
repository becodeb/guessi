# Feature: games and UI overhaul ("juegos-y-ui")

Locator: `odd/tasks/juegos-y-ui.md` · Engram mirror: `odd/juegos-y-ui/tasks` (project `guessi`)
Branch: `feat/juegos-y-ui` (from `main` @ `28eca69`)

## Objective

Make guessi feel like a game: every practice game gets stakes (points, streaks,
records), clear feedback and a satisfying answer reveal; the UI gets a
distinctive identity with purposeful motion, a tidy layout on phone and
desktop, and at least one new game that is fun to replay.

## Problem

- The three practice games (`clip`, `album`, `year`) are frozen at day-one
  quality (1 commit each): no score, no streak, no end state, "Siguiente"
  loops forever. `Reproducir` never turns into a stop control; no on-screen
  volume; no start-offset ladder (all exist only in the round).
- Guessing is typing-heavy (title + every artist + album), which turns a
  recognition game into a spelling test, worst on mobile.
- The visual language is generic: near-black + mint accent (reads as a
  Spotify clone and as a known AI default), hub cards numbered 00/01/02/03
  although they are not a sequence, almost no motion (7 keyframes total).
- Components are duplicated (clip bar copied between clip/year, cover-with-
  retry implemented 4 times, artist-slot closure 5 times).

## Why

The user asked for better games and UI, animations, tidy layout and UX,
explicitly "not AI slop", practical and fun, and offered to act as a real
user tester.

## Scope (authorized)

- Visual identity refresh (tokens, type, shape, motion), chrome, login, hub.
- Shared game kit (clip player, scoring/records, reveal, feedback motion).
- Rework of the three practice games' loops.
- New game(s): "Línea de tiempo" (Hitster-style placement). A second new
  game ("Relámpago", multiple choice speed round) is a stretch goal.
- Restyle of the round ("Ronda completa") and the library, keeping behavior.

Out of scope: auth, Spotify API layer, storage codec, lyrics engine logic.

## Constraints

- Vanilla ES modules, no build, zero npm dependencies (Playwright lives in
  `/tmp/pw` for screenshots only).
- UI copy stays Spanish (Rioplatense, matching existing strings); code,
  comments and this document in English; commits in Spanish, Conventional
  Commits, no AI attribution (repo + user convention).
- Premium-only audio: every new mode must degrade for non-Premium.
- Honor `prefers-reduced-motion`; keyboard focus visible; AA contrast.
- `round-game.js` has zero automated coverage: verify it through the
  screenshot harness after every touch.

## Design direction (v1, to validate with the user at the first checkpoint)

"Afiche": the Buenos Aires street gig poster. The chrome is the wall (quiet
charcoal); announcements are fluorescent paper posters with heavy condensed
black type (game names on the hub, the answer reveal, end-of-run results).
Everything else stays calm. Archivo (condensed, 800-900) for display,
Karla for text, both self-hosted.

## Tasks

Route legend: inline = parent edits directly; delegated = one bounded writer.

- [x] T1 Screenshot harness: `harness-app.html` boots the real app with
  stubbed Spotify; `tools/shot.mjs` captures every route (desktop + mobile).
  Route: delegated (writer trigger: new tooling across 2 files + prep reading
  of 6 modules). Check: baseline PNGs render real screens; `npm test` green.
  Evidence: 28 baseline PNGs in `/tmp/guessi-shots/baseline/` reviewed by the
  parent; `npm test` 7/7 suites green (parent spot check). Run with
  `NODE_PATH=/tmp/pw/node_modules node tools/shot.mjs --label <name> [--only <route>]`.
  Baseline findings: hub has no empty-library state; audio games read
  `isPremium()` synchronously at mount (Free accounts see the audio UI first);
  wrong guesses leave no persistent state (160 ms flash only); album game cover
  is 866 px wide on desktop and pushes inputs below the fold; mobile nav wraps
  to two lines.
- [ ] T2 Visual foundation: tokens, self-hosted fonts, chrome (nav, banners,
  toasts, buttons, inputs), login and hub as the poster wall.
  Route: delegated. Check: screenshots desktop/mobile, `npm test`.
- [ ] T3 Game kit: shared clip player (segmented bar, play/stop, skip,
  volume), `scores.js` (streaks/records, unit-tested), reveal poster,
  feedback motion helpers. Route: delegated. Check: unit tests + screenshots.
- [ ] T4 "La primera décima" as a six-step loop with suggestions from
  "Lo que sé", points, streak and reveal. Route: delegated.
  Check: harness interaction shots, `npm test`.
- [ ] CHECKPOINT: send screenshots + local server to the user for real UX
  feedback before rolling the direction out further.
- [ ] T5 "Portada borrosa": steps, points, streak, reveal.
- [ ] T6 "¿De qué año?": one-shot year pick with closeness points, run of 10,
  results poster.
- [ ] T7 New game "Línea de tiempo" (placement logic unit-tested).
- [ ] T8 "Ronda completa" restyle (behavior unchanged) + reveal.
- [ ] T9 Library restyle and mobile pass.
- [ ] T10 Docs: README, smoke checklist.
- [ ] T11 (stretch) New game "Relámpago".

## Acceptance criteria

- Every game has an end state or streak with a persisted record.
- No clip control that cannot be stopped; volume reachable in every audio game.
- Hub cards carry no fake numbering; one poster moment per screen.
- All motion is disabled under `prefers-reduced-motion`.
- Mobile (390px) and desktop (1440px) screenshots show no overflow, no
  clipped labels, no wrapped primary buttons.
- `npm test` green after every task.

## Checks and modes

- TDD: off. Source: `openspec/config.yaml` (`strict_tdd: false`) and Engram
  #1456. Runner: `npm test` (plain-node harnesses). New pure logic still gets
  a `tests/*.test.mjs` harness, following repo convention.
- RDD: on (default, `gentle-ai review mode status`). Per work-unit commit:
  `gentle-ai review assess --base-ref <last reviewed boundary> --committed-only`.
  First boundary: `28eca69`.
- Delivery: `exception-ok`. Source: Engram #1453 (user: "sin límite" for this
  project) and repo policy (direct to `main`, no PRs). Forecast ~3,000-4,000
  authored changed lines. Push/merge remain the user's decision.

## Progress

| Task | Commit | Assessed tier / review outcome | Notes |
|---|---|---|---|
| T1 | `a203a19` | medium, `slice_budget_reached` (932 lines); user granted; reliability lens approved, acknowledged (lineage `review-0cb83b7632bdd94a`) | 6 advisory findings (R3-001..006) fixed in the follow-up tooling commit |

## Next step

T2 (delegated writer). Last reviewed boundary: `a203a19`.
