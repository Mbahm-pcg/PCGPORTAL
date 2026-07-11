// portal-auth.mjs — server-side portal login. Verifies a credential (password or
// Google ID token) and issues a signed portal session token (kind:'portal', HMAC
// via DEAL_SESSION_SECRET). Passwords are stored scrypt-hashed in the Neon `users`
// table. On first login after migration a null password_hash falls back to the
// legacy plaintext in pcg_users_v1 — hash is written transparently on match.
// TODO Phase 6: remove loadUsers() blob fallback once all users have logged in.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';
import { signToken } from './deal-lib/token.js';
import { hashPassword, verifyPassword, validatePasswordComplexity, isSharedDevice } from './auth-lib/passwords.js';
import { requireUser, requireActiveUser } from './auth-lib/require-user.js';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const reply = (code, obj, extraHeaders) => new Response(JSON.stringify(obj), { status: code, headers: { ...cors, ...(extraHeaders || {}) } });
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());
const TTL = 43200; // 12 hours
const MAX_ATTEMPTS = 5; // failed logins before lockout (IT-admin unlock only)
const LOCKED_MSG = 'Account locked after too many failed attempts. Contact your IT administrator to unlock it.';

// Secure session cookie carrying the portal token: HttpOnly (no JS/XSS read),
// Secure (HTTPS only), SameSite=Lax (sent on same-origin navigation/fetch). The
// Authorization-header flow still works in parallel; this is defense-in-depth.
const sessionCookie = (token) => `pcg_session=${encodeURIComponent(token)}; Max-Age=${TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`;
const clearedCookie = () => `pcg_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

const GSI_CLIENT_ID = '450079580275-s9db563vj8npg93e15gdgrlkvcsu0n52.apps.googleusercontent.com';

// Idempotent column add — matches the codebase's self-managing-schema pattern (see
// users.mjs ensureAuditsColumn / audits.mjs ensureTables). Module-level once-flag so a
// warm lambda only issues the ALTER once. Belt-and-suspenders with those two: a fresh
// deploy could hit portal-auth first, and the user SELECTs below select audits_access.
// An ALTER failure must not break login — swallow it and let the SELECT surface the
// real problem (e.g. an unrelated DB outage) instead of masking it as a schema error.
let _auditsColumnEnsured = false;
async function ensureAuditsColumn(db) {
  if (_auditsColumnEnsured) return;
  try {
    await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS audits_access text`;
    _auditsColumnEnsured = true;
  } catch { /* best-effort — SELECT below will surface any real DB problem */ }
}

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

// Verify a GIS OAuth2 access token via Google's tokeninfo endpoint. Returns the
// verified lowercase email or null. Audience is checked against GSI_CLIENT_ID so a
// token minted for some other app can't log in here.
async function verifyGoogleAccess(accessToken) {
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (j.aud !== GSI_CLIENT_ID && j.azp !== GSI_CLIENT_ID) return null;
    if (j.email_verified !== 'true' && j.email_verified !== true) return null;
    return j.email ? lc(j.email) : null;
  } catch { return null; }
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
    auditsAccess: row.audits_access ?? row.auditsAccess ?? null,
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
    auditsAccess: claims.auditsAccess,
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
  await ensureAuditsColumn(db);

  const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };

  try {
    if (action === 'ping') return reply(200, { ok: true });

    if (action === 'me') {
      // Active-session check: rejects tokens revoked by sign-out-everywhere → the client
      // polls this and force-logs-out on 401 (this is what kicks a lost device out).
      const claims = await requireActiveUser(eventShim, db);
      return claims ? reply(200, { user: claims }) : reply(401, { error: 'unauthorized' });
    }

    if (action === 'logout') {
      // Clear the secure session cookie. (The Bearer token is cleared client-side.)
      return reply(200, { ok: true }, { 'Set-Cookie': clearedCookie() });
    }

    if (action === 'revoke-sessions') {
      // Sign out everywhere. Self by default; IT admins may target any user via targetUserId.
      const claims = await requireActiveUser(eventShim, db);
      if (!claims) return reply(401, { error: 'unauthorized' });
      const targetId = (claims.userType === 'it' && body.targetUserId != null) ? Number(body.targetUserId) : claims.sub;
      if (targetId == null || Number.isNaN(targetId)) return reply(400, { error: 'no target' });
      await db`UPDATE users SET sessions_valid_from = now(), updated_at = now() WHERE id = ${targetId}`;
      // Drop trusted devices too, so 2FA is re-prompted on the next login (best-effort).
      try {
        await fetch(new URL('/.netlify/functions/trusted-devices', request.url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'revoke', userId: String(targetId) }),
        });
      } catch { /* best-effort — session invalidation already done */ }
      return reply(200, { ok: true, targetUserId: targetId });
    }

    if (action === 'login') {
      // ── Google ──
      if (body.googleIdToken || body.googleAccessToken) {
        const email = body.googleIdToken ? await verifyGoogle(body.googleIdToken) : await verifyGoogleAccess(body.googleAccessToken);
        if (!email) return reply(401, { error: 'google verification failed' });

        // Look up user in Neon users table by email
        let [row] = await db`
          SELECT id, username, name, email, user_type, district, store_pc, active,
                 is_admin, region, initials, must_setup, dark_mode,
                 must_change, two_factor_required, two_factor_enabled, two_factor_secret,
                 audits_access
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
        return reply(200, out, { 'Set-Cookie': sessionCookie(out.token) });
      }

      // ── Username + password ──
      const username = lc(body.username);
      const password = String(body.password == null ? '' : body.password);
      if (!username || !password) return reply(400, { error: 'username and password required' });

      const [row] = await db`
        SELECT id, username, name, email, user_type, district, store_pc, active,
               is_admin, region, initials, must_setup, dark_mode,
               password_hash, must_change, two_factor_required, two_factor_enabled, two_factor_secret,
               failed_attempts, locked, audits_access
        FROM users WHERE username = ${username}
      `;

      // Shared devices (store tablets / kiosks) are exempt from the failed-attempt lockout.
      const exempt = isSharedDevice(row?.user_type);

      // Locked accounts are refused before any password check; only an IT admin can unlock.
      if (row && row.locked && !exempt) return reply(423, { error: LOCKED_MSG, locked: true });

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

      if (!ok) {
        // Count the failed attempt against a real, non-exempt account and lock at the
        // threshold. Unknown usernames and shared devices never accrue a lock.
        if (row && !exempt) {
          // Atomic increment so concurrent failed attempts can't lose-update the counter.
          const [bumped] = await db`
            UPDATE users SET failed_attempts = failed_attempts + 1, updated_at = now()
            WHERE id = ${row.id} RETURNING failed_attempts`;
          const attempts = bumped?.failed_attempts ?? ((row.failed_attempts || 0) + 1);
          if (attempts >= MAX_ATTEMPTS) {
            await db`UPDATE users SET locked = true WHERE id = ${row.id}`.catch(() => {});
            return reply(423, { error: LOCKED_MSG, locked: true });
          }
          return reply(401, { error: 'invalid credentials', attemptsRemaining: Math.max(0, MAX_ATTEMPTS - attempts) });
        }
        return reply(401, { error: 'invalid credentials' });
      }

      const out = issue(identity, mustChange);
      if (!out) return reply(500, { error: 'server not configured' });
      if (identity.two_factor_required && identity.two_factor_secret) {
        out.twoFactorSecret = identity.two_factor_secret;
      }
      // Successful login clears any accumulated failed attempts.
      if (identity?.id && (identity.failed_attempts || 0) > 0) {
        db`UPDATE users SET failed_attempts = 0, locked = false WHERE id = ${identity.id}`.catch(() => {});
      }
      db`UPDATE users SET last_login = now() WHERE username = ${username}`.catch(() => {});
      return reply(200, out, { 'Set-Cookie': sessionCookie(out.token) });
    }

    // Returns twoFactorSecret for Google-authenticated users who already have 2FA set up.
    // Requires a valid Google access token — verified live with Google userinfo endpoint.
    if (action === 'get-2fa-secret') {
      const { accessToken } = body;
      if (!accessToken) return reply(400, { error: 'accessToken required' });
      try {
        const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!gRes.ok) return reply(401, { error: 'invalid Google token' });
        const profile = await gRes.json();
        if (!profile.email_verified) return reply(401, { error: 'email not verified' });
        const email = lc(profile.email);
        const [row] = await db`
          SELECT two_factor_required, two_factor_enabled, two_factor_secret
          FROM users WHERE lower(email) = ${email} AND active = true LIMIT 1
        `;
        if (!row) return reply(404, { error: 'user not found' });
        return reply(200, {
          twoFactorRequired: row.two_factor_required || false,
          twoFactorEnabled:  row.two_factor_enabled  || false,
          twoFactorSecret:   row.two_factor_required ? (row.two_factor_secret || null) : null,
        });
      } catch (e) {
        return reply(500, { error: 'verification failed' });
      }
    }

    if (action === 'change-password') {
      const claims = await requireActiveUser(eventShim, db);
      if (!claims) return reply(401, { error: 'unauthorized' });
      const oldPw = String(body.oldPassword == null ? '' : body.oldPassword);
      const newPw = String(body.newPassword == null ? '' : body.newPassword);
      // Enforce the complexity policy for everyone except shared devices (store tablets/kiosks).
      if (!isSharedDevice(claims.userType)) {
        const v = validatePasswordComplexity(newPw);
        if (!v.ok) return reply(400, { error: v.message });
      }

      const username = lc(claims.username);
      const [row] = await db`SELECT id, password_hash, must_change, must_setup FROM users WHERE username = ${username}`;
      const legacy = (await loadUsers()).find(x => lc(x.username) === username);
      // On a FORCED first change (must_change/must_setup), the user already proved identity
      // by logging in with the provisioned password, so the old-password re-entry is skipped
      // — this lets first-login set a hashed password without ever holding plaintext client-side.
      const firstTime = !!(row && (row.must_change || row.must_setup));
      const oldOk = firstTime
                 || (row?.password_hash && verifyPassword(oldPw, row.password_hash))
                 || (legacy && String(legacy.password || '') === oldPw);
      if (!oldOk) return reply(401, { error: 'current password incorrect' });

      await db`
        UPDATE users SET password_hash = ${hashPassword(newPw)}, must_change = false, must_setup = false, updated_at = now()
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
