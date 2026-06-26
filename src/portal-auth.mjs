// PCG Portal — client auth helpers (ESM, bundled into app.jsx by esbuild).
// Phase B of the portal-auth rollout: the browser exchanges the user's credential
// for a server-signed portal token (kind:'portal', HMAC via DEAL_SESSION_SECRET).
// The token is held in memory + sessionStorage and relayed as a Bearer header on
// every authenticated request — the server verifies it; the browser never grants
// access on its own.
//
// No-lockout design: portalLogin distinguishes a clean rejection (401/403 — wrong
// credential) from an unreachable endpoint (network error / 5xx). Only the latter
// returns { unreachable:true }, which the caller treats as a grace signal to fall
// back to the legacy client-side compare. A clean 401 is a real "invalid login".
const FN = '/.netlify/functions';
const TOKEN_KEY = 'pcg_portal_token';

// In-memory token, hydrated from sessionStorage so a page refresh (which restores
// user state from localStorage) keeps an authenticated session alive.
let _token = null;
try {
  if (typeof sessionStorage !== 'undefined') _token = sessionStorage.getItem(TOKEN_KEY) || null;
} catch { /* sessionStorage blocked (private mode) → memory-only */ }

export function getSessionToken() { return _token; }

export function setSessionToken(token) {
  _token = token || null;
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (_token) sessionStorage.setItem(TOKEN_KEY, _token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore storage failures; in-memory token still works */ }
}

export function clearSessionToken() { setSessionToken(null); }

// Clear the held token AND ask the server to expire the secure session cookie.
// Best-effort: the local token is always cleared even if the network call fails.
export async function portalLogout() {
  clearSessionToken();
  try { await fetch(`${FN}/portal-auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'logout' }) }); }
  catch { /* ignore — cookie also expires on its own */ }
}

// Authorization header object for fetch(), or {} when no token is held. Spread it
// into a headers object: fetch(url, { headers: { ...authHeader(), ... } }).
export function authHeader() {
  return _token ? { Authorization: `Bearer ${_token}` } : {};
}

// Shape the server reply into a stable result the Login flow can branch on.
//   ok          — credential verified, token issued
//   unreachable — endpoint could not be reached (network/5xx) → grace fallback
//   status      — HTTP status when the server replied
async function post(body) {
  let res;
  try {
    res = await fetch(`${FN}/portal-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, unreachable: true }; // network error — server never answered
  }
  // 5xx means the function errored/cold-failed → treat as unreachable (grace), not a rejection.
  if (res.status >= 500) return { ok: false, unreachable: true, status: res.status };
  let j = {};
  try { j = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) return { ok: false, unreachable: false, status: res.status, error: j.error || `login ${res.status}`, locked: !!j.locked, attemptsRemaining: j.attemptsRemaining };
  setSessionToken(j.token || null);
  return { ok: true, token: j.token || null, user: j.user || null, mustChange: !!j.mustChange, expiresIn: j.expiresIn };
}

// Exchange a username + password for a portal token.
export async function portalLogin(username, password) {
  return post({ action: 'login', username, password });
}

// Exchange a verified Google ID token (GSI credential JWT) for a portal token.
// NOTE: requires the ID-token ("Sign in with Google" credential) flow, not the
// OAuth2 access-token flow. The current Google button still uses access tokens;
// migrating it is a follow-up, so Google logins ride the grace fallback until then.
export async function portalLoginGoogle(idToken) {
  return post({ action: 'login', googleIdToken: idToken });
}

// Change the current user's password (requires a held token). The server flips
// must_change=false on success.
export async function portalChangePassword(oldPassword, newPassword) {
  return post({ action: 'change-password', oldPassword, newPassword });
}

// Verify the held token is still valid and return its claims, or null.
export async function portalMe() {
  if (!_token) return null;
  try {
    const res = await fetch(`${FN}/portal-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'me' }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.user || null;
  } catch {
    return null;
  }
}
