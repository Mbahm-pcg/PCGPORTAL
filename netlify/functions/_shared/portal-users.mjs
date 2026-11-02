// _shared/portal-users.mjs — the live portal user list, for server jobs that pick email
// recipients by role (v22.41). Reads the Neon `users` table, which has been the source of
// truth since v16.38 — NOT the retired `pcg_users_v1` blob, which froze in June 2026 and
// holds stale managers/DMs (people moved, promoted or hired since aren't in it).
//
// Returns the same shape the old blob had ({ id, name, email, userType, district, storePC,
// active }) so existing recipient logic works unchanged. Throws on a DB error — callers
// must NOT fall back to the stale blob; skipping a run is safer than emailing the wrong
// person.
import { sql } from './db.mjs';

export async function loadPortalUsers() {
  const rows = await sql()`SELECT id, name, email, user_type, district, store_pc, active FROM users`;
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    email: r.email || null,
    userType: r.user_type,
    district: r.district,
    storePC: r.store_pc,
    active: r.active !== false,
  }));
}
