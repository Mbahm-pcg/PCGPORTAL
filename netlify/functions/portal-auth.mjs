// portal-auth.mjs — server-side portal login. Verifies a credential (password or
// Google ID token) and issues a signed portal session token (kind:'portal', HMAC
// via DEAL_SESSION_SECRET). Passwords are stored scrypt-hashed in the Neon `users`
// table. On first login after migration a null password_hash falls back to the
// legacy plaintext in pcg_users_v1 — hash is written transparently on match.
// TODO Phase 6: remove loadUsers() blob fallback once all users have logged in.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { signToken } from './deal-lib/token.js';
import { hashPassword, verifyPassword } from './auth-lib/passwords.js';
import { requireUser } from './auth-lib/require-user.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const TTL = 43200; // 12 hours

const GSI_CLIENT_ID = '450079580275-s9db563vj8npg93e15gdgrlkvcsu0n52.apps.googleusercontent.com';

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

// Fallback: load users from legacy blob for users not yet migrated (password_hash IS NULL)
async function loadUsers() {
  try {
    const w = await blobStore().get('pcg_users_v1', { type: 'json' });
    const d = w?.data || w;
    return Array.isArray(d) ? d : (d?.users || []);
  } catch { return []; }
}

async function verifyGoogle(idToken) {
  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client(GSI_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: GSI_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email_verified) return null;
  return lc(p.email);
}

// Build the signed token + safe user object from a resolved DB row.
function issue(row, mustChange) {
  const secret = process.env.DEAL_SESSION_SECRET;
  if (!secret) return null;
  const claims = {
    kind: 'portal',
    sub: row.id ?? null,
    username: lc(row.username),
    userType: row.user_type || row.userType || null,
    district: row.district ?? null,
    name: row.name || null,
    isAdmin: row.is_admin || row.isAdmin || false,
    storePC: row.store_pc || row.storePC || null,
    region: row.region || null,
  };
  const token = signToken(claims, secret, { ttlSeconds: TTL });
  const user = {
    id: row.id ?? null,
    username: claims.username,
    userType: claims.userType,
    district: claims.district,
    name: claims.name,
    email: lc(row.email) || null,
    isAdmin: claims.isAdmin,
    storePC: claims.storePC,
    region: claims.region,
    twoFactorRequired: row.two_factor_required || row.twoFactorRequired || false,
    twoFactorEnabled: row.two_factor_enabled || row.twoFactorEnabled || false,
    mustSetup: row.must_setup || row.mustSetup || false,
    darkMode: row.dark_mode || row.darkMode || false,
    initials: row.initials || null,
  };
  return { token, user, mustChange: !!mustChange, expiresIn: TTL };
}

export default async (request, context) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return reply(405, { error: 'POST only' });
  if (!process.env.DEAL_SESSION_SECRET) return reply(500, { error: 'server not configured' });

  let body;
  try { body = await request.json().catch(() => ({})); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action || 'login';
  const db = sql();

  const eventShim = { headers: { authorization: request.headers.get('authorization') || '' } };

  try {
    if (action === 'ping') return reply(200, { ok: true });

    if (action === 'me') {
      const claims = requireUser(eventShim);
      return claims ? reply(200, { user: claims }) : reply(401, { error: 'unauthorized' });
    }

    if (action === 'login') {
      // ── Google ──
      if (body.googleIdToken) {
        const email = await verifyGoogle(body.googleIdToken);
        if (!email) return reply(401, { error: 'google verification failed' });

        // Look up user in Neon users table by email
        let [row] = await db`
          SELECT id, username, name, email, user_type, district, store_pc, active,
                 is_admin, region, initials, must_setup, dark_mode,
                 must_change, two_factor_required, two_factor_enabled, two_factor_secret
          FROM users WHERE lower(email) = ${email} AND active = true LIMIT 1
        `;

        // Fallback: check legacy blob if not in users table yet
        if (!row) {
          const legacy = (await loadUsers()).find(x => lc(x.email) === email);
          if (!legacy || legacy.active === false) return reply(403, { error: 'no account for this Google email' });
          // Insert minimal row so next login hits the DB directly
          await db`
            INSERT INTO users (username, name, email, user_type, district, active, updated_at)
            VALUES (${lc(legacy.username)}, ${legacy.name || ''}, ${email}, ${legacy.userType || 'manager'},
                   ${legacy.district ?? null}, true, now())
            ON CONFLICT (username) DO UPDATE SET email = EXCLUDED.email, updated_at = now()
          `;
          [row] = await db`SELECT * FROM users WHERE lower(email) = ${email} LIMIT 1`;
          if (!row) return reply(500, { error: 'failed to create user record' });
        }

        const out = issue(row, row.must_change);
        if (!out) return reply(500, { error: 'server not configured' });
        // Include twoFactorSecret transiently so the client can run the TOTP prompt
        if (row.two_factor_required && row.two_factor_secret) {
          out.twoFactorSecret = row.two_factor_secret;
        }
        // Update last_login
        db`UPDATE users SET last_login = now() WHERE id = ${row.id}`.catch(() => {});
        return reply(200, out);
      }

      // ── Username + password ──
      const username = lc(body.username);
      const password = String(body.password == null ? '' : body.password);
      if (!username || !password) return reply(400, { error: 'username and password required' });

      const [row] = await db`
        SELECT id, username, name, email, user_type, district, store_pc, active,
               is_admin, region, initials, must_setup, dark_mode,
               password_hash, must_change, two_factor_required, two_factor_enabled, two_factor_secret
        FROM users WHERE username = ${username}
      `;

      let ok = false, mustChange = false, identity = null;

      if (row && row.password_hash && verifyPassword(password, row.password_hash)) {
        if (row.active === false) return reply(403, { error: 'account disabled' });
        ok = true;
        mustChange = row.must_change;
        identity = row;
      } else if (!row?.password_hash) {
        // Migration fallback: user exists in DB but hash not yet set — check legacy blob
        const legacy = (await loadUsers()).find(x => lc(x.username) === username);
        if (legacy && legacy.active !== false && String(legacy.password || '') === password) {
          ok = true;
          mustChange = false;
          identity = row || legacy;
          // Lazily write the hash to users table
          const hash = hashPassword(password);
          db`UPDATE users SET password_hash = ${hash}, must_change = false, updated_at = now()
             WHERE username = ${username}`.catch(() => {});
          // Also upsert if row doesn't exist yet
          if (!row) {
            db`INSERT INTO users (username, name, email, user_type, district, active, password_hash, updated_at)
               VALUES (${username}, ${legacy.name || ''}, ${lc(legacy.email) || null},
                       ${legacy.userType || 'manager'}, ${legacy.district ?? null}, true, ${hash}, now())
               ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()
              `.catch(() => {});
          }
        }
      }

      if (!ok) return reply(401, { error: 'invalid credentials' });

      const out = issue(identity, mustChange);
      if (!out) return reply(500, { error: 'server not configured' });
      if (identity.two_factor_required && identity.two_factor_secret) {
        out.twoFactorSecret = identity.two_factor_secret;
      }
      db`UPDATE users SET last_login = now() WHERE username = ${username}`.catch(() => {});
      return reply(200, out);
    }

    if (action === 'change-password') {
      const claims = requireUser(eventShim);
      if (!claims) return reply(401, { error: 'unauthorized' });
      const oldPw = String(body.oldPassword == null ? '' : body.oldPassword);
      const newPw = String(body.newPassword == null ? '' : body.newPassword);
      if (newPw.length < 8) return reply(400, { error: 'new password must be at least 8 characters' });

      const username = lc(claims.username);
      const [row] = await db`SELECT id, password_hash FROM users WHERE username = ${username}`;
      const legacy = (await loadUsers()).find(x => lc(x.username) === username);
      const oldOk = (row?.password_hash && verifyPassword(oldPw, row.password_hash))
                 || (legacy && String(legacy.password || '') === oldPw);
      if (!oldOk) return reply(401, { error: 'current password incorrect' });

      await db`
        UPDATE users SET password_hash = ${hashPassword(newPw)}, must_change = false, updated_at = now()
        WHERE username = ${username}
      `;
      return reply(200, { ok: true });
    }

    return reply(400, { error: 'unknown action' });
  } catch (e) {
    console.error('portal-auth error:', e);
    return reply(500, { error: 'server error' });
  }
};
