// Per-game records in localStorage (design "Afiche" game kit, task T3).
// Key: deoido.v1.records → JSON map gameId -> { bestStreak, bestPoints, played }.
// Never throws: corrupt JSON, a missing localStorage, or a throwing setItem all
// fall back to defaults, same contract as storage.js.

const KEY = "deoido.v1.records";
const EMPTY_RECORD = { bestStreak: 0, bestPoints: 0, played: 0 };

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(records) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
    return true;
  } catch {
    return false;
  }
}

function sanitize(record) {
  const r = record && typeof record === "object" ? record : {};
  return {
    bestStreak: Number.isFinite(r.bestStreak) ? r.bestStreak : 0,
    bestPoints: Number.isFinite(r.bestPoints) ? r.bestPoints : 0,
    played: Number.isFinite(r.played) ? r.played : 0,
  };
}

/** Stored record for `gameId`, or zeroed defaults when none exists yet. */
export function getRecord(gameId) {
  return sanitize(readAll()[gameId]);
}

/**
 * Persist one finished run (streak ended, or the user left mid-run) and
 * report whether it beat the previous bests.
 * @returns {{ record: {bestStreak:number,bestPoints:number,played:number},
 *             isNewBestStreak: boolean, isNewBestPoints: boolean }}
 */
export function saveRun(gameId, { streak = 0, points = 0 } = {}) {
  const all = readAll();
  const prev = sanitize(all[gameId]);
  const isNewBestStreak = streak > prev.bestStreak;
  const isNewBestPoints = points > prev.bestPoints;
  const record = {
    bestStreak: Math.max(prev.bestStreak, streak),
    bestPoints: Math.max(prev.bestPoints, points),
    played: prev.played + 1,
  };
  all[gameId] = record;
  writeAll(all);
  return { record, isNewBestStreak, isNewBestPoints };
}

/** Points a correct answer earns at `stepIndex` of `stepsCount` (first step scores highest). */
export function pointsForStep(stepIndex, stepsCount) {
  return stepsCount - stepIndex;
}
