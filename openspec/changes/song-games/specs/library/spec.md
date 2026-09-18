# Delta for library

## ADDED Requirements

### Requirement: Import Sources

The system MUST import tracks from user playlists (`GET /me/playlists` then `GET /playlists/{id}/items` per playlist; the `/tracks` endpoint MUST NOT be used), liked songs (`GET /me/tracks`), most-played songs (`GET /me/top/tracks`, the supported stand-in for Spotify's own «Top songs» playlists), whole artists (`GET /artists/{id}/albums` then `GET /albums/{id}/tracks` per release; `/artists/{id}/top-tracks` was removed and MUST NOT be called), search (`GET /search`), and pasted Spotify links. Paged endpoints MUST iterate via `next`/`offset` until exhausted, re-sending the caller's own query parameters — including its page size — on every page. `GET /search` and `GET /artists/{id}/albums` MUST request at most `limit=10`. A playlist row MUST be read through its `item` key (with `track` as the legacy fallback), and rows that carry no importable track MUST be counted and reported, never silently dropped. An import MUST stage what it fetched for the user to confirm; nothing enters the library until they do.

#### Scenario: Playlist import pages to completion

- GIVEN a playlist with 120 tracks
- WHEN the app requests `/playlists/{id}/items` with `limit=50`
- THEN it fetches 3 pages with identical parameters and offers all 120 tracks

#### Scenario: Playlist rows are unwrapped, not read flat

- GIVEN a page of `/playlists/{id}/items` whose rows nest the track under `item`
- WHEN the app reads the page
- THEN every row yields its track, and a `fields` mask that would flatten the row MUST NOT be sent

#### Scenario: Every page asks for the same page size

- GIVEN an endpoint walked with `limit=10`
- WHEN the walk follows `next` to the second page
- THEN that request also carries `limit=10`

#### Scenario: A whole artist collapses duplicate pressings

- GIVEN a song released on an album and again as a single
- WHEN the artist is imported
- THEN the song is offered once, as its album cut

#### Scenario: A missing scope is named, not retried

- GIVEN a session opened before `user-top-read` was requested
- WHEN the user asks for their most-played songs
- THEN the app asks them to sign in again and offers no retry, and calls nothing

#### Scenario: A playlist the user does not own is explained, not failed

- GIVEN a Spotify-made playlist that returns metadata without items
- WHEN the user pastes its link or imports it
- THEN the app states that Spotify withholds the songs and names the workaround

#### Scenario: Search import

- GIVEN the user searches a track query
- WHEN results return from `GET /search`
- THEN matching tracks can be added to the pool one by one

### Requirement: Selection and "Songs I Know" Pool

The system MUST let the user confirm which of a staged import joins "songs I know" — a curated set of `track.id`s that is the random pool for Games 1 & 3 and the membership set for Game 2. The confirmation MUST show every staged track preselected, mark the ones already in the pool as unselectable, and offer select-all / select-none and a text filter. Dismissing it MUST leave the library untouched. The system MUST support removing songs from the pool and MUST display the pool count.

#### Scenario: Selecting tracks into the pool

- GIVEN a staged import of 10 tracks
- WHEN the user unchecks 6 and confirms
- THEN the remaining 4 `track.id`s join "songs I know" and the dialog closes

#### Scenario: Dismissing an import changes nothing

- GIVEN a staged import of 10 tracks
- WHEN the user cancels or presses Escape
- THEN "songs I know" is unchanged

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