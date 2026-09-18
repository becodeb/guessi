// PKCE Authorization Code flow for a static SPA (design D4, spotify-auth spec).
// Tokens never appear in URLs, logs, or UI — only in localStorage.

import {
  CLIENT_ID,
  REDIRECT_URI,
  SCOPES,
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
} from "./config.js";
import * as storage from "./storage.js";

const sessionExpiredListeners = new Set();

/** @param {(reason: string) => void} cb */
export function onSessionExpired(cb) {
  sessionExpiredListeners.add(cb);
  return () => sessionExpiredListeners.delete(cb);
}

function notifySessionExpired(reason) {
  for (const cb of sessionExpiredListeners) cb(reason);
}

function base64Url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomBytes(n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64Url(new Uint8Array(digest));
}

/** Start the PKCE login: verifier + S256 challenge + state, then redirect. */
export async function authorize() {
  const codeVerifier = base64Url(randomBytes(64)); // 86 chars, within 43–128
  const state = base64Url(randomBytes(32));
  storage.setAuthState({ state, code_verifier: codeVerifier });

  const challenge = await sha256Base64Url(codeVerifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state,
    scope: SCOPES.join(" "),
  });
  window.location.assign(`${AUTH_ENDPOINT}?${params.toString()}`);
}

/**
 * Handle the OAuth callback (?code&state in the query string).
 * Returns true when a session was established, false otherwise.
 * On state mismatch the exchange is aborted, partial state cleared, and the
 * caller shows the re-login prompt.
 */
export async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");

  // Not a callback (no code): nothing to do.
  if (!code) return false;

  // Clean the code/state out of the URL (never keep credentials in URLs).
  window.history.replaceState({}, "", window.location.pathname);

  const stored = storage.getAuthState();
  if (error || !stored || !state || state !== stored.state) {
    storage.clearAuthState();
    return false;
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: stored.code_verifier,
  });

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      storage.clearAuthState();
      return false;
    }
    const data = await res.json();
    persistTokenResponse(data);
    storage.clearAuthState();
    return true;
  } catch {
    storage.clearAuthState();
    return false;
  }
}

function persistTokenResponse(data) {
  storage.saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scopes: data.scope ? data.scope.split(" ") : [...SCOPES],
  });
}

let refreshInFlight = null;

/**
 * Refresh the access token. Returns true on success, false when the session
 * is gone (invalid_grant → tokens cleared → re-login prompt).
 */
export async function refreshToken() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const tokens = storage.loadTokens();
    if (!tokens?.refresh_token) return false;
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: CLIENT_ID,
    });
    try {
      const res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) {
        if (res.status === 400 || res.status === 401) {
          // invalid_grant: refresh token expired (~6 months) → re-login.
          storage.clearTokens();
          notifySessionExpired("invalid_grant");
        }
        return false;
      }
      const data = await res.json();
      storage.saveTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? tokens.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
        scopes: data.scope ? data.scope.split(" ") : tokens.scopes ?? [...SCOPES],
      });
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Current access token, refreshing first when expired or missing.
 * Returns null when no session exists (caller must prompt login).
 */
export async function getAccessToken() {
  const tokens = storage.loadTokens();
  if (!tokens?.access_token) return null;
  if (Date.now() >= tokens.expires_at - 30_000) {
    const ok = await refreshToken();
    if (!ok) return null;
  }
  return storage.loadTokens()?.access_token ?? null;
}

/**
 * Whether the stored session was granted a scope.
 * A session opened before a scope was added keeps working for everything
 * else, so the view asks this instead of waiting for a 403.
 * @param {string} scope
 */
export function hasScope(scope) {
  return (storage.loadTokens()?.scopes ?? []).includes(scope);
}

export function isAuthenticated() {
  return Boolean(storage.loadTokens()?.access_token);
}

export function logout() {
  storage.clearTokens();
}

export { CLIENT_ID, REDIRECT_URI, SCOPES };