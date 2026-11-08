// Spotify-token authentication. The token is only ever used for one request to
// Spotify and as a hashed in-memory cache key: never logged, never stored.

import { createHash } from "node:crypto";

export const CACHE_TTL_MS = 10 * 60 * 1000;
export const CACHE_MAX = 200;
const SPOTIFY_ME = "https://api.spotify.com/v1/me";

/**
 * Real Spotify lookup. Resolves to a profile when the token is good, to null
 * when Spotify rejects it, and throws when Spotify can't be reached or fails.
 */
export async function fetchMeFromSpotify(token) {
  const res = await fetch(SPOTIFY_ME, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new Error(`spotify answered ${res.status}`);
  const me = await res.json();
  if (!me || typeof me.id !== "string" || !me.id) throw new Error("spotify answered without an id");
  return { id: me.id, display_name: me.display_name, images: me.images };
}

export function toUser(me) {
  const id = String(me.id).slice(0, 128);
  const name = typeof me.display_name === "string" && me.display_name.trim() ? me.display_name.trim() : id;
  const image = Array.isArray(me.images) ? me.images[0]?.url : null;
  return {
    id,
    displayName: name.slice(0, 100),
    imageUrl: typeof image === "string" && image.length <= 500 ? image : null,
  };
}

const keyOf = (token) => createHash("sha256").update(token).digest("hex");

/** Token -> user cache: bounded, entries expire after CACHE_TTL_MS. */
export function createTokenCache(now, ttl = CACHE_TTL_MS, max = CACHE_MAX) {
  const map = new Map();
  return {
    get(token) {
      const k = keyOf(token);
      const hit = map.get(k);
      if (!hit) return null;
      if (hit.expires <= now()) {
        map.delete(k);
        return null;
      }
      return hit.user;
    },
    set(token, user) {
      if (map.size >= max) {
        for (const [k, v] of map) if (v.expires <= now()) map.delete(k);
        // Still full: drop the oldest insertions.
        while (map.size >= max) map.delete(map.keys().next().value);
      }
      const k = keyOf(token);
      map.delete(k);
      map.set(k, { user, expires: now() + ttl });
    },
    get size() {
      return map.size;
    },
  };
}

/** Express middleware: sets req.user or answers 401 / 503. */
export function authMiddleware({ fetchMe, cache, onUser }) {
  return async (req, res, next) => {
    const m = /^Bearer ([\x21-\x7e]{1,2048})$/.exec(req.get("authorization") ?? "");
    if (!m) return res.status(401).json({ error: "missing_token" });
    const token = m[1];
    const cached = cache.get(token);
    if (cached) {
      req.user = cached;
      return next();
    }
    let me;
    try {
      me = await fetchMe(token);
    } catch {
      return res.status(503).json({ error: "spotify_unavailable" });
    }
    if (!me || me.id == null || me.id === "") return res.status(401).json({ error: "invalid_token" });
    const user = toUser(me);
    onUser(user);
    cache.set(token, user);
    req.user = user;
    next();
  };
}
