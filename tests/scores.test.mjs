// No-framework unit harness for src/scores.js (per-game records).
// Run with: node tests/scores.test.mjs  (exit code 0 = all pass, non-zero = failure)
//
// scores.js reads `localStorage` at call time, so the global is stubbed before
// the module is imported (same convention as tests/storage.test.mjs).

const store = new Map();
let failWhen = null; // (key, value) => boolean — simulates a throwing setItem

globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (failWhen?.(k, String(v))) throw new DOMException("quota", "QuotaExceededError");
    store.set(k, String(v));
  },
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
};

const { getRecord, saveRun, pointsForStep } = await import("../src/scores.js");

const KEY = "deoido.v1.records";
let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = Object.is(actual, expected) ||
    (expected && actual && typeof expected === "object" && JSON.stringify(actual) === JSON.stringify(expected));
  if (ok) passed++;
  else failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function checkTrue(name, value) {
  check(name, Boolean(value), true);
}

// --- pointsForStep: pure formula ---------------------------------------------

check("first of 6 steps scores 6", pointsForStep(0, 6), 6);
check("last of 6 steps scores 1", pointsForStep(5, 6), 1);
check("middle step", pointsForStep(2, 6), 4);

// --- getRecord: defaults for an unknown game ---------------------------------

{
  store.clear();
  check("unknown game: defaults", getRecord("clip"), { bestStreak: 0, bestPoints: 0, played: 0 });
}

// --- saveRun: first run always sets both bests --------------------------------

{
  store.clear();
  const result = saveRun("clip", { streak: 3, points: 10 });
  checkTrue("first run: isNewBestStreak", result.isNewBestStreak);
  checkTrue("first run: isNewBestPoints", result.isNewBestPoints);
  check("first run: record", result.record, { bestStreak: 3, bestPoints: 10, played: 1 });
  check("first run: persisted", getRecord("clip"), { bestStreak: 3, bestPoints: 10, played: 1 });
}

// --- saveRun: a worse run keeps the bests, still counts as played ------------

{
  store.clear();
  saveRun("clip", { streak: 3, points: 10 });
  const result = saveRun("clip", { streak: 1, points: 2 });
  checkTrue("worse run: not a new best streak", !result.isNewBestStreak);
  checkTrue("worse run: not a new best points", !result.isNewBestPoints);
  check("worse run: bests unchanged, played increments", result.record, { bestStreak: 3, bestPoints: 10, played: 2 });
}

// --- saveRun: streak and points bests track independently --------------------

{
  store.clear();
  saveRun("clip", { streak: 5, points: 4 });
  const result = saveRun("clip", { streak: 2, points: 9 });
  checkTrue("mixed run: streak not a new best", !result.isNewBestStreak);
  checkTrue("mixed run: points IS a new best", result.isNewBestPoints);
  check("mixed run: record", result.record, { bestStreak: 5, bestPoints: 9, played: 2 });
}

// --- games are independent records --------------------------------------------

{
  store.clear();
  saveRun("clip", { streak: 4, points: 4 });
  saveRun("year", { streak: 1, points: 1 });
  check("clip record isolated from year", getRecord("clip"), { bestStreak: 4, bestPoints: 4, played: 1 });
  check("year record isolated from clip", getRecord("year"), { bestStreak: 1, bestPoints: 1, played: 1 });
}

// --- never throws: corrupt JSON -----------------------------------------------

{
  store.clear();
  store.set(KEY, "{not json");
  check("corrupt JSON: getRecord falls back", getRecord("clip"), { bestStreak: 0, bestPoints: 0, played: 0 });
  let threw = false;
  let result;
  try {
    result = saveRun("clip", { streak: 2, points: 2 });
  } catch {
    threw = true;
  }
  checkTrue("corrupt JSON: saveRun does not throw", !threw);
  check("corrupt JSON: saveRun still returns a usable record", result?.record, { bestStreak: 2, bestPoints: 2, played: 1 });
}

// --- never throws: non-object JSON --------------------------------------------

{
  store.clear();
  store.set(KEY, JSON.stringify([1, 2, 3]));
  check("array JSON: getRecord falls back", getRecord("clip"), { bestStreak: 0, bestPoints: 0, played: 0 });
}

// --- never throws: a throwing setItem -----------------------------------------

{
  store.clear();
  failWhen = () => true;
  let threw = false;
  let result;
  try {
    result = saveRun("clip", { streak: 7, points: 20 });
  } catch {
    threw = true;
  }
  failWhen = null;
  checkTrue("throwing setItem: saveRun does not throw", !threw);
  check("throwing setItem: computed record still returned", result?.record, { bestStreak: 7, bestPoints: 20, played: 1 });
  checkTrue("throwing setItem: nothing persisted", !store.has(KEY));
}

// --- never throws: localStorage itself missing --------------------------------

{
  store.clear();
  const real = globalThis.localStorage;
  globalThis.localStorage = undefined;
  let threw = false;
  let record;
  try {
    record = getRecord("clip");
  } catch {
    threw = true;
  }
  checkTrue("missing localStorage: getRecord does not throw", !threw);
  check("missing localStorage: getRecord falls back", record, { bestStreak: 0, bestPoints: 0, played: 0 });
  let saveThrew = false;
  try {
    saveRun("clip", { streak: 1, points: 1 });
  } catch {
    saveThrew = true;
  }
  checkTrue("missing localStorage: saveRun does not throw", !saveThrew);
  globalThis.localStorage = real;
}

// --- saveRun: missing streak/points default to 0 ------------------------------

{
  store.clear();
  const result = saveRun("clip", {});
  check("no args: treated as a 0/0 run", result.record, { bestStreak: 0, bestPoints: 0, played: 1 });
}

// --- summary -----------------------------------------------------------------

console.log(`scores.test.mjs: ${passed} assertions passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error("FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
