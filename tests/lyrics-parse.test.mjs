// No-framework unit harness for src/lyrics-parse.js.
// Run with: node tests/lyrics-parse.test.mjs  (exit code 0 = all pass, non-zero = failure)
// Every lyric line below is invented; only single contraction tokens are real-world.

import {
  parseLyrics, parseLrc, looseKey, buildForms, acceptsWord, fuzzyAccepts,
  holdsWord, addForms, cleanText,
} from "../src/lyrics-parse.js";

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const checkTrue = (name, value) => check(name, Boolean(value), true);
const checkFalse = (name, value) => check(name, Boolean(value), false);

const parse = (text) => parseLyrics({ text });
const kinds = (text, line = 0) => parse(text).lines[line].tokens.map((t) => t.kind);
const word = (text) => parse(text).words[0];
const accepts = (raw, typed) => acceptsWord(word(raw), typed);

// --- cleaning --------------------------------------------------------------

{
  const cyr = "еs lindo еscondida";
  const { words } = parse(cyr);
  check("cyrillic: words keep their count", words.length, 3);
  check("cyrillic: mapped to latin", words[0].text, "es");
  check("cyrillic: inside a longer word", words[2].text, "escondida");
  checkFalse("cyrillic: nothing left in any text", /[Ѐ-ӿ]/.test(parse(cyr).lines[0].text));
  checkTrue("cyrillic: the word is typeable", acceptsWord(words[0], "es"));
}
{
  const junk = "hola￼ mundo​ azul";
  const { words } = parse(junk);
  check("U+FFFC and zero-width dropped", words.map((w) => w.text).join(" "), "hola mundo azul");
  check("cleanText keeps normal text", cleanText("a’b"), "a'b");
}
{
  check("curly apostrophe unified", word("vamo’ ya").text, "vamo'");
  check("backtick apostrophe unified", word("vamo` ya").text, "vamo'");
}

// --- meta lines --------------------------------------------------------------

{
  const { lines } = parse("[Coro]\nEstribillo:\nx2\n(x2)\nlinea real aqui\n\n  \n[Verso 1]");
  check("meta lines dropped, one real line left", lines.length, 1);
  check("the real line survives", lines[0].text, "linea real aqui");
}
{
  const { lines } = parse("Time: 10:00 sharp\nCoro:");
  check("a colon inside a lyric is not meta", lines.length, 1);
}

// --- tokens: kinds, pre/post ----------------------------------------------------

{
  const t = parse("¿Quién sabe, mi amor?").lines[0].tokens;
  check("punctuation: pre kept", t[0].pre, "¿");
  check("punctuation: core only in text", t[0].text, "Quién");
  check("punctuation: post kept", t[1].post, ",");
  check("punctuation: last post", t[3].post, "?");
}
{
  const { words, lines } = parse("uno dos\ntres");
  check("wordIndex is global reading order", words.map((w) => w.wordIndex).join(","), "0,1,2");
  check("words carry their line", words.map((w) => w.line).join(","), "0,0,1");
  check("words are the very tokens of the lines", words[1], lines[0].tokens[1]);
}
{
  const { lines } = parse("hola . mundo");
  check("lone punctuation sticks to the previous token", lines[0].tokens.length, 2);
  checkTrue("lone punctuation lands in post", lines[0].tokens[0].post.includes("."));
}
{
  const { lines } = parse("♪\n...\nsi hay letra");
  check("lines without letters vanish", lines.length, 1);
}

// --- spaced letters -------------------------------------------------------------

{
  const { words } = parse("soy Z o r r i t o hoy");
  check("spaced letters merge into one word", words.length, 3);
  check("spaced letters keep the text as written", words[1].text, "Z o r r i t o");
  checkTrue("spaced letters: joined form", words[1].forms.has("zorrito"));
  checkTrue("spaced letters: typed joined", acceptsWord(words[1], "zorrito"));
  checkTrue("spaced letters: typed with spaces holds", holdsWord(words[1], "z o r"));
}
{
  const { words } = parse("yo a ti");
  check("two single letters are not merged", words.length, 3);
}

// --- fillers -------------------------------------------------------------------

{
  for (const f of ["eh-eh", "yeah-yeah-yeah", "ey-yeah", "woh-oh", "hmm-mm", "oh-oh", "eeeeh",
    "ayyy", "na-na", "da-ra", "paw-paw", "no-no", "yeah-eah", "wow", "mmm", "jaja", "prr", "uoh"]) {
    check(`filler: ${f}`, kinds(f)[0], "filler");
  }
  for (const w of ["la", "a", "na", "e", "o", "glow-up", "blin-blin", "due-e-e-elen", "A-a-ando",
    "Ba-baby", "Dando-dandote", "Bando-bandolera", "Two-stepping", "tarde'-e'-e'", "Lint-oh-oh-on",
    "lu-", "-piento", "cora-"]) {
    check(`not a filler: ${w}`, kinds(w)[0], "word");
  }
  const { words, lines } = parse("hola eh-eh mundo");
  check("filler stays in the line but not in the words", lines[0].tokens.map((t) => t.kind).join(","), "word,filler,word");
  check("filler is not a word", words.length, 2);
  check("filler has no forms", lines[0].tokens[1].forms, undefined);
}

// --- backing -------------------------------------------------------------------

{
  check("trailing parens are backing", kinds("hola mundo (eh-eh, eh-eh)").join(","), "word,word,backing,backing");
  const t = parse("hola mundo (eh-eh, eh-eh)").lines[0].tokens;
  check("backing keeps its parens in pre", t[2].pre, "(");
  check("backing keeps its parens in post", t[3].post, ")");
}
{
  check("parens span several tokens", kinds("Dale (Dale, guayame), dale").join(","), "word,backing,backing,word");
  const { words } = parse("Dale (Dale, guayame), dale");
  check("only the sung words are words", words.length, 2);
}
{
  check("unbalanced paren runs to the end of the line", kinds("dime (que si no").join(","), "word,backing,backing,backing");
  check("stray closing paren is harmless", kinds("hola) mundo").join(","), "word,word");
  const line = parse("(Se escucha de fondo)").lines[0];
  check("whole line backing", line.tokens.every((t) => t.kind === "backing"), true);
  check("whole line backing: empty signature", line.signature, "");
}
{
  check("(Now) is backing", kinds("(Now) vamos").join(","), "backing,word");
  check("backing filler is backing, not filler", kinds("x (eh-eh)").join(","), "word,backing");
}

// --- signature -----------------------------------------------------------------

{
  const { lines } = parse("Vamos a bailar\nvamo' a bailar\nHola (eh)\n(eh-eh)");
  check("same words, same signature (urban spelling)", lines[0].signature, lines[1].signature);
  checkTrue("signature is not empty for sung lines", lines[2].signature.length > 0);
  check("fillers and backing are out of the signature", lines[2].signature, parse("hola").lines[0].signature);
  check("no words, empty signature", lines[3].signature, "");
}

// --- synced ----------------------------------------------------------------------

{
  const synced = [
    { ms: 1000, text: "primera linea" },
    { ms: 4000, text: "" },
    { ms: 6500, text: "segunda linea" },
  ];
  const { lines } = parseLyrics({ synced, text: "ignored text" });
  check("synced wins over text", lines.length, 2);
  check("synced: ms", lines[0].ms, 1000);
  check("synced: endMs is the next entry, even a blank one", lines[0].endMs, 4000);
  check("synced: last line has no endMs", lines[1].endMs, null);
  check("plain text has null times", parse("a b c").lines[0].ms, null);
  check("empty synced falls back to text", parseLyrics({ synced: [], text: "uno dos" }).words.length, 2);
  const lrc = parseLrc("[00:12.50] hola\n[01:02.00][01:30.25]coro\nsin tiempo");
  check("parseLrc: entries", lrc.length, 3);
  check("parseLrc: ms", lrc[0].ms, 12500);
  check("parseLrc: multi-stamp sorted", lrc[2].ms, 90250);
  check("parseLrc: text trimmed", lrc[0].text, "hola");
}

// --- looseKey ----------------------------------------------------------------------

{
  check("looseKey: v/b", looseKey("vamos"), looseKey("bamos"));
  check("looseKey: c/s/z", looseKey("hacer"), looseKey("aser"));
  check("looseKey: haces/ases", looseKey("haces"), looseKey("ases"));
  check("looseKey: accents", looseKey("está"), looseKey("esta"));
  check("looseKey: qu/k", looseKey("quiero"), looseKey("kiero"));
  check("looseKey: ll/y", looseKey("calle"), looseKey("caye"));
  check("looseKey: g before e", looseKey("gente"), looseKey("jente"));
  check("looseKey: ch is protected", looseKey("chico") !== looseKey("cico"), true);
  check("looseKey: final ado", looseKey("lado"), looseKey("lao"));
  check("looseKey: final ido", looseKey("perdido"), looseKey("perdio"));
  check("looseKey: final s dropped", looseKey("cosas"), looseKey("cosa"));
  check("looseKey: final d dropped", looseKey("verdad"), looseKey("verda"));
  check("looseKey: final l is r", looseKey("papel"), looseKey("paper"));
  check("looseKey: repeated letters collapse", looseKey("eeeso"), looseKey("eso"));
  check("looseKey: never empty", looseKey("h"), "h");
  check("looseKey: digits survive", looseKey("2025"), "2025");
}

// --- forms: apostrophes ---------------------------------------------------------------

{
  checkTrue("trailing ': the bare word", accepts("vamo'", "vamo"));
  checkTrue("trailing ': plus s", accepts("vamo'", "vamos"));
  checkTrue("trailing ': plus s (cosas)", accepts("cosa'", "cosas"));
  checkTrue("trailing ': plus d (verdad)", accepts("verda'", "verdad"));
  checkTrue("trailing ': plus r (hacer)", accepts("hace'", "hacer"));
  checkTrue("trailing ': plus g (commin')", accepts("commin'", "comming"));
  checkTrue("trailing ': z through the phonetic key", accepts("die'", "diez"));
  checkTrue("trailing ': ve' is vez", accepts("ve'", "vez"));
  checkTrue("trailing ': to' is todo", accepts("to'", "todo"));
  checkTrue("trailing ': to' is todas", accepts("to'", "todas"));
  checkTrue("trailing ': ma' is mas", accepts("má'", "mas"));
  checkTrue("trailing ': na' is nada", accepts("na'", "nada"));
  checkTrue("trailing ': cora' is corazon", accepts("cora'", "corazon"));
  checkTrue("trailing ': toa' is toda", accepts("toa'", "toda"));
  checkTrue("trailing ': pue' is puede", accepts("pue'", "puede"));
  checkTrue("trailing ': cu' is culo", accepts("cu'", "culo"));
  checkTrue("leading ': 'toy is estoy", accepts("'toy", "estoy"));
  checkTrue("leading ': 'tamos is estamos", accepts("'tamos", "estamos"));
  checkTrue("leading ': 'e is de", accepts("'e", "de"));
  checkTrue("leading ': 'cause is because", accepts("'cause", "because"));
  checkTrue("leading ': 'cause is cuz", accepts("'cause", "cuz"));
  checkTrue("leading ': 'cause is cause", accepts("'cause", "cause"));
  checkTrue("leading ': es + word", accepts("'tas", "estas"));
}

// --- forms: dictionary both ways -----------------------------------------------------------

{
  checkTrue("dict: pa' accepts para", accepts("pa'", "para"));
  checkTrue("dict: pa' accepts pa", accepts("pa'", "pa"));
  checkTrue("dict: pa accepts para", accepts("pa", "para"));
  checkTrue("dict: para accepts pa", accepts("para", "pa"));
  checkTrue("dict: para accepts para", accepts("para", "para"));
  checkTrue("dict: todo accepts to", accepts("todo", "to"));
  checkTrue("dict: nada accepts na", accepts("nada", "na"));
  checkTrue("dict: baby accepts beibi", accepts("baby", "beibi"));
  checkTrue("dict: baby accepts bebe", accepts("baby", "bebe"));
  checkTrue("dict: que accepts q", accepts("que", "q"));
  checkTrue("dict: tambien accepts tb", accepts("también", "tb"));
  checkTrue("dict: usted accepts uste", accepts("usted", "uste"));
  checkTrue("dict: estoy accepts toy", accepts("estoy", "toy"));
  checkTrue("dict: compadre accepts compa", accepts("compadre", "compa"));
  checkTrue("dict: alante is adelante", accepts("alante", "adelante"));
  checkTrue("dict: xq is porque", accepts("xq", "porque"));
  checkTrue("dict: verda is verdad", accepts("verda", "verdad"));
  checkTrue("dict: ta is esta", accepts("ta", "esta"));
  checkFalse("dict: unrelated word is rejected", accepts("para", "perro"));
}

// --- forms: mid apostrophe ----------------------------------------------------------------

{
  const w = word("salgo'el");
  checkTrue("mid: salgo del", acceptsWord(w, "salgo del"));
  checkTrue("mid: salgo el", acceptsWord(w, "salgo el"));
  checkTrue("mid: salgoel", acceptsWord(w, "salgoel"));
  checkTrue("mid: salgodel", acceptsWord(w, "salgodel"));
  checkTrue("mid: 'salgo' alone holds", holdsWord(w, "salgo"));
  checkFalse("mid: 'salgo' alone is not accepted", acceptsWord(w, "salgo"));
  checkFalse("mid: junk does not hold", holdsWord(w, "salto"));
}
{
  checkTrue("mid: la'o is lado", accepts("la'o", "lado"));
  checkTrue("mid: la'o is lao", accepts("la'o", "lao"));
  checkTrue("mid: calla'o is callado", accepts("calla'o", "callado"));
  checkTrue("mid: pasa'o is pasado", accepts("pasa'o", "pasado"));
  checkTrue("mid: peca'o is pecado", accepts("peca'o", "pecado"));
  checkTrue("mid: mi'mo is mismo", accepts("mi'mo", "mismo"));
  checkTrue("mid: callaí'ta is calladita", accepts("callaí'ta", "calladita"));
  checkTrue("mid: cuerpo'e is cuerpo de", accepts("cuerpo'e", "cuerpo de"));
  checkTrue("mid: vo'a is voy a", accepts("vo'a", "voy a"));
  checkTrue("mid: vo'a holds voy", holdsWord(word("vo'a"), "voy"));
  checkTrue("mid: pa'l is para el", accepts("pa'l", "para el"));
  checkTrue("mid: pa'l holds para", holdsWord(word("pa'l"), "para"));
  checkTrue("mid: to'l is todo el", accepts("to'l", "todo el"));
  checkTrue("mid: pa'llá is para alla", accepts("pa'llá", "para alla"));
  checkTrue("mid: pa'trá is para atras", accepts("pa'trá", "para atras"));
  checkTrue("mid: a'lante is adelante", accepts("a'lante", "adelante"));
  checkTrue("mid: to's is todos", accepts("to's", "todos"));
}

// --- forms: english --------------------------------------------------------------------------

{
  checkTrue("en: i'm is i am", accepts("i'm", "i am"));
  checkTrue("en: we're is we are", accepts("we're", "we are"));
  checkTrue("en: we'll is we will", accepts("we'll", "we will"));
  checkTrue("en: you're is you are", accepts("you're", "you are"));
  checkTrue("en: wasn't is was not", accepts("wasn't", "was not"));
  checkTrue("en: wasn't is wasnt", accepts("wasn't", "wasnt"));
  checkTrue("en: don't is do not", accepts("don't", "do not"));
  checkTrue("en: it's is it is", accepts("it's", "it is"));
  checkTrue("en: holds the first half", holdsWord(word("we're"), "we"));
}

// --- forms: hyphens --------------------------------------------------------------------------

{
  checkTrue("hyphen: stutter collapses", accepts("due-e-e-elen", "duelen"));
  checkTrue("hyphen: stutter joined", accepts("due-e-e-elen", "dueeeelen"));
  checkTrue("hyphen: a-a-ando", accepts("a-a-ando", "ando"));
  checkTrue("hyphen: Ba-baby last segment", accepts("Ba-baby", "baby"));
  checkTrue("hyphen: Ba-baby joined", accepts("Ba-baby", "bababy"));
  checkTrue("hyphen: Ba-baby baby is beibi", accepts("Ba-baby", "beibi"));
  checkTrue("hyphen: compound joined", accepts("glow-up", "glowup"));
  checkTrue("hyphen: compound with a space", accepts("glow-up", "glow up"));
  checkTrue("hyphen: compound holds the first part", holdsWord(word("glow-up"), "glow"));
  checkTrue("hyphen: tarde'-e'-e' collapses", accepts("tarde'-e'-e'", "tarde"));
  checkFalse("hyphen: a stuttered tail alone is not enough", accepts("tarde'-e'-e'", "e"));
  checkTrue("hyphen: Dando-dándote joined", accepts("Dando-dándote", "dandodandote"));
  checkTrue("hyphen: cut-off keeps the stem", accepts("lu-", "lu"));
  checkTrue("hyphen: leading cut-off", accepts("-piento", "piento"));
  checkTrue("hyphen: cora- is corazon", accepts("cora-", "corazon"));
}

// --- forms: digits, dots -----------------------------------------------------------------------

{
  checkTrue("digits: 2 is dos", accepts("2", "dos"));
  checkTrue("digits: 2 is 2", accepts("2", "2"));
  checkTrue("digits: 1 is uno", accepts("1", "uno"));
  checkTrue("digits: 1 is un", accepts("1", "un"));
  checkTrue("digits: 1 is una", accepts("1", "una"));
  checkTrue("digits: 0 is cero", accepts("0", "cero"));
  checkTrue("digits: 20 is veinte", accepts("20", "veinte"));
  checkTrue("digits: 100 is cien", accepts("100", "cien"));
  checkTrue("time: 10:00 is diez", accepts("10:00", "diez"));
  checkTrue("time: 10:00 is 10", accepts("10:00", "10"));
  checkTrue("time: 10:00 is 1000", accepts("10:00", "1000"));
  checkTrue("time: 3:00 is tres", accepts("3:00", "tres"));
  checkTrue("digits: 2025 stays 2025", accepts("2025", "2025"));
  checkFalse("digits: 2025 is not a small word", accepts("2025", "dos"));
  checkTrue("dots: L.A is la", accepts("L.A", "la"));
}

// --- forms: phonetics ----------------------------------------------------------------------------

{
  checkTrue("phonetic: vamos/bamos", accepts("vamos", "bamos"));
  checkTrue("phonetic: haces/ases", accepts("haces", "ases"));
  checkTrue("phonetic: accents ignored", accepts("canción", "cancion"));
  checkTrue("phonetic: ñ as n", accepts("año", "ano"));
  checkTrue("phonetic: baby/beibi", accepts("baby", "beibi"));
  checkTrue("phonetic: case ignored", accepts("Hola", "HOLA"));
  checkFalse("phonetic: a different word", accepts("vamos", "vemos"));
  checkFalse("phonetic: empty typed", accepts("vamos", ""));
}

// --- fuzzy ---------------------------------------------------------------------------------------

{
  const short = word("casa");
  checkFalse("fuzzy: under 5 letters needs an exact key", fuzzyAccepts(short, "caso"));
  const mid = word("camino");
  checkTrue("fuzzy: 6 letters tolerate one slip", fuzzyAccepts(mid, "camono"));
  checkTrue("fuzzy: one missing letter", fuzzyAccepts(mid, "camno"));
  checkFalse("fuzzy: two slips are too many at 6", fuzzyAccepts(mid, "comona"));
  const long = word("responsabilidad");
  checkTrue("fuzzy: 9+ letters tolerate two slips", fuzzyAccepts(long, "responsabilidd"));
  checkTrue("fuzzy: two slips on a long word", fuzzyAccepts(long, "rospnsabilidad"));
  checkFalse("fuzzy: three slips are too many", fuzzyAccepts(long, "rospnsabolidod"));
  checkFalse("fuzzy: empty typed", fuzzyAccepts(mid, ""));
}

// --- addForms -----------------------------------------------------------------------------------------

{
  const w = word("pasa'o");
  checkFalse("addForms: before, an odd form is rejected", acceptsWord(w, "pasadito"));
  addForms(w, ["pasadito", "pasao ya"]);
  checkTrue("addForms: new form accepted", acceptsWord(w, "pasadito"));
  checkTrue("addForms: spaced form collapses", acceptsWord(w, "pasao ya"));
  checkTrue("addForms: spaced form holds its first word", holdsWord(w, "pasao"));
  check("addForms: ignores empty entries", addForms(w, ["", "  "]), w);
}

// --- buildForms ------------------------------------------------------------------------------------------

{
  const forms = buildForms("vamo'");
  checkTrue("buildForms: plain Set of strings", forms instanceof Set && [...forms].every((f) => /^[a-z0-9]+$/.test(f)));
  checkTrue("buildForms: always the bare word", forms.has("vamo"));
  checkTrue("buildForms: no spaces anywhere", [...buildForms("salgo'el")].every((f) => !f.includes(" ")));
}

// --- summary -----------------------------------------------------------------------------------------------

console.log(`lyrics-parse.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
