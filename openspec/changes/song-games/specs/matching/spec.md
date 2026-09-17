# Delta for matching

## ADDED Requirements

### Requirement: Normalization

The system MUST normalize text deterministically: lowercase → NFD + strip combining marks → strip punctuation via `[^\p{L}\p{N}\s]` → collapse whitespace. Normalization MUST be a pure function returning identical output for identical input.

#### Scenario: Accent and case insensitivity

- GIVEN the stored title "Déjame Ir"
- WHEN the user guesses "dejame ir"
- THEN the normalized forms are equal and the guess matches

#### Scenario: Punctuation stripped

- GIVEN the title "Livin' on a Prayer!"
- WHEN normalized
- THEN only letters and spaces remain

### Requirement: Alias Strip

The system MUST strip alias markers before comparison: parentheticals such as `(feat. …)` / `(featuring …)` and edition suffixes such as `(remaster)`, `(deluxe)`, `(explicit)`, `(deluxe edition)`, plus trailing `- remaster` / `- expanded`. A guess MUST be accepted if it matches either the raw-normalized or the alias-normalized target.

#### Scenario: Featuring alias stripped

- GIVEN the stored title "Tusa (feat. Karol G)"
- WHEN the user guesses "Tusa"
- THEN the guess matches the alias-normalized target

### Requirement: Typo Tolerance

The system MUST accept a match when the Levenshtein distance between guess and normalized target is at most `max(1, floor(len/10))`, capped at 2.

#### Scenario: Typo within threshold accepted

- GIVEN the title "Bichota" (len 7, threshold 1) and the guess "Bichote"
- WHEN distance is computed
- THEN the guess is accepted

#### Scenario: Cap of 2 for long titles

- GIVEN a title of length 40 (uncapped threshold 4)
- WHEN the guess differs by 3 edits
- THEN the guess is rejected because the threshold is capped at 2

### Requirement: Title and Artist Slot Matching

The system MUST match titles against raw-normalized or alias-normalized targets. For credited artists it MUST compare each artist independently and order-independently, one input per slot; a correct guess fills one slot and a wrong guess MUST NOT consume a slot permanently. A song is solved only when ALL credited artists match.

#### Scenario: All credited artists required

- GIVEN a track credited to "Dua Lipa" and "Angèle"
- WHEN the user solves "Dua Lipa" but not "Angèle"
- THEN the song is not solved and the second slot remains open

#### Scenario: Artist order independence

- GIVEN "Angèle" typed into the first slot
- WHEN compared against the credited artists
- THEN the slot fills even though Angèle is credited second

### Requirement: Album Matching

The system MUST match album names with the same normalization, alias strip, and typo tolerance as titles.

#### Scenario: Edition suffix ignored

- GIVEN the stored album "Future Nostalgia (Deluxe Edition)"
- WHEN the user guesses "Future Nostalgia"
- THEN the guess matches the alias-normalized album name

### Requirement: Deterministic Pure Functions

All matching functions MUST be pure and deterministic — no DOM access, no state — so they are unit-testable without a framework.

#### Scenario: Repeat calls return identical verdicts

- GIVEN the same guess and target pair
- WHEN the matcher runs twice
- THEN both calls return the same result