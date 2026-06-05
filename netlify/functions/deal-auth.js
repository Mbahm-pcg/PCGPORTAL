// PCG Deal Pipeline — server-side auth. Verifies a caller (password against the
// pcg_users_v1 blob, OR a Google ID token), confirms they're in deal_access, and
// issues a short-lived signed token used by all deal endpoints.
const { getStore } = require('@netlify/blobs');
const { sql } = require('./db');
const { signToken } = require('./deal-lib/token');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

async function loadUsers() {
  try { const w = await blobStore().get('pcg_users_v1', { type: 'json' }); const d = w?.data || w; return Array.isArray(d) ? d : (d?.users || []); }
  catch { return []; }
}

async function verifyGoogle(idToken) {
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(process.env.GOOGLE_GSI_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_GSI_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email_verified) return null;
  return lc(p.email);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'bad json' }) }; }

  let identityKeys = []; let userId = null;
  try {
    if (body.googleIdToken) {
      const email = await verifyGoogle(body.googleIdToken);
      if (!email) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'google verification failed' }) };
      const users = await loadUsers();
      const u = users.find(x => lc(x.email) === email);
      identityKeys = [email, lc(u?.username)].filter(Boolean);
      userId = u?.id ?? null;
    } else if (body.username && body.password) {
      const users = await loadUsers();
      const u = users.find(x => lc(x.username) === lc(body.username));
      if (!u || u.active === false || String(u.password || '') !== String(body.password)) {
        return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'invalid credentials' }) };
      }
      identityKeys = [lc(u.username), lc(u.email)].filter(Boolean);
      userId = u.id ?? null;
    } else {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'username+password or googleIdToken required' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'auth error' }) };
  }

  let role = null;
  try {
    const db = sql();
    const rows = await db`SELECT user_key, role FROM deal_access WHERE user_key = ANY(${identityKeys})`;
    const rank = { view: 1, edit: 2, admin: 3 };
    role = rows.reduce((best, r) => (rank[r.role] > (rank[best] || 0) ? r.role : best), null);
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'access lookup failed' }) };
  }
  if (!role) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'no deal access' }) };

  const secret = process.env.DEAL_SESSION_SECRET;
  if (!secret) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'server not configured' }) };
  const token = signToken({ sub: userId, username: identityKeys[0], role }, secret);
  return { statusCode: 200, headers: cors, body: JSON.stringify({ token, role, expiresIn: 43200 }) };
};
