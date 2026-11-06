# Feature: letra-karaoke

Full-screen rebuild of "Completa la letra" as a Spotify-lyrics-style typing game.

## Objective

The user types a song's lyrics word by word, on a clean, immersive, big-type
screen, with a real transport bar (play/pause, seek, prev/next, shuffle,
repeat), choosing one song or a playlist. It must be forgiving and fun: urban
Spanish lyrics (Lucho RK, Quevedo) are full of elisions the player would type
differently.

## Constraints

- Vanilla ES modules, no build, zero dependencies. `npm test` runs plain node harnesses.
- UI copy in neutral Spanish using "tú", like the rest of the app.
- **Never take over the user's Spotify session before they press play.** No
  `PUT /me/player/play`, no `prime()`, no transfer on mount, on picking a song,
  on seeking or on skipping while paused. Connecting the SDK device is allowed
  (it registers a device, it does not transfer playback).
- Repo fixtures must never contain real lyrics: invent every test line. Single
  contraction tokens such as `pa'` are fine.
- TDD mode: off (no project TDD config found); ordinary tests + browser checks.
  Runner: `npm test`. RDD: off (global, read with `gentle-ai review mode status`).
- Delivery strategy: ask-on-risk. Work-unit commits on `feat/letra-karaoke`;
  push and deploy are the user's call.

## Scope decisions

- Route `#/juegos/letra` = the new game. Old "Contrarreloj" stays, reachable at
  `#/juegos/letra/contrarreloj` via one quiet link in the picker.
- "Canción entera" is replaced: remove its code from `src/games/lyrics-game.js`,
  the mode step, `src/lyrics-fullsong.js`, its test, and the lyricsGameMode
  storage helpers (nothing else reads them; grep to confirm).
- Punctuation stays hidden until its word is revealed. Backing vocals
  (parentheses) and pure interjections never need typing.

## Real-lyrics findings (44 songs from LRCLIB, 2501 lines)

- Trailing `'` is mostly a dropped s: `vamo' cosa' loca' ere' lo'`; also
  `pa' to' na' ve' má' die' ajedre' cu' cora'`.
- Mid `'`: `salgo'el cuerpo'e canso'e vo'a pa'l to'l pa'llá pa'trá a'lante la'o
  pasa'o peca'o callaí'ta to's toa'`. Leading: `'e 'toy 'tamos 'cause`.
- English: `i'm we're we'll you're wasn't commin' 'cause`.
- **Cyrillic homoglyphs inside Spanish words** (`еl`, `еs`, `еscondida`): must be
  mapped to Latin or the word is untypable. Also U+FFFC junk characters.
- **Spaced letters**: `L a k e n o s h i` (3+ single-letter tokens in a row) is one word.
- Times `10:00 1:00 3:00`, `L.A`, `2025`.
- Hyphens: `eh-eh yeah-yeah-yeah oh-oh ey-yeah yah-yah woh-oh hmm-mm na-na da-ra
  paw-paw` (fillers); `due-e-e-e-e-e-elen A-a-ando Ba-baby Dando-dándote
  Bando-bandolera tarde'-e'-e' Lint-oh-oh-on` (stutter of a real word);
  `lu- cu- cora- -piento -sa` (cut-offs); `glow-up blin-blin Two-stepping` (compounds).
- Parens: usually end of line, echo or filler: `(eh-eh, eh-eh)`, `(Now)`, `(-piento)`;
  sometimes the whole line, `(Chinga como baila, …)`; or inside: `Dale (Dale, guáyame), dale`.
- Synced LRC lines are often longer than Spotify's (two phrases in one line).

## Design

Flood: the whole screen takes one saturated dark color from the song's cover,
Spotify-lyrics style. Hidden words are bare underlines, sized to the real word
so nothing reflows on reveal. The only accent is a yellow caret (`#f5e642`, the
app's paper-yellow) on the current word. App nav is hidden while playing.

- Type: Archivo (already self-hosted, variable), weight 800, tracking -0.03em,
  `clamp(1.75rem, 4.4vw, 3.75rem)`, line-height ~1.18, left-aligned, column
  ~1040px max. No Karla inside the lyrics.
- Color tokens per song on the game root: `--song` (flood), `--song-deep`
  (bar, mix with ~55% black), filled text white at ~78%, current line pure
  white, underlines white ~38%, future lines dimmer, backing white ~45%.
  Spark `#f5e642` only for caret and active shuffle/repeat. Cover sampled
  through a canvas (i.scdn.co sends `ACAO: *`, verified); clamp to S≥45%,
  L 20–30% so white passes contrast. Fallback palette hashed by track id:
  `#5a0a14 #0b3d2e #1a2a6c #4a1a6b #6b3a00 #0a4a5a`.
- No cards, no borders, no all-caps labels, no monospace, no middle-dot strings.
- Layout: full viewport. Small top row (back arrow, "n de m" + progress hairline
  right). Lyrics scroller with the cursor line held ~38% from top and top/bottom
  fade masks. Bottom bar three columns: cover+title+artist | transport+seek |
  help icons+volume. Under ~720px: cover/title row above transport.
- Motion answers actions only: word pop on reveal, shake on miss, smooth scroll,
  one flood pulse on line complete. Respect prefers-reduced-motion.

## Tasks

- [x] T1 Pure parser and typing engine with tests (`src/lyrics-parse.js`, `src/lyrics-typing.js`). Route: delegated.
- [x] T2 Continuous playback API in `src/player.js`, with tests where pure. Route: delegated with T3.
- [x] T3 New game UI + picker + routing + CSS + cleanup of Canción entera (`src/games/letra-game.js`). Route: delegated.
- [x] T4 Optional AI variant enrichment (`src/lyrics-ai.js`). Route: delegated with T3.
- [x] T5 Harness (`?real=1`), browser verification with real LRCLIB lyrics, LAN URL for the user. Route: parent checks screenshots.

## T1 spec: `src/lyrics-parse.js`

`parseLyrics({ text, synced })` → `{ lines, words }`. Uses `synced` (`{ms,text}[]`)
when non-empty, else `text` split by newline.

Cleaning per line: map Cyrillic homoglyphs to Latin (а е о р с у х і ѕ, both
cases), drop U+FFFC and other control/format chars, unify ’ ` ´ to `'`; drop
section/meta lines: `[...]`-only, `^\w[\w ]*:$`, `x2`/`(x2)`.

Output `lines[i] = { ms|null, endMs|null, tokens, signature }`.
Token kinds, in order, keeping attached punctuation in `pre`/`post` strings:
- `word`: must be typed. `{ kind:"word", text, pre, post, wordIndex, forms:Set<string>, keys:Set<string> }`.
- `filler`: interjection, never typed, always visible, dim.
- `backing`: anything inside `(...)`, never typed. Parens may span several tokens;
  unbalanced `(` runs to line end. Tokens keep their parens in pre/post.

`words` is the flat list of `word` tokens in reading order with `{ line }`.
`signature` = the line's word keys joined (for chorus repeats); lines with no
word tokens get an empty signature.

Merge 3+ consecutive single-letter tokens into one word (`L a k e n o s h i` →
text as written with spaces, form `lakenoshi`).

Filler: every hyphen segment matches an interjection list (eh, ey, ah, oh, uh,
uy, ay, mm, hmm, yeah, yeh, yah, wow, woh, woah, uoh, hey, ja, je, aja, prr, brr,
with elongations: `eeeh`, `ayyy`, `yeah-eah`); or a repeated-syllable chain:
2+ hyphen segments, each ≤3 letters (`na-na`, `da-ra`, `paw-paw` counts too).
A bare `a e o la na` alone is NOT a filler; `no-no` as a chain is fine.

## T1 spec: forms (what the player may type)

`looseKey(s)`: homoglyphs→Latin, lowercase, strip accents and non-alphanumerics,
then phonetics in this order: `ch`→protected; `qu`→k; `c`+e/i→s; `c`→k;
`z`→s; `x`→s; `v`→b; `ll`→y; `h` removed; `ge/gi`→`je/ji`; final `ado`→`ao`,
final `ido`→`io` (with optional s); final `y`→i; final `s` dropped, final `d`
dropped, final `l`→r; collapse repeated letters. Never reduce to empty: fall back
to the plain stripped word.

`buildForms(rawWord)` returns plain forms (stripped of everything, spaces removed).
Always the bare word. Plus:
- Trailing `X'`: X, X+s, X+d, X+r, X+g (`commin'`), and dictionary.
- Leading `'X`: X, es+X, and dictionary (`'e`→de, `'toy`→estoy, `'cause`→because, cause, cuz).
- Mid `X'Y`: XY, X+Y spaced, X+s+Y (`mi'mo`), X+d+Y (`la'o`, `pasa'o`); every X
  dictionary form crossed with every Y form; Y dict: `e`→de, `el`→el+del, `l`→el, `a`→a.
- English: `'re`→are, `'ll`→will, `'m`→am, `'s`→is, `n't`→not.
- Dictionary, both directions (a written `para` also accepts `pa`): pa=para,
  to=todo/toda/todos/todas, to's=todos, toa=toda, na=nada, ma=mas, e=es,
  ve=vez/ves, pue=pues/puede, cu=culo, cora=corazon, compa=compañero/compadre,
  pal=para el, palla=para alla, paca=para aca, patra=para atras, palante=para
  adelante, alante=adelante, voa=voy a, tol=todo el, q=que, xq=porque, tb=tambien,
  baby=beibi/bebe/babe, uste=usted, verda=verdad, ta=esta/estas, toy=estoy, tamos=estamos.
- Hyphens: joined, last segment, joined with repeats collapsed
  (`due-e-e-elen`→duelen, `a-a-ando`→ando), each segment stripped of trailing `'`.
  Trailing `-` (cut-off): the stem; leading `-` likewise.
- Digits: small cardinals 0–20, 100 accept the word (`2`→dos, `1`→uno/un/una).
  Times `10:00` accept `10`, `diez`, `1000`. Dots dropped (`L.A`→la).

Every form also contributes its `looseKey` to `keys`. Forms with a space collapse
it and remember prefixes (see below).

`acceptsWord(word, typed)`: plain forms or keys equal. `fuzzyAccepts(word, typed)`:
`levenshtein(looseKey(typed), key) ≤ 1` when key length ≥5, ≤ 2 when ≥9.

`addForms(word, extraRaw[])` adds AI forms to one word.

## T1 spec: `src/lyrics-typing.js`

`createTypingGame(parsed)`, pure and deterministic. State per word: revealed,
how (`typed|hint|line|repeat|giveup`), hintLevel. Tracks `cursor`, `buffer`,
`tail`, `streak`, `bestStreak`, `misses`.

- `setBuffer(value)` is the single entry for typed text (UI uses a hidden input):
  strip everything but letters/digits/spaces (accents kept for display). Returns
  events `{ type:"typing"|"reveal"|"miss"|"hold"|"done", index?, repeated?:number[] }`.
  - Ends in whitespace → `commit`. Otherwise, if the word's plain/keys accept the
    whole buffer → auto-reveal, advance, remember the typed plain for the tail.
- Tail: after an auto-reveal, further characters that continue a longer form of
  the just-revealed word are swallowed invisibly (`to`→reveal, `do` swallowed for
  `todo`; `vamo`→reveal, `s` swallowed). A character that breaks that continuation
  flushes tail+char into the new current buffer. A space clears the tail silently.
- `commit()`: empty buffer → no-op. Exact or fuzzy accept → reveal. If the buffer
  is a strict prefix of a multi-word form (`voy` for `vo'a`, `salgo` for
  `salgo'el`, `para` for `pa'l`) → `hold` keeping the text. Otherwise `miss`:
  clear, streak 0, misses+1.
- `hint()`: raises hintLevel; at full length reveals with how=`hint`. Hint letters
  are displayed only while the buffer is empty.
- `revealLine()`, `moveCursor(i)`, `nextWord()`, `prevWord()` (unrevealed only, wrap),
  `giveUp()`.
- Streak counts only how=`typed` reveals. Hint/line reset it.
- Chorus: once every word of a line is revealed, every later or earlier line with
  the same non-empty signature auto-reveals (how=`repeat`), returned in `repeated`,
  never moving the cursor backward. Empty song (no words) → `done` right away.
- Getters: `stats()` `{ total, typed, helped, repeated, bestStreak, misses, pct }`,
  `isRevealed(i)`, `hintLevel(i)`, `cursor()`, `buffer()`, `isDone()`, `lineOf(i)`.
  `isBackingVisible(lineIdx, tokenIdx)`: true when all word tokens before it in the
  line are revealed and (it has a preceding word token OR the cursor's line ≥ lineIdx
  OR all earlier lines are complete).

## T2 spec: player

Additive to `src/player.js`. Don't change `prime`/`playClip` behavior:
- `state.free`; the silence guard pauses only when `!clipActive && !free`.
- `playTrack(uri, { positionMs })`: `PUT /me/player/play?device_id=` (this is the
  moment playback moves to this tab); sets free and owned uri; handles PREMIUM_REQUIRED
  like `prime`. Waits up to 5 s for `deviceId`. Calls `bestEffortActivate()` synchronously.
- `isOwning(uri)`: free, uri matches, last SDK state non-null.
- `resumeFree()`, `pauseFree()`, `seekFree(ms)`, `stopFree()`.
- `onPlayback(cb)`: `{ paused, position, duration, uri, ended, lost, at }` from
  `player_state_changed`. `lost`: state null (playback moved to another device) →
  owned cleared; the next play does `PUT` again. `ended`: paused, position 0, and
  the track is in `track_window.previous_tracks`.
- `stop()` also clears free.

## T3 spec: game UI

`src/games/letra-game.js` exports `mount(container, ctx)` / `unmount()`.
Sets `document.body.dataset.immersive` so CSS hides the nav and frees the container.

**Picker** (flood in default color): a large search field ("Busca una canción o
pega un enlace de Spotify"); debounced `api.searchCatalog` (tracks and albums);
`parseSpotifyRef` for pasted track/album/playlist links through
`library.previewRef`. Below, quick sources: "Lo que sé", "Canciones que te gustan"
(`previewLiked`), "Tus más escuchadas" (`previewTopTracks`), then the user's
playlists (`getPlaylists`, filtered to owner = `getMe().id` or collaborative;
others return no tracks, see `UnreadablePlaylistError`). Quiet link: "Jugar
contrarreloj". Each error says what happened and what to do.

**Queue**: tracks + index, in memory. Order as given. Shuffle reshuffles the
remaining songs, keeps the current one; turning it off restores the original order.
Prev/next keep a per-track game (a `Map` by track id), so going back resumes.
Tracks without usable lyrics are skipped with a toast in a queue; alone, a message
and back to the picker. Repeat toggles replay of the current song at its end.

**Playback rules**: always starts paused and no network until first play.
- Play with `isOwning` false: `playTrack(uri, { positionMs: pending })`; spinner
  while pending. Seek while not owning only stores `pending`.
- Next/prev: if audibly playing, the new song plays; if paused, it stays paused and
  sends nothing.
- `lost` → UI shows paused, nothing else. `ended` → stop at 0 unless repeat.
  Never auto-advance on song end.
- Unmount: `stopFree()` only if we own playback.
- Not Premium / SDK unavailable: game fully playable, transport disabled with one
  line explaining why. Check `ctx.player.isPremium()`.

**Sung line**: from synced times, the line at the playback position gets a brighter
tone + small marker. The scroll always follows the cursor, never the audio. No
times → seek and "escuchar esta línea" hide or disable.

**Slots**: inline-grid with the invisible word text and the typed text in the same
cell, so width = max(word, typed) with an underline; `aria-hidden` on the ghost.
Current slot gets the caret. Revealed slot shows the real text + pre/post. Hidden
punctuation uses `visibility:hidden` to keep width. Click on a slot moves the cursor.

**Keys**, on a hidden focused `<input>` (font-size ≥16px; `input` event so Windows
dead-key accents work; refocus after any click except controls):
Space/Enter commit; Enter on empty = hint; Tab / Shift+Tab next/prev word;
Shift+Enter reveal line; Ctrl+Space play/pause; Ctrl+Enter listen from this line;
Ctrl+←/→ prev/next song. A `?` icon lists the keys in a small dialog.

**Bar icons**: pista, revelar línea, escuchar esta línea, ver toda la letra
(give up, with confirm), volume. Inline SVG: add symbols to `index.html` next to
the existing `#i-*` ones (shuffle, prev, next, repeat, pause, play…), with
`aria-label` and tooltip. Spotify-like transport: white round play, 12px seek line
turning spark on hover.

**Streak**: only shown from 5 up, small, top row.
**Finish**: the screen stays; a small panel rises over the bar: pct, words typed by
you, helped, repeated, best streak, time; "Siguiente canción" (Enter) or "Elegir
otra". Missed words after giving up keep a distinct tint.

Hub card copy in `src/main.js` updates to match the new game. Also add
`letra-contrarreloj` to game views/nav active logic.

## T4 spec: `src/lyrics-ai.js`

`enrichForms(parsed, { signal })`: collect unique words with `'` or `-`, not yet
cached (localStorage key via `storage.js`, map raw word → forms). Max 40 per
request. `POST https://ai-router.becode.com.ar/chat` with `{ messages }`, asking
for JSON only `{ "palabra": ["forma completa"] }`. Protocol: `await res.text()`;
check content-type is event-stream; split on `\n\ndata: `, strip the first `data: `
by position, never trim; concat; stop at `[DONE]`; tolerant JSON extract (fence,
outermost braces); one retry if unparseable. Failures are silent, the game never
waits on it. Never expose it in the UI. Applies via `addForms`.


## Phone round (2026-11-06)

User asked that the game works and looks good on phones, using the Spotify Android
lyrics screen as inspiration only. Their phone is Android. Spotify docs say the SDK
supports mobile with autoplay and iOS limits; community reports say some phones stay
silent, and this cannot be tested here, hence the fallback.

- [x] T6 Reliable typing with on-screen keyboards. Route: delegated.
- [x] T7 Phone layout. Route: delegated.
- [x] T8 Sound on phones: SDK first, Spotify app fallback. Route: delegated.

### T6 spec

Gboard and similar keep a composing region; writing `input.value` during composition
duplicates or resurrects text. While composing, never write to the input: keep a
`consumed` offset, feed the engine `value.slice(consumed)`, and after each engine call
move the offset so the text fed equals `game.buffer()`. On `compositionend`, write
`input.value = game.buffer()` and reset the offset. Outside composition keep today's
contract. Handle deletion below the offset. Attributes: autocomplete, autocorrect,
autocapitalize off; spellcheck false; enterkeyhint. Desktop dead-key accents must still
work. Verify with CDP `Input.imeSetComposition` + `Input.insertText`, not just keyboard.type.

Focus: a keyboard opens only from a tap. Tapping a lyric or slot focuses the input.
Tapping a control must not open the keyboard or close it if open (`pointerdown`
preventDefault). On touch, the first screen invites: "Toca la letra para escribir".
Scrolling the lyrics by finger must not move the cursor; typing returns to the cursor.

### T7 spec

Scope: `(max-width: 720px)` for layout, `(pointer: coarse)` for touch behavior. Desktop
must look exactly as it does now, except for the tint below.

Without keyboard, top to bottom:
- Header: chevron down (back to picker) left, song title and artists centered on 2
  lines, more icon right opening a bottom sheet with pista, revelar línea, escuchar esta
  línea, ver toda la letra and "n de m". Progress hairline under the header.
- Lyrics, left aligned, 16-20px gutter, about 27-30px, weight 800, the current line white.
- Seek line with times, then shuffle, prev, big round white play (64px), next, repeat.
No cover, no volume (phone hardware), no shortcuts help on touch.

With keyboard open, detected by `visualViewport.height` under 75% of the tallest height
seen, set as a data attribute: header shrinks to a thin row; one bar directly above the
keyboard holds pista, revelar línea, escuchar, then play and next; no seek. The cursor
line stays visible in the remaining space, about 30% from the top. Streak stays small.

All sizes: other lines become a pale tint of the song
(`color-mix(in srgb, #fff 62%, var(--song))`), like Spotify's, instead of plain
translucent white; check contrast stays above 4.5:1 on every fallback flood.
Update `<meta name="theme-color">` to the flood while playing and restore on leave.
`100dvh`, safe-area insets, 44px minimum targets, no horizontal scroll at 360px. Picker:
check at 360 and 390; the search field and tiles must feel native. Finish panel becomes
a bottom sheet and must never hide under the keyboard. Viewport meta gets
`interactive-widget=resizes-content` if index.html lacks it.

### T8 spec

Additive in `src/player.js`. Desktop behavior must not change: the fallback runs only on
`(pointer: coarse)`, and only after the user pressed play.

1. Play tries the SDK as today, `activateElement` synchronous in the gesture.
2. Fallback when the SDK has no device, the PUT fails with other than premium, or no
   playing SDK state arrives within about 4 s of a successful PUT.
3. Fallback: `GET /me/player/devices`; pure, tested `pickPhoneDevice(devices)` prefers an
   active Smartphone, then any Smartphone, then any active device, skips restricted ones,
   never the SDK's own. `PUT /me/player/play?device_id=` with uri and position.
4. Remote mode: pause `PUT /me/player/pause?device_id=`, resume `PUT /me/player/play?device_id=`
   with no body, seek `PUT /me/player/seek?position_ms=&device_id=`; poll `GET /me/player`
   every 2 s only while audibly owning, and map it onto the same `onPlayback` payload.
   Another device or another uri means `lost`. Stop polling on pause and on unmount.
5. No device found: toast "Abre la app de Spotify en este celular y vuelve a tocar play."
   Success: once per session, toast "Sonando en tu app de Spotify".
6. Remote calls need no sync gesture. Don't retry in loops; a 404 from a device that went
   away maps to the toast in 5.
The session rule holds: zero player requests before the first play press, on phones too.

## Progress

T1 to T4 are done, T5 is done on the fake player. Commits: 09c2407 (T1), e99b9ca (T2),
f56c015 (T3), ecc3415 (T4), 182f07d (harness), d63ac94 (cleanup), fb64b0b (relinked
tracks), and the commit holding this document.

Accepted change after review: fillers wait for the cursor like backing vocals, so
lines not reached show only underlines. The spec's "filler always visible" no longer applies.

## Verification evidence

- `npm test`: 16 suites, 0 failures.
- Parser over 62 real songs: every word typeable, 0 Cyrillic or U+FFFC left.
- Browser, fake player: 0 /me/player requests on picking, typing, seeking and skipping
  while paused; 1 PUT on first play; 0 PUT on pause and resume of the same song.
- Parent walkthrough with real LRCLIB lyrics: 45 words typed in expanded forms, no
  console errors, screenshots read.

Pending, needs the user's account: real Spotify SDK, real audio, confirmation that
background playback is not interrupted, real phone keyboard.

Phone round, on stubs and emulated touch: CDP IME typing without duplicated letters,
0 player requests before play in every mode, all fallback branches, no horizontal
scroll at 360. Parent read the phone screenshots and reran `npm test`. Deviations are
in commits 21e5bfe to effffce. Pending on a real phone: Gboard, real keyboard height,
SDK sound, Spotify app fallback, whether Enter keeps the keyboard up.

Accepted change from play testing: a form that can still grow never auto-reveals
(`q` for `que`, `to` for `todo`, `pa` for `pa'`); it needs a space or the longer form.
This replaces the tail swallow described in T1 for those cases. Replay of 53 real songs,
16474 words typed bare: 0 early reveals, 0 misses, 0 leaks. The leak the user saw on their
keyboard was never reproduced in simulation; the new rule removes the path it needs.

## Next step

The user plays and reports where they get stuck. Push and deploy are their decision.
