# Delta for playback

## ADDED Requirements

### Requirement: Web Playback SDK Initialization

The system MUST load `sdk.scdn.co/spotify-player.js`, wait for `onSpotifyWebPlaybackSDKReady`, create `new Spotify.Player({name, getOAuthToken, volume})`, and `connect()`. The `device_id` MUST be captured from the `ready` event and used for all playback commands.

#### Scenario: SDK connects and yields a device

- GIVEN a valid Premium token
- WHEN the SDK fires `ready`
- THEN the player stores the `device_id` and targets all commands at it

#### Scenario: SDK failure shows a banner

- GIVEN the SDK fires `not_ready` or `initialization_error`
- WHEN the app receives the event
- THEN a clear error banner appears and the rest of the app stays usable

### Requirement: Prime-on-Select Preloading

The system MUST preload a chosen track via `PUT /me/player/play?device_id=X` with `{uris:[trackUri], position_ms:0}` and immediately pause, on track select and on Next, so Play only needs seek/resume.

#### Scenario: Track is primed before Play

- GIVEN a game selected a track
- WHEN the app primes it and pauses
- THEN the track is loaded on the device awaiting `seek(0)+resume()`

### Requirement: Clip Control

The system MUST implement clip playback: Play MUST call `seek(0)` and `resume()` synchronously within the click gesture, poll `getCurrentState().position` approximately every 50ms, and `pause()` when position ≥ `targetMs`, where `targetMs = 100ms × taps`. "+0.1s" MUST add 100ms to the accumulated clip length; `Next` MUST reset it to 100ms. The system MUST tolerate that the audible window exceeds the requested ms (100–500ms SDK latency) and MUST NOT compensate beyond the poll interval.

#### Scenario: Play stops at the accumulated length

- GIVEN a primed track with 3 taps on "+0.1s"
- WHEN the user presses Play
- THEN playback resumes from 0 and pauses at ≈300ms of position

#### Scenario: Next resets the clip

- GIVEN an accumulated clip of 500ms on track A
- WHEN the user presses Next
- THEN the clip length resets to 100ms for the new track

### Requirement: Premium Degradation

The system MUST detect non-Premium accounts via the SDK `account_error` event or `403 PREMIUM_REQUIRED` from the play endpoint. It MUST show a clear banner that audio games (1 & 3) are unavailable while Library and Game 2 remain fully usable, and MUST NOT crash on audio failure.

#### Scenario: Free account keeps the app usable

- GIVEN a Free account whose Play triggers `account_error`
- WHEN the app handles the event
- THEN a banner explains Premium is needed for audio games and Library + Game 2 still work

### Requirement: Volume Control and Cleanup

The system MUST expose a volume control and MUST clean up on game exit: pause playback, clear the position poll interval, and stop the playback session.

#### Scenario: Game exit stops audio and polling

- GIVEN a game currently playing a clip
- WHEN the user exits the game
- THEN playback pauses, the poll interval is cleared, and no audio continues