// App configuration. The only file that needs per-user setup.
// Fill CLIENT_ID with the Client ID from your Spotify Dashboard app.

export const CLIENT_ID = "11bf3136b0db49b5b62106357599deb4";

// Redirect URI = current origin. Register every origin you serve the app from
// in the Spotify Dashboard: `http://127.0.0.1:8080/` in dev (Spotify rejects
// "localhost") and `https://guessi.becode.com.ar/` in production.
export const REDIRECT_URI = `${window.location.origin}/`;

// Exact 8 scopes required by the change (streaming + library read + playback).
export const SCOPES = [
  "streaming",
  "user-read-email",
  "user-read-private",
  "user-read-playback-state",
  "user-modify-playback-state",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
];

export const SDK_URL = "https://sdk.scdn.co/spotify-player.js";

// Cover image URLs are perishable (Spotify expires them in < 1 day).
// 12 hours is the freshness window before a lazy re-fetch.
export const COVER_TTL_MS = 12 * 60 * 60 * 1000;

export const AUTH_ENDPOINT = "https://accounts.spotify.com/authorize";
export const TOKEN_ENDPOINT = "https://accounts.spotify.com/api/token";
export const API_BASE = "https://api.spotify.com/v1";

// Player display name shown in the Spotify device picker.
export const PLAYER_NAME = "de oído";