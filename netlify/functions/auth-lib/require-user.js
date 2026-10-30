// require-user.js — shared portal-token verification for Netlify functions.
// Reuses the Deal Pipeline HMAC token (deal-lib/token.js) signed with
// DEAL_SESSION_SECRET. Portal tokens carry kind:'portal' so a deal token (same
// secret, different shape) can't satisfy portal auth and vice-versa.
const { verifyToken } = require('../deal-lib/token');

function bearer(event) {
  const h = (event && event.headers) || {};
  const raw = h.authorization || h.Authorization || '';
  if (raw.startsWith('Bearer ')) return raw.slice(7);
  // Fallback: HttpOnly session cookie (pcg_session) set by portal-auth on login.
  // Lets the secure cookie authenticate even when no Authorization header is sent.
  const cookie = h.cookie || h.Cookie || '';
  const m = /(?:^|;\s*)pcg_session=([^;]*)/.exec(cookie);
  if (!m) return '';
  // decodeURIComponent throws on malformed encoding (e.g. "%XY"); never let a crafted
  // cookie crash auth — fall back to the raw value (the token has no %-encoded chars).
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

// v22.34 Director of Operations: a Director oversees several districts but always views
// ONE at a time, chosen in the portal's switcher and sent in the pcg_view_district cookie.
// While viewing, they are scoped exactly like that district's DM: userType becomes 'dm',
// district the viewed one, realUserType 'director'. Only a district on their own list is
// ever honoured (anything else → their first). No districts → no DM scope at all.
// Same rule as pickViewDistrict in src/director-scope.mjs — keep the two in step.
function parseDistrictList(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(/[,\s]+/);
  return [...new Set(list.map(Number).filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}
function applyDirectorScope(claims, cookieHeader) {
  if (!claims) return claims;
  const real = claims.realUserType || claims.userType;
  if (real !== 'director') return claims;
  const districts = parseDistrictList(claims.districts);
  const m = /(?:^|;\s*)pcg_view_district=(\d+)/.exec(String(cookieHeader || ''));
  const requested = m ? Number(m[1]) : null;
  claims.realUserType = 'director';
  claims.districts = districts;
  if (!districts.length) { claims.userType = 'director'; claims.district = null; return claims; }
  claims.userType = 'dm';
  claims.district = districts.includes(requested) ? requested : districts[0];
  return claims;
}
// Every district this caller may see, as strings: a Director's whole list (their portal
// page shows all of them at once, stacked), a DM's one district, else []. DM scope checks
// use this instead of comparing against `district` alone.
function claimDistricts(claims) {
  if (!claims) return [];
  const list = Array.isArray(claims.districts) && claims.districts.length ? claims.districts : (claims.district != null ? [claims.district] : []);
  return list.map(String);
}
function cookieOf(event) {
  const h = (event && event.headers) || {};
  return h.cookie || h.Cookie || '';
}

// Returns the token claims { kind:'portal', username, userType, district, name }
// or null if missing / invalid / expired / not a portal token.
function requireUser(event, opts = {}) {
  const secret = opts.secret || process.env.DEAL_SESSION_SECRET;
  if (!secret) return null;
  const claims = verifyToken(bearer(event), secret);
  if (!claims || claims.kind !== 'portal') return null;
  return applyDirectorScope(claims, cookieOf(event));
}

// True if the user's userType is in the allowed list (string or array).
function requireRole(user, types) {
  if (!user) return false;
  const list = Array.isArray(types) ? types : [types];
  return list.includes(user.userType);
}

// Sign-out-everywhere check: a token is valid only if it was issued at or after the
// user's sessions_valid_from cutoff. Pure + testable. No cutoff → never revoked.
function sessionIsValid(claims, sessionsValidFrom) {
  if (!sessionsValidFrom) return true;
  const cutoffSec = Math.floor(new Date(sessionsValidFrom).getTime() / 1000);
  if (!Number.isFinite(cutoffSec)) return true;
  // 10s leeway so function-server vs DB clock skew can't reject a token minted right
  // after a revoke (the post-revoke re-login). Old tokens are still well below cutoff.
  const iat = (claims && typeof claims.iat === 'number') ? claims.iat : 0;
  return iat >= cutoffSec - 10;
}

// requireUser + a DB check that the token hasn't been revoked by sign-out-everywhere.
// `db` is the neon sql tag. Fails OPEN on a DB error (token already expires in ≤12h)
// so a transient DB blip can't log the whole company out.
async function requireActiveUser(event, db, opts = {}) {
  const claims = requireUser(event, opts);
  if (!claims) return null;
  try {
    const rows = await db`SELECT sessions_valid_from, active, audits_access FROM users WHERE id = ${claims.sub}`;
    // Definitive answers from a successful query fail CLOSED: a deleted or deactivated
    // user, or a token issued before a sign-out-everywhere cutoff, is rejected.
    if (!rows.length) return null;
    if (rows[0].active === false) return null;
    if (!sessionIsValid(claims, rows[0].sessions_valid_from)) return null;
    // Fresh per-request lookup (not baked into the signed token) so a grant/revoke
    // by an executive/it admin takes effect immediately, not just at next login.
    claims.auditsAccess = rows[0].audits_access ?? null;
    // A Director's district list is read fresh each request (not just from the token), so
    // adding or removing a district in Admin applies immediately. Own query + catch: the
    // column is self-ensured by users.mjs and may not exist yet on a fresh deploy.
    if (claims.realUserType === 'director') {
      try {
        const d = await db`SELECT director_districts FROM users WHERE id = ${claims.sub}`;
        if (d.length) { claims.districts = d[0].director_districts; applyDirectorScope(claims, cookieOf(event)); }
      } catch { /* keep the token's list */ }
    }
  } catch {
    // The first query can fail for a reason unrelated to active/session enforcement:
    // audits_access is self-ensured by users.mjs/audits.mjs (idempotent ALTER), so on a
    // fresh deploy this shared lib can be called before either has run, and the column
    // won't exist yet. Retry once with the original two-column SELECT so a missing
    // column degrades to auditsAccess=null instead of falling open on active/session
    // checks — only a genuine DB error on the reduced query still fails open.
    try {
      const rows = await db`SELECT sessions_valid_from, active FROM users WHERE id = ${claims.sub}`;
      if (!rows.length) return null;
      if (rows[0].active === false) return null;
      if (!sessionIsValid(claims, rows[0].sessions_valid_from)) return null;
      claims.auditsAccess = null;
    } catch { /* only a DB ERROR fails open (token still expires in ≤12h) — not a 0-row result */ }
  }
  return claims;
}

// Gate for userId-trust endpoints (analyst, tasks). If the request carries a session token
// (Authorization header OR the pcg_session cookie, auto-sent same-origin), it MUST be active:
// a revoked/expired/deactivated token returns 'revoked'. If NO token is present (server-internal
// cron/MCP callers, or a not-yet-tokenized path), returns 'no-token' and the caller proceeds with
// its existing userId-based behavior — so this adds revocation enforcement without new breakage.
async function sessionGate(event, db) {
  // Only a structurally-VALID portal token can be "revoked". No token, an expired token, an
  // invalid signature, or a non-portal token (e.g. an MCP/cron secret) → 'no-token', i.e. fall
  // through to the caller's existing userId behavior. This guarantees no regression for the
  // server-internal callers that legitimately don't carry a portal session.
  const claims = requireUser(event);
  if (!claims) return 'no-token';
  try {
    const rows = await db`SELECT sessions_valid_from, active FROM users WHERE id = ${claims.sub}`;
    if (!rows.length) return 'revoked';
    if (rows[0].active === false) return 'revoked';
    if (!sessionIsValid(claims, rows[0].sessions_valid_from)) return 'revoked';
  } catch { return 'active'; } // DB error → don't block (fail open)
  return 'active';
}

module.exports = { requireUser, requireRole, bearer, sessionIsValid, requireActiveUser, sessionGate, applyDirectorScope, claimDistricts };
