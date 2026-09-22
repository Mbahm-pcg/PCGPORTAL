// manager-sync-title-diag.mjs — TEMPORARY, read-only, exec/IT-gated.
// Confirms real Paycor job titles across stores, to check whether the "contains manager, not
// assistant" rule actually matches reality (0/45 stores detected a match on the first live run
// — this checks whether that's because titles use a different convention than assumed).
// Reuses the exact same shared callPaycor token path already used everywhere else — no
// separate Paycor OAuth call. Remove once the title convention is confirmed.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { STORES, callPaycor } from './labor-cron.mjs';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, sql());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return json({ error: 'Exec/IT session required.' }, 403);
  }
  const url = new URL(request.url);

  // Reproduces the EXACT query runManagerSync uses, to check why a real, existing manager
  // account isn't being recognized as linked to its store.
  const checkStorePc = url.searchParams.get('checkStorePc');
  if (checkStorePc) {
    const db = sql();
    const rows = await db`SELECT id, name, store_pc, user_type, active, paycor_employee_id FROM users WHERE store_pc = ${checkStorePc}`;
    const allManagerRows = await db`SELECT id, name, store_pc, user_type, active, paycor_employee_id FROM users WHERE user_type = 'manager' AND active = true`;
    return json({
      checkStorePc,
      rowsWithThisStorePc: rows,
      matchedByRunManagerSyncQuery: allManagerRows.filter(r => String(r.store_pc) === checkStorePc),
    });
  }

  // rowsWithThisStorePc came back empty for Elkins Park (336372) — no row at all, active or
  // not, carries that store_pc. Search by name instead: does an account for this store's
  // known manager (per audits.mjs's separate hardcoded roster, mgr: 'Dilara Begum') exist
  // ANYWHERE in the table, under a different/blank store_pc?
  const nameSearch = url.searchParams.get('nameSearch');
  if (nameSearch) {
    const db = sql();
    const rows = await db`SELECT id, name, username, store_pc, user_type, active, paycor_employee_id FROM users WHERE name ILIKE ${'%' + nameSearch + '%'}`;
    return json({ nameSearch, rows });
  }

  // Confirmed root cause for Elkins Park: an active manager row (Dilara Begum) exists but
  // store_pc is null, so runManagerSync's linkedByPc grouping never indexes her under any
  // store — not a name-match miss, an unindexed account. Checking scope: is she the only
  // active manager missing a store_pc, or is this a wider gap across other stores too?
  const orphans = url.searchParams.get('orphanCheck');
  if (orphans) {
    const db = sql();
    const rows = await db`SELECT id, name, username, store_pc, paycor_employee_id FROM users WHERE user_type = 'manager' AND active = true AND store_pc IS NULL`;
    return json({ orphanedActiveManagers: rows });
  }

  const pcFilter = url.searchParams.get('pc');
  const limit = Number(url.searchParams.get('limit') || 5);
  const targets = pcFilter ? STORES.filter(s => s.pc === pcFilter) : STORES.slice(0, limit);
  const out = [];
  for (const store of targets) {
    try {
      const res = await callPaycor(`/legalentities/${store.paycor}/employees?include=All`);
      const records = res.data?.records || res.data || [];
      // No status filter here — deliberately show EVERY record's raw status/title fields,
      // so we can see exactly what the API returns vs. what the Active-only pipeline expects.
      const titles = records.map(e => ({
        name: `${e.firstName || ''} ${e.lastName || ''}`.trim(),
        jobTitle: e.jobTitle || null,
        positionData: e.positionData || null,
        status: e.statusData?.status || e.employeeStatus || e.status || null,
      }));
      out.push({ pc: store.pc, paycorId: store.paycor, name: store.name, status: res.status, totalRecords: records.length, titles });
    } catch (e) {
      out.push({ pc: store.pc, name: store.name, error: e.message });
    }
  }
  return json({ stores: out });
};
