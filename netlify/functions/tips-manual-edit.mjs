// tips-manual-edit.mjs — exec/IT-only: manually correct one store's crew for
// one already-saved day, recalculating each person's share from the SAME
// pool/hours math the nightly cron already uses, no live Paycor call
// required. Built 2026-10-08 per explicit request: previously the only way
// to fix a day where someone's tips/hours never made it in (e.g. Mohammadi/
// 8200 missing from a day's crew) was to tell IT, who'd fetch/patch the
// snapshot by hand via a one-off script — this is that exact workflow,
// built into the app instead of living in someone's terminal history.
//
// Three actions:
//   get           { date, pc }                      -> { store }  (the one store's saved day entry)
//   employeeRoster{ legalEntityId }                  -> Paycor's employee list for that legal entity, name+id only
//   save          { date, pc, crew, reason? }        -> recalculates + persists; { ok, store }
//
// Deliberately NOT a background function — a single blob read + one Paycor
// call (roster lookup only, not a write) + a blob write are all well under
// the 26s manual-invocation budget.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { loadDaySnapshot, saveDaySnapshot, fetchAllEmployees } from './tips-report-cron-background.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const db = sql();
    const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
    // Exec/IT only (2026-10-08, explicit decision) — deliberately narrower
    // than canPaycorPush's own client-side gate (which also includes
    // office_staff for the SEND step) since manually overriding whose hours
    // feed a real tip distribution is a more sensitive action than sending
    // an already-computed period.
    if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
      return json(403, { error: 'forbidden' });
    }

    let payload;
    try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
    const { action } = payload || {};

    if (action === 'get') {
      const { date, pc } = payload;
      if (!date || !pc) return json(400, { error: 'Missing date or pc' });
      const dayResults = await loadDaySnapshot(date);
      if (!dayResults) return json(404, { error: `No saved tips snapshot for ${date} yet.` });
      const store = dayResults.find(s => String(s.pc) === String(pc));
      if (!store) return json(404, { error: 'Store not found in that day\'s snapshot.' });
      return json(200, { store });
    }

    if (action === 'employeeRoster') {
      const { legalEntityId } = payload;
      if (!legalEntityId) return json(400, { error: 'Missing legalEntityId' });
      try {
        // Reuses the exact same paginated, error-shape-safe fetch the nightly
        // cron itself uses (fetchAllEmployees) — not a hand-rolled second
        // copy of that pagination/error-detection logic.
        const records = await fetchAllEmployees(legalEntityId);
        const roster = records
          .filter(r => r.statusData?.status === 'Active')
          .map(r => ({
            guid: r.id || r.Id,
            payrollId: r.employeeNumber || r.alternateEmployeeNumber || null,
            name: `${r.firstName || r.FirstName || ''} ${r.lastName || r.LastName || ''}`.trim(),
            jobTitle: r.jobTitle || r.JobTitle || null,
          }))
          .filter(r => r.guid && r.name)
          .sort((a, b) => a.name.localeCompare(b.name));
        return json(200, { roster });
      } catch (err) {
        return json(502, { error: `Paycor roster lookup failed: ${err.message}` });
      }
    }

    if (action === 'save') {
      const { date, pc, crew, reason } = payload;
      if (!date || !pc) return json(400, { error: 'Missing date or pc' });
      if (!Array.isArray(crew)) return json(400, { error: 'crew must be an array' });
      for (const c of crew) {
        if (!c || typeof c.name !== 'string' || !c.name.trim()) return json(400, { error: 'Every crew row needs a name' });
        if (typeof c.hours !== 'number' || !Number.isFinite(c.hours) || c.hours < 0) return json(400, { error: `Invalid hours for ${c.name}` });
      }

      const dayResults = await loadDaySnapshot(date);
      if (!dayResults) return json(404, { error: `No saved tips snapshot for ${date} yet — nothing to correct.` });
      const idx = dayResults.findIndex(s => String(s.pc) === String(pc));
      if (idx === -1) return json(404, { error: 'Store not found in that day\'s snapshot.' });

      const store = dayResults[idx];
      const pool = round2(store.tipPool || 0);
      const totalHours = crew.reduce((sum, c) => sum + c.hours, 0);
      const rate = totalHours > 0 ? pool / totalHours : 0;
      const newCrew = crew.map(c => ({
        name: c.name.trim(),
        payrollId: c.payrollId || null,
        guid: c.guid || null,
        hours: c.hours,
        share: round2(rate * c.hours),
      }));

      dayResults[idx] = {
        ...store,
        crew: newCrew,
        // A manual save always produces a complete, intentional crew list —
        // 'ok' regardless of what crewStatus was before (even an 'error' day
        // can be manually corrected this way, same as re-fetching would).
        crewStatus: 'ok',
        // Audit trail — same spirit as every other manual-override action in
        // this app (Office Clock unlock, Minor Timecard resolve): who, when,
        // why. Never overwritten by the nightly cron (it only ever writes
        // fresh crewStatus/crew/rows/tipPool for THAT store from scratch —
        // confirmed by reading fetchStoreCrew — but the finalize-gate settle
        // pass's reconcile COULD still revisit this day/store later and
        // silently replace it from live Paycor data again; this field is
        // forensic record, not a lock).
        manualEdit: { by: authedUser.username, at: new Date().toISOString(), reason: reason || null },
      };

      await saveDaySnapshot(date, dayResults);
      return json(200, { ok: true, store: dayResults[idx] });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: err.message || 'Server error' });
  }
};
