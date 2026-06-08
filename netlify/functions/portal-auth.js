// portal-auth.js — server-side portal login. Verifies a credential (password or
// Google ID token) and issues a signed portal session token (kind:'portal',
// HMAC via DEAL_SESSION_SECRET). Passwords are stored scrypt-hashed in the Neon
// `portal_users` table.
//
// MIGRATION FALLBACK (during cutover): if a user has no portal_users row yet, the
// legacy plaintext password in pcg_users_v1 is accepted ONCE and a hashed row is
// created transparently. This keeps everyone logged-in-able while we transition,
// and is removed in the final lock-down phase.
//
// This endpoint is ADDITIVE — nothing calls it until the frontend cutover, so it
// changes no current behavior.
const { getStore } = require('@netlify/blobs');
const { sql } = require('./db');
const { signToken } = require('./deal-lib/token');
const { hashPassword, verifyPassword } = require('./auth-lib/passwords');
const { requireUser } = require('./auth-lib/require-user');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const reply = (code, obj) => ({ statusCode: code, headers: cors, body: JSON.stringify(obj) });
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const TTL = 43200; // 12h

const GSI_CLIENT_ID = '450079580275-s9db563vj8npg93e15gdgrlkvcsu0n52.apps.googleusercontent.com';

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function loadUsers() {
  try { const w = await blobStore().get('pcg_users_v1', { type: 'json' }); const d = w?.data || w; return Array.isArray(d) ? d : (d?.users || []); }
  catch { return []; }
}
async function verifyGoogle(idToken) {
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(GSI_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: GSI_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email_verified) return null;
  return lc(p.email);
}
async function ensureTable(db) {
  await db`
    CREATE TABLE IF NOT EXISTS portal_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT,
      user_type TEXT,
      district INT,
      name TEXT,
      email TEXT,
      active BOOLEAN DEFAULT true,
      must_change BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`;
}

// Build the token + safe user object from a resolved identity.
function issue(u, mustChange) {
  const secret = process.env.DEAL_SESSION_SECRET;
  if (!secret) return null;
  const claims = {
    kind: 'portal', sub: u.id ?? null, username: lc(u.username),
    userType: u.userType || u.user_type || null,
    district: u.district ?? null, name: u.name || null,
  };
  const token = signToken(claims, secret, { ttlSeconds: TTL });
  const user = { username: claims.username, userType: claims.userType, district: claims.district, name: claims.name, email: lc(u.email) || null };
  return { token, user, mustChange: !!mustChange, expiresIn: TTL };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  if (!process.env.DEAL_SESSION_SECRET) return reply(500, { error: 'server not configured' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action || 'login';
  const db = sql();

  try {
    await ensureTable(db);

    if (action === 'me') {
      const claims = requireUser(event);
      return claims ? reply(200, { user: claims }) : reply(401, { error: 'unauthorized' });
    }

    if (action === 'login') {
      // ── Google ──
      if (body.googleIdToken) {
        const email = await verifyGoogle(body.googleIdToken);
        if (!email) return reply(401, { error: 'google verification failed' });
        const legacy = (await loadUsers()).find(x => lc(x.email) === email);
        if (!legacy || legacy.active === false) return reply(403, { error: 'no account for this Google email' });
        const [row] = await db`SELECT * FROM portal_users WHERE username = ${lc(legacy.username)}`;
        if (!row) {
          await db`INSERT INTO portal_users (username, user_type, district, name, email, active)
                   VALUES (${lc(legacy.username)}, ${legacy.userType || null}, ${legacy.district ?? null}, ${legacy.name || null}, ${lc(legacy.email) || null}, ${legacy.active !== false})
                   ON CONFLICT (username) DO NOTHING`;
        }
        const out = issue(legacy, row?.must_change);
        return out ? reply(200, out) : reply(500, { error: 'server not configured' });
      }

      // ── Username + password ──
      const username = lc(body.username);
      const password = String(body.password == null ? '' : body.password);
      if (!username || !password) return reply(400, { error: 'username and password required' });

      const [row] = await db`SELECT * FROM portal_users WHERE username = ${username}`;
      const legacy = (await loadUsers()).find(x => lc(x.username) === username);

      let ok = false, mustChange = false, identity = null;
      if (row && row.password_hash && verifyPassword(password, row.password_hash)) {
        if (row.active === false) return reply(403, { error: 'account disabled' });
        ok = true; mustChange = row.must_change;
        identity = { id: row.username, username: row.username, userType: row.user_type, district: row.district, name: row.name, email: row.email };
      } else if (legacy && legacy.active !== false && String(legacy.password || '') === password) {
        // Migration: legacy plaintext matched → lazily create a hashed row.
        ok = true; mustChange = false;
        identity = legacy;
        try {
          await db`INSERT INTO portal_users (username, password_hash, user_type, district, name, email, active)
                   VALUES (${username}, ${hashPassword(password)}, ${legacy.userType || null}, ${legacy.district ?? null}, ${legacy.name || null}, ${lc(legacy.email) || null}, true)
                   ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`;
        } catch { /* non-fatal: login still succeeds */ }
      }
      if (!ok) return reply(401, { error: 'invalid credentials' });

      const out = issue(identity, mustChange);
      return out ? reply(200, out) : reply(500, { error: 'server not configured' });
    }

    if (action === 'change-password') {
      const claims = requireUser(event);
      if (!claims) return reply(401, { error: 'unauthorized' });
      const oldPw = String(body.oldPassword == null ? '' : body.oldPassword);
      const newPw = String(body.newPassword == null ? '' : body.newPassword);
      if (newPw.length < 8) return reply(400, { error: 'new password must be at least 8 characters' });
      const username = lc(claims.username);
      const [row] = await db`SELECT * FROM portal_users WHERE username = ${username}`;
      const legacy = (await loadUsers()).find(x => lc(x.username) === username);
      const oldOk = (row && row.password_hash && verifyPassword(oldPw, row.password_hash))
                 || (legacy && String(legacy.password || '') === oldPw);
      if (!oldOk) return reply(401, { error: 'current password incorrect' });
      await db`INSERT INTO portal_users (username, password_hash, user_type, district, name, email, active, must_change, updated_at)
               VALUES (${username}, ${hashPassword(newPw)}, ${legacy?.userType || row?.user_type || null}, ${legacy?.district ?? row?.district ?? null}, ${legacy?.name || row?.name || null}, ${lc(legacy?.email) || row?.email || null}, true, false, now())
               ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, must_change = false, updated_at = now()`;
      return reply(200, { ok: true });
    }

    return reply(400, { error: 'unknown action' });
  } catch (e) {
    return reply(500, { error: 'server error' });
  }
};
