// The whole HTTP surface. `createApp` takes its collaborators so tests can pass
// a temp database and a fake Spotify.

import express from "express";
import { summarize } from "../src/letra-stats.js";
import { authMiddleware, createTokenCache } from "./auth.js";
import {
  allUsers, countUsers, dbCreatedAt, lastPlayedAt, playsOf, transaction, upsertPlay, upsertUser, wordsTypedSince,
} from "./db.js";
import { MAX_PLAYS_PER_REQUEST, validatePlay } from "./validate.js";

const WEEK_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const userJson = (u) => ({
  id: u.id,
  displayName: u.displayName ?? u.display_name,
  imageUrl: u.imageUrl ?? u.image_url ?? null,
});

/**
 * @param {object} deps
 * @param {import("node:sqlite").DatabaseSync} deps.db
 * @param {(token: string) => Promise<{id:string, display_name?:string, images?:Array}|null>} deps.fetchMe
 * @param {() => number} [deps.now] clock in ms
 */
export function createApp({ db, fetchMe, now = Date.now }) {
  const app = express();
  app.disable("x-powered-by");
  app.set("etag", false);

  const cache = createTokenCache(now);
  const auth = authMiddleware({
    fetchMe,
    cache,
    onUser: (user) => upsertUser(db, user, new Date(now()).toISOString()),
  });

  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (req, res) => {
    res.json({ ok: true, dbCreatedAt: dbCreatedAt(db), users: countUsers(db) });
  });

  /** The player's own day, if the client says so; otherwise UTC. */
  const todayOf = (req) => {
    const q = req.query.today;
    return typeof q === "string" && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date(now()).toISOString().slice(0, 10);
  };

  app.get("/api/me", auth, (req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    res.json({
      user: { ...userJson(u), createdAt: u.created_at, lastSeenAt: u.last_seen_at },
      summary: summarize(playsOf(db, req.user.id), todayOf(req)),
    });
  });

  app.post("/api/plays", auth, express.json({ limit: "1mb" }), (req, res) => {
    const list = req.body?.plays;
    if (!Array.isArray(list)) return res.status(400).json({ error: "plays_required" });
    if (list.length > MAX_PLAYS_PER_REQUEST) return res.status(413).json({ error: "too_many_plays", max: MAX_PLAYS_PER_REQUEST });
    let saved = 0;
    let skipped = 0;
    transaction(db, () => {
      for (const raw of list) {
        const record = validatePlay(raw);
        if (!record) {
          skipped++;
          continue;
        }
        upsertPlay(db, req.user.id, record);
        saved++;
      }
    });
    res.json({ saved, skipped });
  });

  app.get("/api/me/plays", auth, (req, res) => {
    const n = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(n) && n > 0 ? Math.min(n, MAX_LIMIT) : DEFAULT_LIMIT;
    res.json({ plays: playsOf(db, req.user.id, limit) });
  });

  app.get("/api/friends", auth, (req, res) => {
    const today = todayOf(req);
    const since = new Date(now() - WEEK_MS).toISOString();
    const friends = allUsers(db).map((u) => {
      const summary = summarize(playsOf(db, u.id), today);
      return {
        ...userJson(u),
        isMe: u.id === req.user.id,
        lastPlayedAt: lastPlayedAt(db, u.id),
        wordsThisWeek: wordsTypedSince(db, u.id, since),
        summary,
      };
    });
    friends.sort((a, b) => b.wordsThisWeek - a.wordsThisWeek || b.summary.wordsTyped - a.summary.wordsTyped || a.id.localeCompare(b.id));
    res.json({ friends });
  });

  app.use("/api", (req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === "entity.too.large") return res.status(413).json({ error: "body_too_large" });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "bad_json" });
    // Message only: never the request, which carries the Authorization header.
    console.error("unhandled error:", err?.message ?? "unknown");
    res.status(500).json({ error: "internal" });
  });

  return app;
}
