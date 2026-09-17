# Delta for games

## ADDED Requirements

### Requirement: Game 1 — Clip Guessing

The system MUST pick a random track from the "songs I know" pool and provide Play / +0.1s / Next with the clip mechanic (clip length resets on Next). The user MUST be able to guess: the title (with typo/alias tolerance), all credited artists via one slot per artist, and the album. The cover image MUST be revealed when the album is solved, and the game MUST show a solved state when all guessable fields are correct.

#### Scenario: Full solve reveals the cover

- GIVEN a random track with its cover hidden
- WHEN the user correctly guesses title, all artists, and album
- THEN the solved state shows and the cover appears

#### Scenario: Next draws a different track

- GIVEN the game just played track X
- WHEN the user presses Next
- THEN a different track is drawn where feasible and the clip resets

### Requirement: Game 2 — Blurred Album Cover

The system MUST pick a random album (album/EP/single) from the library's albums and show its cover blurred. Each click MUST reduce the blur through 6 steps (30/24/18/12/6/0 px); a solve MUST fully unblur. The user MUST guess the album name and owner artist(s). On solve the system MUST reveal per-track fields for every track from `GET /albums/{id}/tracks` (paginated when >50, cached by `albumId`): track name, featured artists (track artists minus album artists by `artist.id`), and a clear mark of whether the track is in the user's library. A next-album button MUST draw a new album.

#### Scenario: Blur steps and solve reveal

- GIVEN an album with a blurred cover
- WHEN the user clicks 3 times and then solves album name and artist
- THEN the cover unblurs and per-track fields are revealed

#### Scenario: Album with no featured artists on a track

- GIVEN a track whose artists equal the album artists
- WHEN the tracklist is revealed
- THEN its featured-artists field shows none, without error

#### Scenario: Album exceeding 50 tracks

- GIVEN an album with 80 tracks
- WHEN the tracklist is fetched
- THEN the app pages `GET /albums/{id}/tracks` and reveals all 80 tracks

### Requirement: Game 3 — Release Year

The system MUST use the same clip mechanic with a release-year guess and MUST give older/newer direction plus a close/far distance hint on each wrong guess.

#### Scenario: Year feedback

- GIVEN a release year of 2019 and a guess of 2015 (|d| = 4)
- WHEN the guess is submitted
- THEN the app replies "newer" with a "close" distance hint

#### Scenario: Far year guess

- GIVEN a release year of 2019 and a guess of 1990 (|d| = 29)
- WHEN the guess is submitted
- THEN the app replies "newer" with a "far" distance hint

### Requirement: Game Edge Cases

The system MUST handle: an empty library (show import guide), an album with a single track, tracks with no featured artists, albums where some tracks are not in the library, and repeated Next presses without immediate repeats where feasible. None of these MAY crash the app.

#### Scenario: Single-track album

- GIVEN an album containing one track
- WHEN Game 2 reveals the tracklist
- THEN the single track is revealed with its library-membership mark

#### Scenario: Empty library blocks rounds

- GIVEN no songs in "songs I know"
- WHEN a game is opened
- THEN the import guide is shown and no round starts