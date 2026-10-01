// office-clock-roster.mjs — Office Hourly Time Clock, Task 4: roster +
// account-linking lookup (exec/IT only).
//
// Lets an IT/exec admin see which office/corporate Paycor employees (one
// legal entity — office/corporate, distinct from the 45 store legal entities
// in tips-report-cron-background.mjs's STORES) can be linked to an existing
// `office_staff` Portal account. This endpoint never creates an account — it
// only reports the match so a later admin UI (Task 3's paycor_employee_id /
// paycor_department_id fields) can be filled in by hand.
//
// Single action (`linkable`) — kept deliberately small and single-purpose,
// same shape as no-clockin.mjs.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { fetchAllEmployees } from './tips-report-cron-background.mjs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

// Same match-by-name approach already established elsewhere in this codebase
// (fleet-alerts-cron.mjs's `normName`) for matching Paycor-sourced people data
// against existing Portal users by name — lowercase + strip everything but
// letters, so "O'Brien, Jane" / "Jane O'Brien" / extra whitespace all collapse
// to the same key. Needed because Paycor employee IDs differ across Paycor
// endpoints/imports (CLAUDE.md gotcha #4) and an office_staff account may not
// have a paycor_employee_id linked yet at all.
const normName = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  // Auth-gated exec/it only, before touching payload/Paycor — same shape as
  // paycor.mjs's createPunches check (and no-clockin.mjs's whole-handler gate).
  const db = sql();
  const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403, headers });
  }

  let payload;
  try {
    payload = await request.json().catch(() => ({}));
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers });
  }

  const { action } = payload;

  try {
    if (action === 'linkable') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return new Response(JSON.stringify({ error: 'Missing legalEntityId' }), { status: 400, headers });

      const [allEmployees, officeUsers] = await Promise.all([
        fetchAllEmployees(legalEntityId),
        db`SELECT id, name, paycor_employee_id, paycor_department_id FROM users WHERE user_type = 'office_staff'`,
      ]);

      const activeEmployees = allEmployees.filter(e => e?.statusData?.status === 'Active');

      // Index office_staff users both ways so each Paycor employee can be
      // matched by whichever is available: an already-linked account first
      // (paycor_employee_id, the stable identifier once set), falling back to
      // name for accounts that have never been linked yet.
      const byPaycorId = new Map();
      const byName = new Map();
      for (const u of officeUsers) {
        if (u.paycor_employee_id) byPaycorId.set(String(u.paycor_employee_id), u);
        const key = normName(u.name);
        if (key && !byName.has(key)) byName.set(key, u); // first match wins on a name collision
      }

      const employees = activeEmployees.map(e => {
        const name = `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim();
        const matched = byPaycorId.get(String(e.id)) || byName.get(normName(name)) || null;
        return {
          paycorEmployeeId: e.id,
          name,
          jobTitle: e.positionData?.jobTitle || '',
          departmentId: e.department?.id || null,
          isHourly: e.statusData?.flsa === 'HourlyNonExempt',
          // No match at all still gets a row (linkedUserId: null) so IT can see
          // "this Paycor employee has no office_staff Portal account yet"
          // rather than it silently disappearing from the list.
          linkedUserId: matched ? matched.id : null,
          alreadyLinked: !!(matched && matched.paycor_employee_id && matched.paycor_department_id),
        };
      });

      return new Response(JSON.stringify({ employees }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
