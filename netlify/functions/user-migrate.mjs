// user-migrate.mjs — one-shot migration: pcg_users_v1 blob + portal_users → users table.
// Protected by x-migration-secret header. Run once, then leave in place until Phase 6 cleanup.
import { getStore } from '@netlify/blobs';
import { sql } from './_shared/db.mjs';

const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
const reply = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: cors });
const lc = s => (s == null ? '' : String(s).trim().toLowerCase());

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const secret = request.headers.get('x-migration-secret');
  if (!secret || secret !== process.env.MIGRATION_SECRET) return reply(401, { error: 'unauthorized' });

  const db = sql();

  try {
    // Load blob users
    const blob = await blobStore().get('pcg_users_v1', { type: 'json' }).catch(() => null);
    const blobData = blob?.data ?? blob;
    const blobUsers = Array.isArray(blobData) ? blobData : (blobData?.users ?? []);

    if (blobUsers.length === 0) return reply(400, { error: 'No users found in pcg_users_v1 blob' });

    // Pull existing scrypt hashes from portal_users (only field worth keeping from there)
    let portalRows = [];
    try { portalRows = await db`SELECT username, password_hash FROM portal_users`; } catch { /* table may not exist */ }
    const hashMap = new Map(portalRows.map(r => [lc(r.username), r.password_hash]));

    const migrated = [], failed = [];

    for (const u of blobUsers) {
      if (!u.username || !u.name) { failed.push({ username: u.username, reason: 'missing username or name' }); continue; }
      const username = lc(u.username);
      const passwordHash = hashMap.get(username) || null;

      try {
        const [row] = await db`
          INSERT INTO users (
            id, username, name, email, phone, role, user_type, district, store_pc,
            active, dark_mode, initials, is_admin, must_setup, region,
            password_hash, must_change,
            two_factor_required, two_factor_secret, two_factor_enabled,
            google_id, created_at, updated_at
          ) VALUES (
            ${u.id},
            ${username},
            ${u.name},
            ${lc(u.email) || null},
            ${u.phone || null},
            ${u.role || null},
            ${u.userType || 'manager'},
            ${u.district ?? null},
            ${u.storePC ? String(u.storePC) : null},
            ${u.active !== false},
            ${u.darkMode || false},
            ${u.initials || null},
            ${u.isAdmin || false},
            ${u.mustSetup || false},
            ${u.region || 'PA'},
            ${passwordHash},
            ${passwordHash ? false : true},
            ${u.twoFactorRequired || false},
            ${u.twoFactorSecret || null},
            ${u.twoFactorEnabled || false},
            ${u.googleId || null},
            now(), now()
          )
          ON CONFLICT (id) DO UPDATE SET
            username            = EXCLUDED.username,
            name                = EXCLUDED.name,
            email               = COALESCE(EXCLUDED.email, users.email),
            phone               = COALESCE(EXCLUDED.phone, users.phone),
            role                = COALESCE(EXCLUDED.role, users.role),
            user_type           = EXCLUDED.user_type,
            district            = EXCLUDED.district,
            store_pc            = EXCLUDED.store_pc,
            active              = EXCLUDED.active,
            dark_mode           = EXCLUDED.dark_mode,
            initials            = COALESCE(EXCLUDED.initials, users.initials),
            is_admin            = EXCLUDED.is_admin,
            must_setup          = EXCLUDED.must_setup,
            region              = COALESCE(EXCLUDED.region, users.region),
            password_hash       = COALESCE(EXCLUDED.password_hash, users.password_hash),
            must_change         = CASE
                                    WHEN EXCLUDED.password_hash IS NOT NULL THEN false
                                    WHEN users.password_hash IS NULL THEN true
                                    ELSE users.must_change
                                  END,
            two_factor_required = EXCLUDED.two_factor_required,
            two_factor_secret   = COALESCE(users.two_factor_secret, EXCLUDED.two_factor_secret),
            two_factor_enabled  = EXCLUDED.two_factor_enabled,
            updated_at          = now()
          RETURNING id, username, user_type
        `;
        migrated.push(row);
      } catch (e) {
        console.error(`Failed to migrate user ${username}:`, e.message);
        failed.push({ username, reason: e.message });
      }
    }

    // Reset SERIAL sequence so future INSERTs don't collide with manually-inserted IDs
    await db`SELECT setval('users_id_seq', (SELECT MAX(id) FROM users))`;

    return reply(200, {
      ok: true,
      migrated: migrated.length,
      failed: failed.length,
      total: blobUsers.length,
      users: migrated,
      ...(failed.length > 0 ? { errors: failed } : {}),
    });
  } catch (e) {
    console.error('Migration error:', e);
    return reply(500, { error: e.message });
  }
};
