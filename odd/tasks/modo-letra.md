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

- [x] T1 Remove the start-offset skip from the clip player kit and the round
  (`OFFSET_STEPS_MS` ladder and its tests go too; the round keeps `fromMs`
  for the tracklist tails). Route: delegated (writer trigger: clip-player,
  round-game, clip-steps, tests, styles). Check: `npm test`, harness shots of
  `clip` and `ronda`.
  Evidence: `npm test` 9/9 green (parent re-run); `rg` finds no offset-ladder
  remnants; shots in `/tmp/guessi-shots/t2-final-ronda/` reviewed by the
  parent (round clip card keeps Reproducir / +0,1 s / Reiniciar only).
- [x] T2 Random start point per song in "La primera décima": pure
  `pickClipStart(durationMs, rng)` (50 % start at 0, else a random point that
  leaves room for the longest clip and the "listen more" tail), decided once
  when the song is drawn, used by every step and by "Escuchar más".
  Route: delegated (same writer as T1). Check: unit tests, `npm test`, shots.
  Evidence: rule = 0 when `rng() < 0.5`, else uniform in
  `[min(10 % of duration, 15 s), duration − max(longest clip, 15 s)]`, 0 when
  that window does not fit; 30 assertions in `tests/clip-steps.test.mjs`
  incl. a seeded ~50 % check over 4000 draws. A chip says «Desde el
  principio» / «Desde algún momento de la canción» (never a timestamp).
  Shots in `/tmp/guessi-shots/t2-final/` reviewed by the parent.
- [x] T3 New lyrics game: start screen (random vs pick a song from «Lo que
  sé»), one short lyric fragment with a few blanks per song, timer, hint and
  "listen to the fragment" help that cost points, run of 5 songs with a
  results poster and persisted record. Pure logic unit-tested.
  Route: delegated (writer trigger: new module + lyrics.js + main.js + styles).
  Check: unit tests, `npm test`, harness shots desktop + mobile.
  Evidence: `src/lyrics-quiz.js` (fragment of 2-4 lines, chorus weighted 4x,
  4-6 blanks with distinct answers; 10 pts/word, up to +20 time bonus,
  -4/hint, -6/listen, +15 perfect; a blank finished by a hint counts as
  missed; streak = consecutive fragments fully typed by the player),
  `lyrics.js` exposes LRC timestamps with a cache `schema` so old entries
  refetch once. `npm test` 11/11 green (parent re-run). First shots were
  functional but flat; parent asked one polish round (reveal poster,
  start screen, word spacing, streak/record semantics). Final shots in
  `/tmp/guessi-shots/t3-polish2/` reviewed by the parent; parent fixed a
  voseo slip in the copy («Vos eliges» → «Tú eliges»).
  Pending: the login collage still shows 4 games; real-device test with
  sound (the harness has no audio).

- [ ] T4 "Canción entera" mode inside «Completa la letra» (user, 2026-09-26:
  the whole song's lyrics, no time limit, more relaxed). Start screen picks
  the mode (timed fragments vs whole song) and then the source (random vs
  pick). Whole song: every word masked, stanzas preserved; typing a word
  fills every occurrence; progress count and %; free help (listen to the
  first incomplete line via LRC timestamps, reveal a line, optional
  first-letter mode); «Me rindo» reveals the rest with missed words marked;
  end poster with % and words found; «Otra canción». Reuses lyrics-engine
  without changing its rules. Route: delegated (same writer as T3).
  Check: unit tests for any new pure logic, `npm test`, harness shots
  desktop + mobile incl. a long song.

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
| plan | `fbd52c7` | this document |
| T1 | `3062078` | RDD off; writer self-verification + parent spot check |
| T2 | `b4e6025` | RDD off; writer self-verification + parent spot check |
| T3 | `ecde786`, `4e28eaa`, `48c9a0c`, `d7964ae` | RDD off; logic, UI, polish round, copy fix |

## Next step

T4 (whole-song mode). Then: 
User test on the LAN harness (`http://192.168.1.37:8093/harness-app.html?demo=1#/juegos/letra`, snapshot of `d7964ae` in `/tmp/guessi-preview`), then merge to `main` and push when the user says so.
