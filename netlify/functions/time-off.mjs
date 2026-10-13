// time-off.mjs — Time-Off Balances API (v21.84). Reads ONLY our own synced copy
// (time_off_people, filled by time-off-lib/sync.mjs) — never calls Paycor.
//
// Actions (POST { action, ... }), all require a valid portal session:
//   mine        — the caller's own balances (any role; empty when not linked)
//   users       — balances keyed by portal user id.
//                 exec/IT/office_staff: every user. DM: managers of stores in their own
//                 district, plus themselves. Everyone else: 403.
//   candidates  — exec/IT: Paycor people a user could be linked to (their store's legal
//                 entity for a manager, the office entity otherwise; `q` searches all).
//   link        — exec/IT: set/clear users.paycor_employee_id ({ userId, paycorEmployeeId|null }).
//                 Refuses an id already linked to another active account. Audit-logged.
//   status      — exec/IT: last sync run.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORES } from './tips-report-cron-background.mjs';
import { ensureTables, OFFICE_LE, legalEntityForStorePc } from './time-off-lib/sync.mjs';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ADMIN = new Set(['executive', 'it']);

function summarize(rows) {
  if (!rows.length) return { linked: true, balances: [], syncedAt: null };
  const balances = rows.flatMap(r => (Array.isArray(r.balances) ? r.balances : []));
  const syncedAt = rows.map(r => r.synced_at).sort().slice(-1)[0] || null;
  return { linked: true, balances, syncedAt };
}

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  let body = {};
  try { body = await request.json(); } catch { /* empty */ }
  const db = sql();
  const authed = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authed) return json(401, { error: 'unauthorized' });
  await ensureTables(db);
  const ut = authed.userType;
  const action = body.action;

  try {
    if (action === 'mine') {
      const me = (await db`SELECT paycor_employee_id FROM users WHERE id = ${authed.sub}`)[0];
      if (!me?.paycor_employee_id) return json(200, { linked: false, balances: [], syncedAt: null });
      const rows = await db`SELECT balances, synced_at FROM time_off_people WHERE paycor_employee_id = ${me.paycor_employee_id}`;
      return json(200, summarize(rows));
    }

    if (action === 'users') {
      let users;
      if (ADMIN.has(ut) || ut === 'office_staff') {
        users = await db`SELECT id, user_type, store_pc, paycor_employee_id FROM users WHERE active = true`;
      } else if (ut === 'dm') {
        const pcs = STORES.filter(s => String(s.district) === String(authed.district)).map(s => String(s.pc));
        users = await db`SELECT id, user_type, store_pc, paycor_employee_id FROM users
          WHERE active = true AND (id = ${authed.sub} OR (user_type = 'manager' AND store_pc = ANY(${pcs})))`;
      } else {
        return json(403, { error: 'forbidden' });
      }
      const ids = users.map(u => u.paycor_employee_id).filter(Boolean);
      const rows = ids.length ? await db`SELECT paycor_employee_id, balances, synced_at FROM time_off_people WHERE paycor_employee_id = ANY(${ids})` : [];
      const byEmp = {};
      for (const r of rows) (byEmp[r.paycor_employee_id] ||= []).push(r);
      const out = {};
      for (const u of users) {
        out[u.id] = u.paycor_employee_id ? summarize(byEmp[u.paycor_employee_id] || []) : { linked: false, balances: [], syncedAt: null };
      }
      return json(200, { users: out });
    }

    if (!ADMIN.has(ut)) return json(403, { error: 'forbidden' });

    if (action === 'candidates') {
      const q = String(body.q || '').trim().toLowerCase();
      let rows;
      if (q.length >= 2) {
        rows = await db`SELECT paycor_employee_id, legal_entity_id, employee_name, employee_number FROM time_off_people
          WHERE lower(employee_name) LIKE ${'%' + q + '%'} ORDER BY employee_name LIMIT 40`;
      } else {
        const u = (await db`SELECT user_type, store_pc FROM users WHERE id = ${body.userId}`)[0];
        if (!u) return json(404, { error: 'user not found' });
        const le = u.user_type === 'manager' ? legalEntityForStorePc(u.store_pc) : OFFICE_LE;
        rows = le ? await db`SELECT paycor_employee_id, legal_entity_id, employee_name, employee_number FROM time_off_people
          WHERE legal_entity_id = ${le} ORDER BY employee_name LIMIT 300` : [];
      }
      const taken = new Set((await db`SELECT paycor_employee_id FROM users WHERE active = true AND paycor_employee_id IS NOT NULL`).map(r => r.paycor_employee_id));
      const storeByLe = Object.fromEntries(STORES.map(s => [String(s.paycor), s.name]));
      return json(200, {
        candidates: rows.map(r => ({
          paycorEmployeeId: r.paycor_employee_id, name: r.employee_name, employeeNumber: r.employee_number,
          where: r.legal_entity_id === OFFICE_LE ? 'Office' : (storeByLe[r.legal_entity_id] || `Entity ${r.legal_entity_id}`),
          taken: taken.has(r.paycor_employee_id),
        })),
      });
    }

    if (action === 'link') {
      const userId = Number(body.userId);
      const empId = body.paycorEmployeeId ? String(body.paycorEmployeeId) : null;
      if (!userId) return json(400, { error: 'userId required' });
      if (empId) {
        const exists = await db`SELECT 1 FROM time_off_people WHERE paycor_employee_id = ${empId} LIMIT 1`;
        if (!exists.length) return json(400, { error: 'That Paycor employee is not in the synced list' });
        const clash = await db`SELECT id, name FROM users WHERE active = true AND paycor_employee_id = ${empId} AND id <> ${userId} LIMIT 1`;
        if (clash.length) return json(409, { error: `Already linked to ${clash[0].name}` });
      }
      await db`UPDATE users SET paycor_employee_id = ${empId}, updated_at = now() WHERE id = ${userId}`;
      try {
        await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata)
          VALUES ('admin', ${String(authed.username || authed.sub)}, ${ut}, 'time_off_link', ${JSON.stringify({ targetUserId: userId, paycorEmployeeId: empId })})`;
      } catch (e) { console.warn('[time-off] audit_log insert skipped:', e.message); }
      return json(200, { ok: true });
    }

    if (action === 'status') {
      const last = (await db`SELECT * FROM time_off_sync_runs ORDER BY id DESC LIMIT 1`)[0] || null;
      return json(200, { lastRun: last });
    }

    return json(400, { error: 'unknown action' });
  } catch (err) {
    console.error('[time-off] error:', err.message);
    return json(500, { error: 'Server error' });
  }
};
