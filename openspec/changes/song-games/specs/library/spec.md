# Delta for library

## ADDED Requirements

### Requirement: Import Sources

The system MUST import tracks from user playlists (`GET /me/playlists` then `GET /playlists/{id}/items` per playlist; the `/tracks` endpoint MUST NOT be used), liked songs (`GET /me/tracks`), and search (`GET /search?type=track`). Paged endpoints MUST request `limit=50` and iterate via `next`/`offset` until exhausted. Imported tracks MUST populate a pending list awaiting user selection.

#### Scenario: Playlist import pages to completion

- GIVEN a playlist with 120 tracks
- WHEN the app requests `/playlists/{id}/items` with `limit=50`
- THEN it fetches 3 pages and all 120 tracks appear in the pending list

#### Scenario: Search import

- GIVEN the user searches a track query
- WHEN results return from `GET /search?type=track`
- THEN matching tracks appear in the pending list

### Requirement: Selection and "Songs I Know" Pool

The system MUST let the user select tracks from the pending list and add them to "songs I know" — a curated set of `track.id`s that is the random pool for Games 1 & 3 and the membership set for Game 2. It SHOULD offer an "add all" aid. The system MUST support removing songs from the pool and MUST display counts of pending and selected tracks.

#### Scenario: Selecting tracks into the pool

- GIVEN a pending list with 10 tracks
- WHEN the user selects 4 and confirms
- THEN those 4 `track.id`s join "songs I know" and the pending list shrinks

#### Scenario: Removing a known song

- GIVEN a song in "songs I know"
- WHEN the user removes it
- THEN the song no longer appears in game pools or membership marks

### Requirement: Dedupe and Persistence

The system MUST dedupe tracks by `track.id` across all sources and albums by `album.id`. It MUST persist a versioned localStorage schema: a `library` map (tracks keyed by id), an `albums` map, a schema `version`, and a `fetchedAt` timestamp. Cover image URLs MUST be stored with `fetchedAt`, treated as perishable, and lazily re-fetched when stale or broken. On a `version` mismatch the system MUST migrate or reset cleanly.

#### Scenario: Dedupe across sources

- GIVEN a track already in the pool
- WHEN the same track is imported again from another playlist
- THEN the pool still holds exactly one entry for that `track.id`

#### Scenario: Perishable cover re-fetch

- GIVEN a stored cover URL older than the perishable window
- WHEN a game renders that album
- THEN the app re-requests the album and updates the stored URL

### Requirement: Empty State and Import Guidance

The system MUST show guidance when the pool is empty, directing the user to import from playlists, liked songs, or search before starting games.

#### Scenario: Empty pool shows import guide

- GIVEN no songs in "songs I know"
- WHEN the user opens a game
- THEN the game shows an import guide instead of a round