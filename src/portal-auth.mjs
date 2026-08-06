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

// Exchange a GIS OAuth2 access token (the flow the current Google button uses) for a
// portal token. Server verifies the token with Google (tokeninfo, audience-checked).
export async function portalLoginGoogleAccess(accessToken) {
  return post({ action: 'login', googleAccessToken: accessToken });
}

// Change the current user's password (requires a held token). The server flips
// must_change=false on success.
export async function portalChangePassword(oldPassword, newPassword) {
  return post({ action: 'change-password', oldPassword, newPassword });
}

// Lightweight session validity probe used by the periodic re-check loop. Distinguishes
// a REVOKED/expired session (force logout) from a transient network/server error (ignore).
//   'ok' | 'revoked' | 'error' | 'no-token'
export async function portalValidate() {
  if (!_token) return 'no-token';
  try {
    const res = await fetch(`${FN}/portal-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify({ action: 'me' }),
    });
    if (res.status === 401) return 'revoked';
    if (!res.ok) return 'error';
    return 'ok';
  } catch { return 'error'; }
}

// Sign out everywhere. No target → the current user's own sessions (incl. this device);
// IT admins pass targetUserId to force-logout another account. Invalidates all tokens
// issued before now AND revokes trusted devices server-side.
export async function portalRevokeSessions(targetUserId) {
  return post(targetUserId != null ? { action: 'revoke-sessions', targetUserId } : { action: 'revoke-sessions' });
}

// ── WebAuthn (fingerprint / Face ID) ─────────────────────────────────────────
// @simplewebauthn/browser's startRegistration/startAuthentication call the
// native navigator.credentials API and produce JSON shapes that
// @simplewebauthn/server's verify functions expect directly — no manual
// base64url encoding needed here.
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

// Generic POST for actions that must NOT touch the held session token (enroll/
// list/delete all require an existing session but don't return a new one —
// the shared post() helper above unconditionally overwrites the token from
// j.token, which would wipe the current session since these replies have no
// token field at all).
async function postAuthenticated(body) {
  let res;
  try {
    res = await fetch(`${FN}/portal-auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    });
  } catch { return { ok: false, error: 'network error' }; }
  let j = {};
  try { j = await res.json(); } catch {}
  if (!res.ok) return { ok: false, error: j.error || `request failed (${res.status})` };
  return { ok: true, ...j };
}

// True if this browser/device can prompt for a platform biometric at all
// (fingerprint/Face ID hardware present) — check before showing any
// biometric UI so devices without it never see a button that can't work.
export async function webauthnAvailable() {
  try {
    if (!window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

// Enroll this device's biometric for the CURRENTLY logged-in user. Returns
// { ok, error? }.
export async function webauthnRegister() {
  const optRes = await postAuthenticated({ action: 'webauthn-register-options' });
  if (!optRes.ok) return { ok: false, error: optRes.error };
  let credential;
  try {
    credential = await startRegistration({ optionsJSON: optRes.options });
  } catch (e) {
    // User cancelled the prompt, or no platform authenticator available.
    return { ok: false, error: e?.name === 'NotAllowedError' ? 'cancelled' : (e?.message || 'registration failed') };
  }
  const verifyRes = await postAuthenticated({ action: 'webauthn-register-verify', credential });
  // Device-local marker (localStorage, not sessionStorage — must survive a full
  // app close/reopen, not just a page refresh) so the login screen knows this
  // specific device is worth auto-prompting biometric on next open, without
  // needing a username to check. Purely a client-side hint — the login itself
  // is still cryptographically verified server-side regardless of this flag.
  if (verifyRes.ok) { try { localStorage.setItem(DEVICE_ENROLLED_KEY, '1'); } catch {} }
  return verifyRes;
}

const DEVICE_ENROLLED_KEY = 'pcg_webauthn_device_enrolled';
const DEVICE_DECLINED_KEY = 'pcg_webauthn_device_declined';

// True if THIS device has previously completed biometric enrollment — the
// login screen uses this to decide whether to auto-prompt on open.
export function webauthnDeviceEnrolled() {
  try { return localStorage.getItem(DEVICE_ENROLLED_KEY) === '1'; } catch { return false; }
}

// True if the user explicitly dismissed the "enable Face ID/fingerprint?"
// post-login prompt on THIS device — so it's asked once, not every login.
export function webauthnDeviceDeclined() {
  try { return localStorage.getItem(DEVICE_DECLINED_KEY) === '1'; } catch { return false; }
}
export function markWebauthnDeviceDeclined() {
  try { localStorage.setItem(DEVICE_DECLINED_KEY, '1'); } catch {}
}

// List this user's enrolled biometric devices: [{credentialId, deviceLabel, createdAt, lastUsedAt}].
export async function webauthnList() {
  const res = await postAuthenticated({ action: 'webauthn-list' });
  return res.ok ? (res.credentials || []) : [];
}

export async function webauthnDelete(credentialId) {
  const res = await postAuthenticated({ action: 'webauthn-delete', credentialId });
  // Clear the local marker unconditionally on any successful deletion — this
  // device can't tell which credential (if it has several) it actually used,
  // so the safe move is to stop auto-prompting and let the user re-enable if
  // the one they removed wasn't this device's.
  if (res.ok) { try { localStorage.removeItem(DEVICE_ENROLLED_KEY); } catch {} }
  return res;
}

// Log in via a previously-enrolled biometric credential. Pass `username` to
// narrow to one account, or omit it entirely for a "discoverable" login —
// the OS/browser resolves which enrolled credential to use (and which
// account it belongs to) with no username needed at all, for the
// auto-prompt-on-open flow. Same result shape as portalLogin (sets the
// session token on success).
export async function webauthnLogin(username) {
  let res;
  try {
    res = await fetch(`${FN}/portal-auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(username ? { action: 'webauthn-login-options', username } : { action: 'webauthn-login-options' }),
    });
  } catch { return { ok: false, unreachable: true }; }
  if (res.status >= 500) return { ok: false, unreachable: true, status: res.status };
  let j = {};
  try { j = await res.json(); } catch {}
  if (!res.ok) return { ok: false, unreachable: false, status: res.status, error: j.error || 'no biometric login set up' };

  let credential;
  try {
    credential = await startAuthentication({ optionsJSON: j.options });
  } catch (e) {
    return { ok: false, unreachable: false, error: e?.name === 'NotAllowedError' ? 'cancelled' : (e?.message || 'authentication failed') };
  }
  return post({ action: 'webauthn-login-verify', requestId: j.requestId, username, credential });
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
