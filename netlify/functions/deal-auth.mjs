// PCG Deal Pipeline — server-side auth. Verifies a caller (password against the
// pcg_users_v1 blob, OR a Google ID token), confirms they're in deal_access, and
// issues a short-lived signed token used by all deal endpoints.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.js';
import { signToken } from './deal-lib/token.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

async function loadUsers() {
  try { const w = await blobStore().get('pcg_users_v1', { type: 'json' }); const d = w?.data || w; return Array.isArray(d) ? d : (d?.users || []); }
  catch { return []; }
}

// Public OAuth client id (NOT a secret — already shipped in the browser bundle, app.jsx).
// Hardcoded rather than an env var to stay under AWS Lambda's 4KB env-var limit.
const GSI_CLIENT_ID = '450079580275-s9db563vj8npg93e15gdgrlkvcsu0n52.apps.googleusercontent.com';

async function verifyGoogle(idToken) {
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client(GSI_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: GSI_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email_verified) return null;
  return lc(p.email);
}

export default async (request, context) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: cors });

  let body;
  try { body = await request.json().catch(() => ({})); } catch { return new Response(JSON.stringify({ error: 'bad json' }), { status: 400, headers: cors }); }

  let identityKeys = []; let userId = null;
  try {
    if (body.googleIdToken) {
      const email = await verifyGoogle(body.googleIdToken);
      if (!email) return new Response(JSON.stringify({ error: 'google verification failed' }), { status: 401, headers: cors });
      const users = await loadUsers();
      const u = users.find(x => lc(x.email) === email);
      identityKeys = [email, lc(u?.username)].filter(Boolean);
      userId = u?.id ?? null;
    } else if (body.username && body.password) {
      const users = await loadUsers();
      const u = users.find(x => lc(x.username) === lc(body.username));
      if (!u || u.active === false || String(u.password || '') !== String(body.password)) {
        return new Response(JSON.stringify({ error: 'invalid credentials' }), { status: 401, headers: cors });
      }
      identityKeys = [lc(u.username), lc(u.email)].filter(Boolean);
      userId = u.id ?? null;
    } else {
      return new Response(JSON.stringify({ error: 'username+password or googleIdToken required' }), { status: 400, headers: cors });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: 'auth error' }), { status: 500, headers: cors });
  }

  let role = null;
  try {
    const db = sql();
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
