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

// Returns the token claims { kind:'portal', username, userType, district, name }
// or null if missing / invalid / expired / not a portal token.
function requireUser(event, opts = {}) {
  const secret = opts.secret || process.env.DEAL_SESSION_SECRET;
  if (!secret) return null;
  const claims = verifyToken(bearer(event), secret);
  if (!claims || claims.kind !== 'portal') return null;
  return claims;
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

module.exports = { requireUser, requireRole, bearer, sessionIsValid, requireActiveUser, sessionGate };
