// SQLite through the built-in node:sqlite. One file, a handful of users: the
// schema is created on open and never migrated destructively.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    image_url    TEXT,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plays (
    user_id     TEXT NOT NULL REFERENCES users(id),
    id          TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT NOT NULL,
    track_id    TEXT NOT NULL,
    track_name  TEXT NOT NULL,
    status      TEXT NOT NULL,
    pct         REAL NOT NULL,
    words_typed INTEGER NOT NULL,
    active_ms   INTEGER NOT NULL,
    record      TEXT NOT NULL,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS plays_by_user_ended ON plays (user_id, ended_at);
`;

/**
 * @param {string} path file path, or ":memory:" in tests
 * @param {() => number} [now] clock in ms, injected by tests
 */
export function openDb(path, now = Date.now) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // Set once, on the first start ever: if it survives a redeploy, so does the data.
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)").run(new Date(now()).toISOString());
  return db;
}

export function dbCreatedAt(db) {
  return db.prepare("SELECT value FROM meta WHERE key = 'created_at'").get()?.value ?? null;
}

export function upsertUser(db, { id, displayName, imageUrl }, nowIso) {
  db.prepare(`
    INSERT INTO users (id, display_name, image_url, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      image_url = excluded.image_url,
      last_seen_at = excluded.last_seen_at
  `).run(id, displayName, imageUrl, nowIso, nowIso);
}

/**
 * Stores a play for a user. An existing play with the same (user, id) is only
 * replaced by one that ended at the same time or later, so a stale retry can
 * never roll a record back.
 */
export function upsertPlay(db, userId, record) {
  db.prepare(`
    INSERT INTO plays (user_id, id, started_at, ended_at, track_id, track_name, status, pct, words_typed, active_ms, record)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      track_id = excluded.track_id,
      track_name = excluded.track_name,
      status = excluded.status,
      pct = excluded.pct,
      words_typed = excluded.words_typed,
      active_ms = excluded.active_ms,
      record = excluded.record
    WHERE excluded.ended_at >= plays.ended_at
  `).run(
    userId, record.id, record.startedAt, record.endedAt, record.track.id, record.track.name,
    record.status, record.pct, record.words.typed, record.activeMs, JSON.stringify(record),
  );
}

export function transaction(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Every record of a user, newest first. */
export function playsOf(db, userId, limit = -1) {
  return db
    .prepare("SELECT record FROM plays WHERE user_id = ? ORDER BY ended_at DESC, id DESC LIMIT ?")
    .all(userId, limit)
    .map((row) => JSON.parse(row.record));
}

export function lastPlayedAt(db, userId) {
  return db.prepare("SELECT MAX(ended_at) AS at FROM plays WHERE user_id = ?").get(userId)?.at ?? null;
}

export function wordsTypedSince(db, userId, sinceIso) {
  return db
    .prepare("SELECT COALESCE(SUM(words_typed), 0) AS n FROM plays WHERE user_id = ? AND started_at >= ?")
    .get(userId, sinceIso).n;
}

export function allUsers(db) {
  return db.prepare("SELECT id, display_name, image_url, created_at, last_seen_at FROM users").all();
}

export function countUsers(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
}
