# Feature: lyrics game and clip start points ("modo-letra")

Locator: `odd/tasks/modo-letra.md` · Engram mirror: `odd/modo-letra/tasks` (project `guessi`)
Branch: `feat/modo-letra` (from `feat/juegos-y-ui` @ `b3c7c35`, which is `main` + one docs commit)

## Objective

1. A new game played only with a song's lyrics: fun, short runs, a little of
   the song as optional help, and the song either picked by the player or
   drawn at random.
2. "La primera décima" no longer always starts at 0:00: each song decides once
   (when it is drawn) whether its clip starts at the beginning (half the time)
   or at a random point.
3. Remove the start-offset skip ("Saltar silencio" / "Saltar +0,5 s"): the
   user finds it unintuitive and useless in practice.

## Why the skip goes instead of auto-detecting silence

The user asked for automatic leading-silence detection and, failing that,
removal of the skip. Detection is not possible in this app:

- Spotify's `audio-analysis` (where `end_of_fade_in` lived) and
  `audio-features` are deprecated for new apps; `spotify-api.js` never calls
  them.
- The Web Playback SDK plays through EME/Widevine: there is no own `<audio>`
  element for `createMediaElementSource()`, and protected media routed to Web
  Audio comes out silent, so no `AnalyserNode` can measure levels.
- LRCLIB synced lyrics only time the vocals, not the first sound.

## Scope (authorized)

- Clip player kit, "La primera décima", "Ronda completa" offset controls.
- New game module, hub poster, route, nav highlight.
- `lyrics.js` may expose synced line timestamps (cache stays compatible).

Out of scope: auth, Spotify API layer, lyrics-engine rules (shared, tested).

## Constraints

Same as `odd/tasks/juegos-y-ui.md`: vanilla ES modules, zero dependencies,
UI copy in Spanish matching existing strings, code/comments in English,
commits in Spanish Conventional Commits without AI attribution, Premium-only
audio degrades gracefully, `prefers-reduced-motion`, visible focus, AA
contrast. New pure logic gets a `tests/*.test.mjs` harness.

## Tasks

Route legend: inline = parent edits directly; delegated = one bounded writer.

- [ ] T1 Remove the start-offset skip from the clip player kit and the round
  (`OFFSET_STEPS_MS` ladder and its tests go too; the round keeps `fromMs`
  for the tracklist tails). Route: delegated (writer trigger: clip-player,
  round-game, clip-steps, tests, styles). Check: `npm test`, harness shots of
  `clip` and `ronda`.
- [ ] T2 Random start point per song in "La primera décima": pure
  `pickClipStart(durationMs, rng)` (50 % start at 0, else a random point that
  leaves room for the longest clip and the "listen more" tail), decided once
  when the song is drawn, used by every step and by "Escuchar más".
  Route: delegated (same writer as T1). Check: unit tests, `npm test`, shots.
- [ ] T3 New lyrics game: start screen (random vs pick a song from «Lo que
  sé»), one short lyric fragment with a few blanks per song, timer, hint and
  "listen to the fragment" help that cost points, run of 5 songs with a
  results poster and persisted record. Pure logic unit-tested.
  Route: delegated (writer trigger: new module + lyrics.js + main.js + styles).
  Check: unit tests, `npm test`, harness shots desktop + mobile.

## Acceptance criteria

- No "Saltar silencio" / offset skip anywhere in the UI; `npm test` green.
- Over many draws, about half of the clip-game songs start at 0:00; a song's
  start never changes between steps; the start never leaves less than the
  longest clip before the end of the track.
- The lyrics game can be played end to end with a random or a chosen song,
  a run takes a few minutes at most, works without Premium (no audio help),
  and never dead-ends when a song has no lyrics.

## Checks and modes

- TDD: off. Source: `openspec/config.yaml` (`strict_tdd: false`). Runner:
  `npm test`.
- RDD: off globally (user, 2026-09-23). No reviews.
- Delivery: `exception-ok`, repo policy is direct to `main`; push/merge are
  the user's decision.

## Progress

| Task | Commit | Notes |
|---|---|---|

## Next step

T1 + T2 with one writer, then T3.
