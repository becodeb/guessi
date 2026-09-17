# Delta for spotify-auth

## ADDED Requirements

### Requirement: PKCE Authorization Code Flow

The system MUST authenticate against Spotify via the PKCE authorization code flow from the static SPA, with no client secret. It MUST generate a `code_verifier` (43–128 chars) and an S256 `code_challenge`, redirect to the Spotify authorize endpoint with `response_type=code`, `code_challenge_method=S256`, `state`, and `redirect_uri`, and exchange the returned `code` at the token endpoint. The `redirect_uri` MUST be `http://127.0.0.1:PORT`; `localhost` MUST NOT be used. The authorize request MUST include exactly the scopes: `streaming`, `user-read-email`, `user-read-private`, `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`, `playlist-read-collaborative`, `user-library-read`. The app MUST NOT store, log, or transmit any client secret.

#### Scenario: First-time login completes

- GIVEN an unauthenticated user who clicks "Iniciar sesión con Spotify"
- WHEN the app issues the PKCE challenge and redirects with the exact 8 scopes
- THEN the user is redirected back to `http://127.0.0.1:PORT` with a code
- AND the app exchanges the code and stores tokens

#### Scenario: localhost redirect is rejected

- GIVEN a `redirect_uri` of `http://localhost:PORT`
- WHEN the authorize request is issued
- THEN Spotify rejects the URI and login fails with a clear error

### Requirement: State Validation

The system MUST generate a random `state`, include it in the authorize URL, and validate it against the value returned in the callback. On mismatch the system MUST abort the exchange, clear any partial session, and prompt the user to re-login.

#### Scenario: Matching state proceeds

- GIVEN the app generated a `state` before redirecting
- WHEN the callback returns the same `state` and a `code`
- THEN the exchange proceeds

#### Scenario: State mismatch aborts login

- GIVEN the callback returns a different `state`
- WHEN the app validates it
- THEN the exchange is aborted and a re-login prompt is shown

### Requirement: Token Storage and Silent Refresh

The system MUST persist `access_token`, `refresh_token`, `expires_at` (derived from `expires_in`), and granted scopes in localStorage. It MUST refresh silently via `grant_type=refresh_token` before any call when the access token is expired, or after a 401. On `invalid_grant` (refresh token expired, ~6 months) the system MUST clear the session and prompt re-login. Tokens MUST NOT appear in URLs, logs, or UI.

#### Scenario: Silent refresh before an API call

- GIVEN a stored access token past `expires_at`
- WHEN an API request is needed
- THEN the app refreshes first and updates stored tokens

#### Scenario: invalid_grant forces re-login

- GIVEN a refresh attempt returns `invalid_grant`
- WHEN the app processes the response
- THEN stored tokens are cleared and the user sees "Vuelve a iniciar sesión"