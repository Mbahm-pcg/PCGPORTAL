// users.mjs — User management CRUD API.
// list action is public (no auth). All mutations require a valid portal token.
import { sql } from './_shared/db.mjs';
import { requireUser } from './auth-lib/require-user.js';
import { hashPassword, validatePasswordComplexity, isSharedDevice } from './auth-lib/passwords.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });
const lc = s => (s == null ? '' : String(s).trim().toLowerCase());

// Map a DB row (snake_case) to a client-safe object (camelCase). Never includes
// password_hash or two_factor_secret.
function toClient(row) {
  if (!row) return null;
  return {
    id:                 row.id,
    username:           row.username,
    name:               row.name,
    email:              row.email,
    phone:              row.phone,
    role:               row.role,
    userType:           row.user_type,
    district:           row.district,
    storePC:            row.store_pc,
    active:             row.active,
    darkMode:           row.dark_mode,
    avatarUrl:          row.avatar_url,
    googleId:           row.google_id,
    lastLogin:          row.last_login,
    createdAt:          row.created_at,
    initials:           row.initials,
    isAdmin:            row.is_admin,
    mustSetup:          row.must_setup,
    region:             row.region,
    twoFactorRequired:  row.two_factor_required,
    twoFactorEnabled:   row.two_factor_enabled,
    mustChange:         row.must_change,
    locked:             row.locked,
    failedAttempts:     row.failed_attempts,
  };
}

function isFullAdmin(claims) {
  return claims?.userType === 'executive' || claims?.userType === 'it';
}
function canManage(claims, targetUserType) {
  if (isFullAdmin(claims)) return true;
  if (claims?.userType === 'office_staff') return !['executive', 'it'].includes(targetUserType);
  return false;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const eventShim = { headers: { authorization: request.headers.get('authorization') || '', cookie: request.headers.get('cookie') || '' } };
  const claims = requireUser(eventShim); // null = unauthenticated (list is still allowed)

  const db = sql();
  const url = new URL(request.url);

  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { return reply(400, { error: 'invalid JSON' }); }
  }

  const action = request.method === 'GET'
    ? (url.searchParams.get('action') || 'list')
    : (body.action || 'list');

  try {
    // ── LIST — public, returns safe fields only (no password_hash, no two_factor_secret) ──
    if (action === 'list') {
      const rows = await db`
        SELECT id, username, name, email, phone, role, user_type, district, store_pc,
               active, dark_mode, avatar_url, google_id, last_login, created_at,
               initials, is_admin, must_setup, region,
               two_factor_required, two_factor_enabled, must_change, locked, failed_attempts
        FROM users ORDER BY id
      `;
      return reply(200, rows.map(toClient));
    }

    // All mutations require auth
    if (!claims) return reply(401, { error: 'unauthorized' });

    // ── CREATE ──────────────────────────────────────────────────────────────────
    if (action === 'create') {
      if (!canManage(claims, null)) return reply(403, { error: 'forbidden' });
      const u = body.user || {};
      if (!u.username || !u.name || !u.userType) return reply(400, { error: 'username, name, userType required' });
      if (!canManage(claims, u.userType)) return reply(403, { error: 'cannot create users of this role' });

      const username = lc(u.username);
      // Enforce password complexity on create — except for shared devices (store tablets/kiosks).
      if (u.password && !isSharedDevice(u.userType)) {
        const v = validatePasswordComplexity(String(u.password));
        if (!v.ok) return reply(400, { error: v.message });
      }
      const passwordHash = u.password ? hashPassword(String(u.password)) : null;
      // Store tablets are shared-device logins with a fixed password that stays
      // logged in — never force first-login setup or a password change on them.
      const forceSetup = u.userType !== 'store_tablet';

      const [row] = await db`
        INSERT INTO users (
          username, name, email, phone, role, user_type, district, store_pc,
          active, dark_mode, initials, is_admin, must_setup, region,
          password_hash, must_change, two_factor_required, created_at, updated_at
        ) VALUES (
          ${username}, ${u.name}, ${lc(u.email) || null}, ${u.phone || null},
          ${u.role || null}, ${u.userType}, ${u.district ?? null},
          ${u.storePC ? String(u.storePC) : null},
          ${u.active !== false}, ${u.darkMode || false},
          ${u.initials || null}, ${u.isAdmin || false}, ${forceSetup},
          ${u.region || 'PA'}, ${passwordHash}, ${forceSetup},
          ${u.twoFactorRequired || false}, now(), now()
        )
        ON CONFLICT (username) DO NOTHING
        RETURNING id
      `;
      if (!row) return reply(409, { error: 'username already exists' });

      const [created] = await db`
        SELECT id, username, name, email, phone, role, user_type, district, store_pc,
               active, dark_mode, avatar_url, google_id, last_login, created_at,
               initials, is_admin, must_setup, region,
               two_factor_required, two_factor_enabled, must_change, locked, failed_attempts
        FROM users WHERE id = ${row.id}
      `;
      return reply(201, { user: toClient(created) });
    }

    // ── UPDATE ──────────────────────────────────────────────────────────────────
    if (action === 'update') {
      const { id, patch } = body;
      if (!id || !patch) return reply(400, { error: 'id and patch required' });

      const [target] = await db`SELECT id, user_type FROM users WHERE id = ${id}`;
      if (!target) return reply(404, { error: 'user not found' });
      if (!canManage(claims, target.user_type)) return reply(403, { error: 'forbidden' });
      if (patch.userType && !canManage(claims, patch.userType)) return reply(403, { error: 'cannot assign this role' });

      // Hash and apply password change separately. Complexity is enforced unless the
      // user is (or is becoming) a shared device (store tablet/kiosk).
      if (patch.password) {
        const effType = patch.userType || target.user_type;
        if (!isSharedDevice(effType)) {
          const v = validatePasswordComplexity(String(patch.password));
          if (!v.ok) return reply(400, { error: v.message });
        }
        await db`UPDATE users SET password_hash = ${hashPassword(String(patch.password))}, must_change = true, updated_at = now() WHERE id = ${id}`;
      }

      await db`
        UPDATE users SET
          name                = COALESCE(${patch.name ?? null}, name),
          email               = COALESCE(${patch.email != null ? lc(patch.email) : null}, email),
          phone               = COALESCE(${patch.phone ?? null}, phone),
          role                = COALESCE(${patch.role ?? null}, role),
          user_type           = COALESCE(${patch.userType ?? null}, user_type),
          district            = COALESCE(${patch.district ?? null}, district),
          store_pc            = COALESCE(${patch.storePC != null ? String(patch.storePC) : null}, store_pc),
          active              = COALESCE(${patch.active ?? null}, active),
          dark_mode           = COALESCE(${patch.darkMode ?? null}, dark_mode),
          initials            = COALESCE(${patch.initials ?? null}, initials),
          is_admin            = COALESCE(${patch.isAdmin ?? null}, is_admin),
          must_setup          = COALESCE(${patch.mustSetup ?? null}, must_setup),
          region              = COALESCE(${patch.region ?? null}, region),
          two_factor_required = COALESCE(${patch.twoFactorRequired ?? null}, two_factor_required),
          updated_at          = now()
        WHERE id = ${id}
      `;

      const [updated] = await db`
        SELECT id, username, name, email, phone, role, user_type, district, store_pc,
               active, dark_mode, avatar_url, google_id, last_login, created_at,
               initials, is_admin, must_setup, region,
               two_factor_required, two_factor_enabled, must_change, locked, failed_attempts
        FROM users WHERE id = ${id}
      `;
      return reply(200, { user: toClient(updated) });
    }

    // ── TOGGLE ACTIVE ───────────────────────────────────────────────────────────
    if (action === 'toggle-active') {
      const { id } = body;
      if (!id) return reply(400, { error: 'id required' });
      const [target] = await db`SELECT id, user_type, active FROM users WHERE id = ${id}`;
      if (!target) return reply(404, { error: 'user not found' });
      if (!canManage(claims, target.user_type)) return reply(403, { error: 'forbidden' });
      await db`UPDATE users SET active = ${!target.active}, updated_at = now() WHERE id = ${id}`;
      const [updated] = await db`
        SELECT id, username, name, email, phone, role, user_type, district, store_pc,
               active, dark_mode, avatar_url, google_id, last_login, created_at,
               initials, is_admin, must_setup, region,
               two_factor_required, two_factor_enabled, must_change, locked, failed_attempts
        FROM users WHERE id = ${id}
      `;
      return reply(200, { user: toClient(updated) });
    }

    // ── UNLOCK — clear a failed-attempt lockout. IT admin ONLY (per policy). ──────
    if (action === 'unlock') {
      if (claims.userType !== 'it') return reply(403, { error: 'only IT admins can unlock accounts' });
      const { id } = body;
      if (!id) return reply(400, { error: 'id required' });
      const [target] = await db`SELECT id FROM users WHERE id = ${id}`;
      if (!target) return reply(404, { error: 'user not found' });
      await db`UPDATE users SET locked = false, failed_attempts = 0, updated_at = now() WHERE id = ${id}`;
      const [updated] = await db`
        SELECT id, username, name, email, phone, role, user_type, district, store_pc,
               active, dark_mode, avatar_url, google_id, last_login, created_at,
               initials, is_admin, must_setup, region,
               two_factor_required, two_factor_enabled, must_change, locked, failed_attempts
        FROM users WHERE id = ${id}
      `;
      return reply(200, { user: toClient(updated) });
    }

    // ── DELETE ──────────────────────────────────────────────────────────────────
    if (action === 'delete') {
      if (!isFullAdmin(claims)) return reply(403, { error: 'only admins can delete users' });
      const { id } = body;
      if (!id) return reply(400, { error: 'id required' });
      const [target] = await db`SELECT id, user_type FROM users WHERE id = ${id}`;
      if (!target) return reply(404, { error: 'user not found' });
      if (!canManage(claims, target.user_type)) return reply(403, { error: 'forbidden' });
      // Null out nullable FK references before hard delete (best-effort — ignore if columns don't exist)
      await db`UPDATE tickets SET assigned_to = NULL WHERE assigned_to = ${id}`.catch(() => {});
      await db`UPDATE notifications SET recipient_id = NULL WHERE recipient_id = ${id}`.catch(() => {});
      await db`DELETE FROM users WHERE id = ${id}`;
      return reply(200, { ok: true });
    }

    return reply(400, { error: `unknown action: ${action}` });

  } catch (e) {
    console.error('users.mjs error:', e);
    return reply(500, { error: 'server error' });
  }
};
