// PCG Deal Pipeline — server-side auth. Verifies a caller via EITHER their existing
// portal session token (password login) OR a live Google access token (Google login),
// confirms they're an allowed role AND listed in deal_access, and issues a short-lived signed
// deal token used by all deal endpoints. Never handles a raw password — that ended with
// the Neon migration (the old flow re-checked the legacy pcg_users_v1 blob, which no
// longer carries current credentials and doesn't match the portal's own login anymore).
import { sql } from './_shared/db.mjs';
import { signToken } from './deal-lib/token.js';
import { requireUser, sessionIsValid } from './auth-lib/require-user.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());

// Deal Pipeline is limited to IT/Exec/Office Staff regardless of who else might be
// in deal_access — a deal_access row alone is not enough for other user types.
const ALLOWED_ROLES = new Set(['it', 'executive', 'office_staff']);

export default async (request, context) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors });

  let body;
  try { body = await request.json().catch(() => ({})); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: cors }); }

  const db = sql();
  let identityKeys = []; let userId = null; let userType = null;

  try {
    if (body.portalToken) {
      // Password-login path: the caller already holds a verified portal session token
      // (kind:'portal', signed with the same DEAL_SESSION_SECRET). requireUser checks
      // signature/expiry; sessionIsValid (checked below against the single row fetch)
      // checks sessions_valid_from, so a "sign out everywhere" revocation actually
      // cuts off Deal Pipeline access, not just the portal itself. Re-derive identity
      // from the Neon users table by id — never trust claims fields as authoritative.
      const eventShim = { headers: { authorization: `Bearer ${String(body.portalToken)}` } };
      const claims = requireUser(eventShim);
      if (!claims || claims.sub == null) {
        return new Response(JSON.stringify({ error: 'invalid or expired session' }), { status: 401, headers: cors });
      }
      const [u] = await db`SELECT id, username, email, user_type, active, sessions_valid_from FROM users WHERE id = ${claims.sub}`;
      if (!u || u.active === false) return new Response(JSON.stringify({ error: 'account not found' }), { status: 401, headers: cors });
      if (!sessionIsValid(claims, u.sessions_valid_from)) {
        return new Response(JSON.stringify({ error: 'invalid or expired session' }), { status: 401, headers: cors });
      }
      identityKeys = [lc(u.username), lc(u.email)].filter(Boolean);
      userId = u.id; userType = u.user_type;
    } else if (body.googleAccessToken) {
      // Google-login path: verify the access token live against Google's userinfo
      // endpoint (same approach portal-auth.mjs uses), then look up by verified email.
      const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${body.googleAccessToken}` },
      });
      if (!gRes.ok) return new Response(JSON.stringify({ error: 'invalid Google token' }), { status: 401, headers: cors });
      const profile = await gRes.json();
      if (!profile.email_verified) return new Response(JSON.stringify({ error: 'email not verified' }), { status: 401, headers: cors });
      const email = lc(profile.email);
      const [u] = await db`SELECT id, username, email, user_type, active FROM users WHERE lower(email) = ${email} AND active = true LIMIT 1`;
      if (!u) return new Response(JSON.stringify({ error: 'no active account for this Google email' }), { status: 403, headers: cors });
      identityKeys = [lc(u.username), lc(u.email)].filter(Boolean);
      userId = u.id; userType = u.user_type;
    } else {
      return new Response(JSON.stringify({ error: 'portalToken or googleAccessToken required' }), { status: 400, headers: cors });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: 'auth error' }), { status: 500, headers: cors });
  }

  if (!ALLOWED_ROLES.has(userType)) {
    return new Response(JSON.stringify({ error: 'Deal Pipeline access is limited to IT/Exec/Office Staff.' }), { status: 403, headers: cors });
  }

  let role = null;
  try {
    const rows = await db`SELECT user_key, role FROM deal_access WHERE user_key = ANY(${identityKeys})`;
    const rank = { view: 1, edit: 2, admin: 3 };
    role = rows.reduce((best, r) => (rank[r.role] > (rank[best] || 0) ? r.role : best), null);
  } catch (e) {
    return new Response(JSON.stringify({ error: 'access lookup failed' }), { status: 500, headers: cors });
  }
  if (!role) return new Response(JSON.stringify({ error: 'no deal access' }), { status: 403, headers: cors });

  const secret = process.env.DEAL_SESSION_SECRET;
  if (!secret) return new Response(JSON.stringify({ error: 'server not configured' }), { status: 500, headers: cors });
  const token = signToken({ sub: userId, username: identityKeys[0], role }, secret);
  return new Response(JSON.stringify({ token, role, expiresIn: 43200 }), { status: 200, headers: cors });
};
