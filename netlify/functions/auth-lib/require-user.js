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

module.exports = { requireUser, requireRole, bearer };
