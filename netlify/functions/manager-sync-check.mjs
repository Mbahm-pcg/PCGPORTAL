// manager-sync-check.mjs — TEMPORARY, read-only, exec/IT-gated.
// Urgent post-deploy check (2026-09-25): the newly-live full-auto manager-sync feature ran
// against real data before 4-6 suspected name-order/nickname duplicate cases could be
// manually corrected. Checks the real current state of every account tied to those stores.
// Remove once confirmed/resolved.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const WATCH_PCS = ['304669', '332941', '335981', '345489', '351050', '352894', '353150', '353689', '354865', '365953'];

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return json({ error: 'Exec/IT session required.' }, 403);
  }
  const db = sql();
  const rows = await db`
    SELECT id, name, username, store_pc, active, paycor_employee_id, created_at, updated_at
    FROM users
    WHERE store_pc = ANY(${WATCH_PCS})
    ORDER BY store_pc, created_at
  `;
  const byPc = {};
  for (const r of rows) (byPc[r.store_pc] ||= []).push(r);
  return json({ byPc });
};
