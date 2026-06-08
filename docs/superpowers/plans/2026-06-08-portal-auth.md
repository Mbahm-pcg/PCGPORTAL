# Portal-Wide Authentication Implementation Plan

**Goal:** Replace client-side credential checking with real server-side authentication: hashed credentials stored server-side, a signed session token issued at login, and that token required by all sensitive read endpoints — rolled out without locking out the ~45 active users.

**Architecture:** Reuse the Deal Pipeline's proven HMAC token (`deal-lib/token.js`, `DEAL_SESSION_SECRET`). A new `portal-auth.js` verifies credentials server-side and mints a portal token `{username, userType, district, exp}`. A shared `auth-lib/require-user.js` verifies it in each function. Rollout is phased with a grace period so no user is ever locked out mid-deploy.

**Tech Stack:** Netlify Functions (CommonJS), Neon Postgres (`portal_users` table, scrypt-hashed passwords), Netlify Blobs, React (app.jsx) bundled by esbuild.

---

## The exposure being fixed
1. `USERS_SEED` in `app.jsx` (lines ~64–110+) ships **plaintext passwords** for every user in the public `app.js` bundle.
2. `pcg_users_v1` (passwords included) is readable by anyone via the **unauthenticated** `/storage` function.
3. Login compares passwords **client-side** (`app.jsx:714`) — no server ever verifies a credential.

## Rollout phases (each independently deployable & safe)

### Phase A — Foundation (additive, no behavior change)
- `auth-lib/passwords.js`: scrypt hash + verify (Node `crypto`, no new deps).
- `auth-lib/require-user.js`: `requireUser(event)` → verifies Bearer token via `verifyToken(...DEAL_SESSION_SECRET)`; returns user or null. Plus `requireRole(user, [types])`.
- `portal_users` Neon table: `username PK, password_hash, user_type, district, name, active, must_change, updated_at`.
- `portal-auth.js`: actions `login` (verify password OR Google → issue token), `change-password`, `me`. Verifies against `portal_users`; **migration fallback**: if a user has no row yet, verify against the existing `pcg_users_v1` record and lazily create a hashed row (so the store keeps working during cutover).
- Unit tests for passwords + require-user.

### Phase B — Frontend cutover (login uses the server)
- `src/portal-auth.mjs`: `portalLogin(username,password)`, `portalLoginGoogle(idToken)`, token in memory + sessionStorage, `authHeader()`.
- `Login` component calls `portalLogin`; on success stores token, sets user from token claims.
- Grace: if the server endpoint is unreachable, fall back to the current client compare (logged) — removed in Phase D.

### Phase C — Gate endpoints (grace → enforce)
- Add `requireUser` to read endpoints: `ndcp`, `storage`, `pulse`, `labor*`, `food-cost`, `philly-*`, `reconciliation`, `reviews`, `kb-*`, `daily-feed`, `analyst`, `notify`, `push`, `trusted-devices`. (Crons exempt — internal.)
- `cloudLoad`/`cloudSave`/all direct `fetch('/.netlify/functions/...')` attach `authHeader()`.
- Two sub-steps: **accept-but-log-missing** (deploy, watch logs) → **require** (reject 401) once the token-issuing frontend is confirmed live for everyone.

### Phase D — Lock down + rotate
- Remove `USERS_SEED` passwords from `app.jsx`; strip passwords from `pcg_users_v1` (store identity only).
- Remove the client-side compare + grace fallbacks.
- **Reset every active user to a fresh temporary password** (hashed server-side, `must_change=true`), force change on first login.
- **Deliver the temporary-password list to Mike** (the only point passwords are emitted, once, to the owner).

## No-lockout guarantees
- Phases A/B/C-accept change nothing destructive; current login keeps working until Phase B is verified live.
- Endpoint enforcement (C-require) flips only after logs confirm ~all traffic carries a token.
- Phase D password reset happens last, after server login is the only path.

## Rollout status
- **Phase A — DONE** (`auth-lib/passwords.js`, `auth-lib/require-user.js`, `portal-auth.js`, unit tests 8/8 green).
- **Phase B — DONE & DEPLOYED v14.40** (2026-06-08): `src/portal-auth.mjs` (memory+sessionStorage token, `authHeader()`, reachable-vs-unreachable distinction); `Login.submit()` verifies server-side with grace fallback on unreachable; `handleLogout` clears the token. Prod smoke test: bogus creds → HTTP 401 (happy path confirmed: function reachable, secret set, Neon/table OK).
  - **Open before Phase C "require": Google login still uses the OAuth2 access-token flow** → can't mint a portal token (`portal-auth.js` `verifyGoogle` needs a GSI **ID token**). Migrate the Google button to the ID-token credential flow and call `portalLoginGoogle(credential)`, OR Google users will be rejected once endpoints enforce tokens. Until then Google logins ride grace.
- **Phase C — NEXT**: gate read endpoints (accept-but-log-missing → require); attach `authHeader()` in `cloudLoad`/`cloudSave` and direct function fetches.
- **Phase D — pending**: strip passwords from `app.jsx` USERS_SEED + `pcg_users_v1`; remove client compare + grace; reset all users to temp passwords (`must_change`), deliver list to Mike.

## Self-review notes
- Reuses existing token lib + secret → no new env var (4KB Lambda ceiling respected).
- scrypt via Node `crypto` → no new dependency.
- Google login path already exists in `deal-auth.js` — mirror it.
