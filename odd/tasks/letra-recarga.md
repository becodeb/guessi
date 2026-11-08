# Feature: letra-recarga

Reloading the page in the lyrics game brings the player back where they were.

## Objective

Today a reload loses the list being played and every word typed. Keep what is worth
keeping, on this device, and come back to it paused.

## What is saved

- The queue: songs (compact track objects: id, uri, name, artists names, album name and
  images, duration), original order, current order (shuffle included), current index,
  shuffle on/off, repeat on/off.
- Per song of that queue with progress: revealed words and how each was revealed, hint
  letters given and confirmed, cursor, streak, best streak, misses, jumps; the playback
  position to resume from; the history record's `playId`, `t0` and `activeMs`, so the same
  record keeps updating instead of a duplicate.

## What is not saved, on purpose

- The half-typed word and the swallowed tail.
- Audio state: after a reload the song is always paused, never resumed (the session
  rule: no Spotify request before the player presses play).
- Scroll position, open sheet or dialog.

## Rules

- Mount with a saved session: go straight to the play view on the saved song, paused.
- Back to the picker keeps the session; the picker shows a first tile "Seguir con
  «<canción>»" with "Canción n de m" that restores it.
- Starting another list replaces the session.
- Sessions older than 7 days are dropped.
- Each song's progress carries a signature of its lyrics (word count plus a hash of the
  words' texts). If the lyrics loaded now differ, that song starts fresh; the rest stays.
- Saving never blocks: debounced (about 1 s) after engine events and queue changes,
  plus on `pagehide` and `visibilitychange` hidden. A failed write is silent.
- Storage key `deoido.v1.letraSession`, through `storage.js`, compact: revealed+how as one
  string with one character per word (e.g. `.` open, `t` typed, `h` hint, `l` line,
  `r` repeat, `g` gave up), hints as a sparse map.

## Tasks

- [x] R1 Engine `snapshot()` / `restore(snap)` in `src/lyrics-typing.js`, queue snapshot/restore in `src/lyrics-queue.js`, pure `src/letra-session.js` (encode, decode, signature, expiry, track compaction), storage helpers, tests. Route: delegated.
- [x] R2 Wiring in `src/games/letra-game.js` and the picker tile, harness check of a real reload. Route: delegated with R1.

## Checks

- Unit tests for snapshot/restore round trip (including chorus, hints, give up, jumps),
  queue restore (shuffled and not), signature mismatch, expiry, corrupt JSON.
- Browser (harness keeps `localStorage.clear()` on load; add a way to keep storage, e.g.
  `?keep=1`, without changing default behaviour): type words, Tab past one, use a hint,
  go to song 2, reload: same song, same words, cursor where it was, paused, 0
  `/me/player` requests; back to the picker shows the tile; the tile restores; starting a
  new list replaces it; a finished song comes back finished.
- Root `npm test` passes.

## Progress

R1 and R2 in 9950c47, f657e31, a87114f (harness `?keep=1`). Writer ran every check in
Checks against real lyrics: reload restores song, words, cursor and hint, paused, 0
/me/player requests; position resumes on play; picker tile; shuffle and repeat; new list
replaces; expired, corrupt and changed lyrics handled. Parent reran `npm test` (pass)
and a reload in the browser (4 words and the cursor kept, 0 player requests).
Not checked on a phone viewport.
