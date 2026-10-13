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
import { loadDaySnapshot, saveDaySnapshot, fetchAllEmployees, callPaycorProxy, punchHours } from './tips-report-cron-background.mjs';

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

    // ── Several-days mode (v21.89) ───────────────────────────────────────────
    // rangePreview { pc, legalEntityId, guid, name, startDate, endDate }
    //   -> per day: whether a snapshot exists, the store's pool, this person's
    //      current crew hours (null = not in that day's crew), and their real
    //      Paycor punched hours for that day (null if the lookup failed).
    //      Punches are fetched ONE DAY PER CALL (startDate = endDate), exactly
    //      like fetchStoreCrew, so the hours match what the nightly report
    //      would have counted for that business date.
    // bulkSave { pc, person: { name, guid, payrollId }, entries: [{ date, hours }], reason? }
    //   -> for each date: put this person in that day's crew with `hours`
    //      (0 removes them), recalc every share from the day's pool with the
    //      same math as `save`, stamp manualEdit. Days without a snapshot are
    //      skipped and reported, never created.
    if (action === 'rangePreview' || action === 'bulkSave') {
      const MAX_DAYS = 31;
      const daysBetween = (a, b) => {
        const out = [];
        const d = new Date(`${a}T12:00:00Z`), end = new Date(`${b}T12:00:00Z`);
        while (d <= end && out.length <= MAX_DAYS) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
        return out;
      };
      const matchRow = (c, person) => (person.guid && c.guid && c.guid === person.guid)
        || (!person.guid || !c.guid) && c.name && person.name && c.name.trim().toLowerCase() === person.name.trim().toLowerCase();

      if (action === 'rangePreview') {
        const { pc, legalEntityId, guid, name, startDate, endDate } = payload;
        if (!pc || !startDate || !endDate || !(guid || name)) return json(400, { error: 'Missing pc, person, or date range' });
        const dates = daysBetween(startDate, endDate);
        if (!dates.length) return json(400, { error: 'End date must be on or after start date' });
        if (dates.length > MAX_DAYS) return json(400, { error: `Pick ${MAX_DAYS} days or fewer` });
        const person = { guid: guid || null, name: name || '' };

        const snapshots = await Promise.all(dates.map(d => loadDaySnapshot(d).catch(() => null)));
        // Punched hours: small pool so a 31-day range stays well inside 26s.
        const punched = {};
        if (legalEntityId && guid) {
          let i = 0;
          const worker = async () => {
            while (i < dates.length) {
              const d = dates[i++];
              try {
                const raw = await callPaycorProxy('punches', { legalEntityId, startDate: d, endDate: d });
                const body = JSON.parse(raw || '{}');
                const recs = Array.isArray(body.records) ? body.records : (Array.isArray(body) ? body : null);
                if (!recs) { punched[d] = null; continue; }
                punched[d] = round2(recs.filter(p => p.employeeId === guid).reduce((s, p) => s + punchHours(p), 0));
              } catch { punched[d] = null; }
            }
          };
          await Promise.all(Array.from({ length: Math.min(6, dates.length) }, worker));
        }
        const days = dates.map((d, k) => {
          const store = (snapshots[k] || []).find(s => String(s.pc) === String(pc)) || null;
          const row = store ? (store.crew || []).find(c => matchRow(c, person)) : null;
          return {
            date: d,
            hasSnapshot: !!store,
            tipPool: store ? round2(store.tipPool || 0) : null,
            crewSize: store ? (store.crew || []).length : null,
            currentHours: row ? row.hours : null,
            currentShare: row ? row.share : null,
            punchedHours: guid && legalEntityId ? (punched[d] ?? null) : null,
            manualEdit: store?.manualEdit || null,
          };
        });
        return json(200, { days });
      }

      // bulkSave
      const { pc, person, entries, reason } = payload;
      if (!pc || !person || typeof person.name !== 'string' || !person.name.trim()) return json(400, { error: 'Missing pc or person' });
      if (!Array.isArray(entries) || !entries.length) return json(400, { error: 'No days selected' });
      if (entries.length > MAX_DAYS) return json(400, { error: `Pick ${MAX_DAYS} days or fewer` });
      for (const e of entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e?.date || ''))) return json(400, { error: 'Bad date in selection' });
        if (typeof e.hours !== 'number' || !Number.isFinite(e.hours) || e.hours < 0 || e.hours > 24) return json(400, { error: `Invalid hours for ${e.date}` });
      }
      const p = { name: person.name.trim(), guid: person.guid || null, payrollId: person.payrollId || null };
      const results = [];
      for (const e of entries) {
        const dayResults = await loadDaySnapshot(e.date);
        const idx = dayResults ? dayResults.findIndex(s => String(s.pc) === String(pc)) : -1;
        if (idx === -1) { results.push({ date: e.date, ok: false, reason: 'No saved tips snapshot for this day' }); continue; }
        const store = dayResults[idx];
        const others = (store.crew || []).filter(c => !matchRow(c, p)).map(c => ({ name: c.name, payrollId: c.payrollId || null, guid: c.guid || null, hours: Number(c.hours) || 0 }));
        const crew = e.hours > 0 ? [...others, { ...p, hours: e.hours }] : others;
        const pool = round2(store.tipPool || 0);
        const totalHours = crew.reduce((s, c) => s + c.hours, 0);
        const rate = totalHours > 0 ? pool / totalHours : 0;
        dayResults[idx] = {
          ...store,
          crew: crew.map(c => ({ ...c, share: round2(rate * c.hours) })),
          crewStatus: 'ok',
          manualEdit: { by: authedUser.username, at: new Date().toISOString(), reason: reason || `Bulk edit: ${p.name}` },
        };
        await saveDaySnapshot(e.date, dayResults);
        const mine = dayResults[idx].crew.find(c => matchRow(c, p));
        results.push({ date: e.date, ok: true, hours: e.hours, share: mine ? mine.share : 0 });
      }
      return json(200, { ok: results.every(r => r.ok), results });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: err.message || 'Server error' });
  }
};
