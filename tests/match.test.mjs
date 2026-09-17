// No-framework unit harness for src/match.js.
// Run with: node tests/match.test.mjs  (exit code 0 = all pass, non-zero = failure)

import { normalize, stripAliases, levenshtein, isMatch, matchTitle, matchArtistSlots, assignArtistSlots, matchAlbum, yearHint } from "../src/match.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) {
    passed++;
  } else {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// --- normalize: accent and case insensitivity -------------------------------
check("normalize removes accents and case", normalize("Déjame Ir"), "dejame ir");
check("normalize collapses whitespace", normalize("  Déjame   Ir  "), "dejame ir");

// --- normalize: punctuation stripped ----------------------------------------
check("normalize strips punctuation", normalize("Livin' on a Prayer!"), "livin on a prayer");
check("normalize keeps numbers", normalize("M.I.A."), "mia");

// --- stripAliases -----------------------------------------------------------
check("stripAliases feat", stripAliases("Tusa (feat. Karol G)"), "Tusa");
check("stripAliases featuring", stripAliases("Tusa (featuring Karol G)"), "Tusa");
check("stripAliases remaster", stripAliases("Hotel California - 2013 Remaster"), "Hotel California");
check("stripAliases expanded", stripAliases("Born This Way - Expanded"), "Born This Way");
check("stripAliases deluxe edition", stripAliases("Future Nostalgia (Deluxe Edition)"), "Future Nostalgia");
check("stripAliases explicit", stripAliases("Bang Bang (Explicit)"), "Bang Bang");
check("stripAliases leaves plain titles", stripAliases("Tusa"), "Tusa");

// --- typo tolerance (design D10 / matching spec) -----------------------------
check("typo within threshold accepted (Bichote vs Bichota)", matchTitle("Bichote", "Bichota"), true);
// len 7 → threshold max(1, floor(7/10)) = 1; "Bixhotb" differs in 2 positions.
check("distance 2 on len 7 rejected", matchTitle("Bixhotb", "Bichota"), false);
check("distance 1 on len 7 accepted", matchTitle("Bichote", "Bichota"), true);
// len 3 → threshold max(1, floor(3/10)) = 1; "uxy" differs in 2 positions.
check("distance 2 on len 3 rejected (cap floor 1)", matchTitle("uxy", "usa"), false);
check("distance 1 on len 3 accepted (cap floor 1)", matchTitle("uxa", "usa"), true);

// cap of 2 for long titles: len 40 → floor(40/10)=4 → capped at 2.
// Target "a"×40, guess differs in 3 positions → distance 3 > 2 → rejected.
const longTarget = "a".repeat(40);
const longGuess = "a".repeat(37) + "xyz";
check("cap 2 for len 40: 3 edits rejected", matchTitle(longGuess, longTarget), false);
const longGuess1 = "a".repeat(39) + "b";
check("cap 2 for len 40: 1 edit accepted", matchTitle(longGuess1, longTarget), true);

// --- matchTitle: alias acceptance -------------------------------------------
check("feat. alias accepted (Tusa)", matchTitle("Tusa", "Tusa (feat. Karol G)"), true);
check("raw-normalized match", matchTitle("dejame ir", "Déjame Ir"), true);
check("punctuated guess matches raw target", matchTitle("livin on a prayer", "Livin' on a Prayer!"), true);
check("edition suffix ignored", matchTitle("Future Nostalgia", "Future Nostalgia (Deluxe Edition)"), true);
check("trailing remaster ignored", matchTitle("Hotel California", "Hotel California - 2013 Remaster"), true);
check("wrong title rejected", matchTitle("Despacito", "Tusa (feat. Karol G)"), false);

// --- matchArtistSlots: all credited artists required -------------------------
{
  const r = matchArtistSlots(["Dua Lipa", ""], ["Dua Lipa", "Angèle"]);
  check("one artist solved, song not solved", r.solved, false);
  check("unsolved slot stays open", r.slots[1].status, "open");
}
{
  const r = matchArtistSlots(["Dua Lipa", "Angèle"], ["Dua Lipa", "Angèle"]);
  check("all artists solved", r.solved, true);
  check("slot 0 correct", r.slots[0].status, "correct");
  check("slot 1 correct", r.slots[1].status, "correct");
}

// --- matchArtistSlots: order independence ------------------------------------
{
  const r = matchArtistSlots(["Angèle", "Dua Lipa"], ["Dua Lipa", "Angèle"]);
  check("order-independent fill", r.solved, true);
  check("first slot filled by second-credited artist", r.slots[0].status, "correct");
}

// --- matchArtistSlots: wrong guess never consumes a slot ---------------------
{
  const r = matchArtistSlots(["Shakira", ""], ["Dua Lipa", "Angèle"]);
  check("wrong guess flags incorrect", r.slots[0].status, "incorrect");
  check("wrong guess stays editable (not consumed)", r.slots[0].guess, "Shakira");
  check("wrong guess does not solve", r.solved, false);
}
{
  // Correct after a previous wrong guess: the artist was not burned.
  const r = matchArtistSlots(["Dua Lipa", "Angèle"], ["Dua Lipa", "Angèle"]);
  check("artist not burned by earlier wrong guess", r.solved, true);
}
{
  // Two identical guesses can only fill one slot (no double-consumption).
  const r = matchArtistSlots(["Angèle", "Angèle"], ["Dua Lipa", "Angèle"]);
  check("duplicate guesses fill one slot only", r.solved, false);
  check("duplicate guess in second slot incorrect", r.slots[1].status, "incorrect");
}
{
  // Accent-tolerant artist match (Angèle normalized).
  const r = matchArtistSlots(["Angele"], ["Dua Lipa", "Angèle"]);
  check("accent-insensitive artist match", r.solved, false);
  check("accent-insensitive fill", r.slots[0].status, "correct");
}
{
  const r = matchArtistSlots([], []);
  check("no credited artists → nothing to solve, no crash", r.solved, true);
}

// --- matchArtistSlots: matchedIndex -----------------------------------------
{
  const r = matchArtistSlots(["Angèle", ""], ["Dua Lipa", "Angèle"]);
  check("correct slot reports matchedIndex of credited artist", r.slots[0].matchedIndex, 1);
}
{
  const r = matchArtistSlots(["Shakira", ""], ["Dua Lipa", "Angèle"]);
  check("wrong guess reports matchedIndex null", r.slots[0].matchedIndex, null);
}

// --- assignArtistSlots: relocation + spill (design requirement) --------------
{
  // Typed in field 0, lands in the field for Angèle = field 1.
  const r = assignArtistSlots(["Angèle", ""], ["Dua Lipa", "Angèle"]);
  check("assign: relocated to own slot values", JSON.stringify(r.values), JSON.stringify(["", "Angèle"]));
  check("assign: relocated to own slot locked", JSON.stringify(r.locked), JSON.stringify([false, true]));
  check("assign: relocated not solved", r.solved, false);
}
{
  // Fields swap so each artist sits in its own slot.
  const r = assignArtistSlots(["Angèle", "Dua Lipa"], ["Dua Lipa", "Angèle"]);
  check("assign: swapped values", JSON.stringify(r.values), JSON.stringify(["Dua Lipa", "Angèle"]));
  check("assign: swapped locked", JSON.stringify(r.locked), JSON.stringify([true, true]));
  check("assign: swapped solved", r.solved, true);
}
{
  // Wrong guess stays editable, never burned.
  const r = assignArtistSlots(["Shakira", ""], ["Dua Lipa", "Angèle"]);
  check("assign: wrong guess kept values", JSON.stringify(r.values), JSON.stringify(["Shakira", ""]));
  check("assign: wrong guess unlocked", JSON.stringify(r.locked), JSON.stringify([false, false]));
  check("assign: wrong guess not solved", r.solved, false);
}
{
  // Duplicate non-matching text remains visible somewhere unlocked (spill → field 0).
  const r = assignArtistSlots(["Angèle", "Angèle"], ["Dua Lipa", "Angèle"]);
  check("assign: duplicate spill values", JSON.stringify(r.values), JSON.stringify(["Angèle", "Angèle"]));
  check("assign: duplicate spill locked", JSON.stringify(r.locked), JSON.stringify([false, true]));
  check("assign: duplicate spill not solved", r.solved, false);
}
{
  const r = assignArtistSlots([], []);
  check("assign: empty credited → empty values", JSON.stringify(r.values), JSON.stringify([]));
  check("assign: empty credited → empty locked", JSON.stringify(r.locked), JSON.stringify([]));
  check("assign: empty credited → solved", r.solved, true);
}

// --- assignArtistSlots: determinism ------------------------------------------
{
  const a = assignArtistSlots(["Angèle", "Dua Lipa"], ["Dua Lipa", "Angèle"]);
  const b = assignArtistSlots(["Angèle", "Dua Lipa"], ["Dua Lipa", "Angèle"]);
  check("assignArtistSlots deterministic", JSON.stringify(a) === JSON.stringify(b), true);
}

// --- matchAlbum --------------------------------------------------------------
check("deluxe edition album accepted", matchAlbum("Future Nostalgia", "Future Nostalgia (Deluxe Edition)"), true);
check("album typo tolerated", matchAlbum("Futur Nostalgia", "Future Nostalgia"), true);
check("wrong album rejected", matchAlbum("Thriller", "Future Nostalgia"), false);

// --- yearHint (design bounds: very-close ≤2, close ≤10, else far) ------------
{
  const h = yearHint(2015, 2019);
  check("yearHint 2015→2019 direction newer", h.direction, "newer");
  check("yearHint 2015→2019 closeness close (|d|=4 ≤10)", h.closeness, "close");
}
{
  const h = yearHint(2019, 2015);
  check("yearHint 2019→2015 direction older", h.direction, "older");
}
{
  const h = yearHint(2019, 2019);
  check("yearHint equal", h.direction, "equal");
  check("yearHint equal very-close", h.closeness, "very-close");
}
{
  const h = yearHint(2019, 2020);
  check("yearHint d=1 very-close", h.closeness, "very-close");
  check("yearHint d=1 newer", h.direction, "newer");
}
{
  const h = yearHint(2000, 2019);
  check("yearHint d=19 far", h.closeness, "far");
}

// --- determinism -------------------------------------------------------------
{
  const a = matchTitle("Bichote", "Bichota");
  const b = matchTitle("Bichote", "Bichota");
  check("matchTitle deterministic", a === b, true);
  const s1 = matchArtistSlots(["Angèle", "Dua Lipa"], ["Dua Lipa", "Angèle"]);
  const s2 = matchArtistSlots(["Angèle", "Dua Lipa"], ["Dua Lipa", "Angèle"]);
  check("matchArtistSlots deterministic", JSON.stringify(s1) === JSON.stringify(s2), true);
  const y1 = yearHint(2015, 2019);
  const y2 = yearHint(2015, 2019);
  check("yearHint deterministic", JSON.stringify(y1) === JSON.stringify(y2), true);
}

// --- levenshtein sanity ------------------------------------------------------
check("levenshtein equal strings", levenshtein("abc", "abc"), 0);
check("levenshtein one insertion", levenshtein("abc", "abcd"), 1);
check("levenshtein substitution", levenshtein("Bichote", "Bichota"), 1);
check("levenshtein empty", levenshtein("", "abc"), 3);

// --- summary -----------------------------------------------------------------
console.log(`match.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}