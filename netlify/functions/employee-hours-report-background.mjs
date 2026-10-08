// employee-hours-report-background.mjs — exec/IT/office_staff: "how many
// hours did everyone at store X work between date A and date B" — an
// arbitrary-range historical audit report, built 2026-10-08 per explicit
// request (office staff need month-to-month hours by store, broken into
// weekly columns, exportable).
//
// Background (not a manual 26s function) because a multi-week pull for one
// store means: one paginated legal-entity punches fetch, one paginated
// employees fetch, AND one employeePunches fetch PER employee who showed up
// in that range — comfortably past the 26s budget for a busy store/longer
// range, same reasoning as every other *-background.mjs in this app.
//
// Two Paycor data sources are deliberately combined, not just one:
//   - /legalentities/{id}/punches (raw punches, fetched one WEEK at a time —
//     see fetchAllPunchesForRange — not the whole range in a single call,
//     since Paycor itself can't assemble a busy store's multi-week punch
//     history inside its own 20s timeout) — used ONLY to discover which
//     employees worked in the range at all, and as a fallback value.
//   - /employees/{id}/employeePunches (the "timecard" copy, already treated
//     elsewhere in this app — office-clock-compare.mjs — as the more
//     trustworthy source, since it reflects a manager's later corrections in
//     Paycor's own timecard editor) — the AUTHORITATIVE hours value per
//     employee per week whenever it has one.
// Per employee+week: if employeePunches has a nonzero value, use it. If
// employeePunches came back zero/empty for that week but the raw punches
// endpoint shows hours there, fall back to the raw value instead of
// silently reporting zero — a real punch that hasn't propagated into
// timecard processing yet shouldn't just vanish from an hours audit. Each
// such fallback is flagged (`fromRawPunchFallback`) so the UI can mark it.
import { sql } from './_shared/db.mjs';
import { getStore } from '@netlify/blobs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { punchHours } from './tips-report-cron-background.mjs';
// Calls Paycor directly (in-process), same as office-clock-send-background.mjs
// — NOT via tips-report-cron-background.mjs's callPaycorProxy, which hops
// over HTTPS to this site's own /.netlify/functions/paycor with a hardcoded
// 15s timeout. That ceiling is fine for the tips pipeline's single-day
// queries, but a multi-week store-wide punches pull legitimately takes
// longer than 15s — confirmed directly (2026-10-08): the outer 15s wrapper
// killed the request before Paycor's own 20s budget (inside callPaycor's
// httpsRequest) ever got a chance to finish or fail on its own, surfacing as
// "paycor proxy request timed out" even though nothing was actually hung.
// Calling callPaycor directly removes that extra hop and its mismatched,
// too-short timeout entirely.
import { callPaycor } from './paycor.mjs';

function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function blobSave(key, data) {
  await getBlobStore().setJSON(key, { savedAt: new Date().toISOString(), data });
}

const MAX_RANGE_DAYS = 120; // ~17 weeks — generous for "month to month", bounded against a runaway request

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function formatISODate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function addDaysISO(dateStr, days) {
  const d = parseDateOnly(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return formatISODate(d);
}
function daysBetween(startStr, endStr) {
  return Math.round((parseDateOnly(endStr) - parseDateOnly(startStr)) / 86400000);
}

// Pulls a punch's own date (its clock-in side) so it can be bucketed into
// the right week — same field preference order as punchHours itself.
function punchDateISO(p) {
  const raw = p.punchIn || p.inActualPunch || p.punchDateTime || null;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  // Eastern Time, same as the rest of this app's business-day conventions —
  // a punch at 11:40pm ET on week N's last day must not roll into week N+1
  // just because its UTC timestamp already crossed midnight.
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

// Same disguised-error pattern as fetchAllEmployees/fetchStoreCrew in
// tips-report-cron-background.mjs — a Paycor error response is valid,
// parseable JSON with no `records` array (Title/CorrelationId instead), not
// an empty-results page.
function assertNotPaycorError(body, what) {
  if (!Array.isArray(body?.records) && !Array.isArray(body) && (body?.Title || body?.CorrelationId)) {
    throw new Error(`Paycor error response fetching ${what}: ${body.Title || 'unknown'} — ${body.Detail || ''}`);
  }
}
function pageOf(body) {
  return Array.isArray(body?.records) ? body.records : (Array.isArray(body) ? body : []);
}

// One store's worth of punches for a SHORT window (paginated within that
// window — continuationToken is per-call, not carried across windows).
async function fetchPunchesForWindow(legalEntityId, startDate, endDate) {
  let records = [];
  let continuationToken;
  do {
    let path = `/legalentities/${legalEntityId}/punches?startDate=${startDate}&endDate=${endDate}`;
    if (continuationToken) path += `&continuationToken=${continuationToken}`;
    const res = await callPaycor(path);
    assertNotPaycorError(res.data, 'punches');
    const page = pageOf(res.data);
    records = records.concat(page);
    continuationToken = res.data?.continuationToken || res.data?.nextToken || null;
    if (!page.length) continuationToken = null;
  } while (continuationToken);
  return records;
}

// Fetches the whole range ONE WEEK AT A TIME, not as a single startDate..
// endDate call — confirmed directly (2026-10-08, store 340794/"Front", a
// 4-week range): asking Paycor for a busy store's entire multi-week punch
// history in one call legitimately took longer than the 20s Paycor-facing
// timeout to assemble, surfacing as "Paycor API request timed out" even
// though nothing was actually hung — just too much data in one response.
// Chunking by week keeps each individual call's payload small regardless of
// how long the overall requested range is.
async function fetchAllPunchesForRange(legalEntityId, weeks, onProgress) {
  let records = [];
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    const page = await fetchPunchesForWindow(legalEntityId, w.start, w.end);
    records = records.concat(page);
    if (onProgress) await onProgress(i + 1, weeks.length);
  }
  return records;
}

async function fetchAllEmployeesDirect(legalEntityId) {
  let records = [];
  let continuationToken;
  do {
    let path = `/legalentities/${legalEntityId}/employees?include=All`;
    if (continuationToken) path += `&continuationToken=${continuationToken}`;
    const res = await callPaycor(path);
    assertNotPaycorError(res.data, 'employees');
    const page = pageOf(res.data);
    records = records.concat(page);
    continuationToken = res.data?.continuationToken || res.data?.nextToken || null;
    if (!page.length) continuationToken = null;
  } while (continuationToken);
  return records;
}

async function fetchEmployeePunchesForRange(employeeId, startDate, endDate) {
  const res = await callPaycor(`/employees/${employeeId}/employeePunches?startDate=${startDate}&endDate=${endDate}`);
  assertNotPaycorError(res.data, 'employeePunches');
  return pageOf(res.data);
}

export default async (request) => {
  let payload = {};
  try { payload = await request.json(); } catch { /* handled below */ }
  const { requestId, legalEntityId, startDate, endDate } = payload;
  if (!requestId || !legalEntityId || !startDate || !endDate) {
    return new Response(JSON.stringify({ error: 'Missing requestId, legalEntityId, startDate, or endDate' }), { status: 400 });
  }
  const blobKey = `pcg_hours_report_${requestId}`;
  const db = sql();

  const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authedUser || !['executive', 'it', 'office_staff'].includes(authedUser.userType)) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const rangeDays = daysBetween(startDate, endDate);
  if (!(rangeDays >= 0) || rangeDays > MAX_RANGE_DAYS) {
    await blobSave(blobKey, { status: 'error', error: `Date range must be between 0 and ${MAX_RANGE_DAYS} days.`, finishedAt: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: false }), { status: 400 });
  }

  try {
    // Weeks are consecutive 7-day blocks counting from startDate (not
    // snapped to Sun/Mon) — matches how the request was actually framed:
    // pick a start date, see it broken into 7-day chunks from there. The
    // final chunk may be shorter if the range isn't an exact multiple of 7.
    const weeks = [];
    for (let d = startDate; d <= endDate; d = addDaysISO(d, 7)) {
      const weekEnd = addDaysISO(d, 6) > endDate ? endDate : addDaysISO(d, 6);
      weeks.push({ start: d, end: weekEnd });
    }
    const weekIndexForDate = (dateISO) => weeks.findIndex(w => dateISO >= w.start && dateISO <= w.end);

    await blobSave(blobKey, { status: 'running', step: `fetching punches (week 1 of ${weeks.length})`, startedAt: new Date().toISOString() });
    const rawPunches = await fetchAllPunchesForRange(legalEntityId, weeks, async (done, total) => {
      await blobSave(blobKey, { status: 'running', step: `fetching punches (week ${done} of ${total})`, startedAt: new Date().toISOString() });
    });
    const rawWeekly = {}; // employeeId -> number[] (per week)
    for (const p of rawPunches) {
      if (!p.employeeId) continue;
      const dISO = punchDateISO(p);
      const wIdx = dISO ? weekIndexForDate(dISO) : -1;
      if (wIdx === -1) continue;
      if (!rawWeekly[p.employeeId]) rawWeekly[p.employeeId] = new Array(weeks.length).fill(0);
      rawWeekly[p.employeeId][wIdx] += punchHours(p);
    }
    const employeeIds = Object.keys(rawWeekly);

    await blobSave(blobKey, { status: 'running', step: `found ${employeeIds.length} employees, cross-checking timecards`, startedAt: new Date().toISOString() });

    const empRoster = await fetchAllEmployeesDirect(legalEntityId);
    const empByGuid = {};
    empRoster.forEach(e => { if (e && e.id) empByGuid[e.id] = e; });

    // employeePunches (the "timecard" copy) is the authoritative source —
    // fetched per employee, batched to keep this from serializing 30+ calls
    // one at a time.
    const BATCH = 6;
    const correctedWeekly = {}; // employeeId -> number[] | null (null = fetch failed, fall back entirely)
    for (let i = 0; i < employeeIds.length; i += BATCH) {
      const batch = employeeIds.slice(i, i + BATCH);
      await Promise.all(batch.map(async (empId) => {
        try {
          const punches = await fetchEmployeePunchesForRange(empId, startDate, endDate);
          const weekly = new Array(weeks.length).fill(0);
          for (const p of punches) {
            const dISO = punchDateISO(p);
            const wIdx = dISO ? weekIndexForDate(dISO) : -1;
            if (wIdx === -1) continue;
            weekly[wIdx] += punchHours(p);
          }
          correctedWeekly[empId] = weekly;
        } catch {
          correctedWeekly[empId] = null; // fetch failed — fall back to raw for every week
        }
      }));
    }

    const employees = employeeIds.map(empId => {
      const e = empByGuid[empId];
      const name = e ? `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim() || 'Unnamed Employee' : `Unknown Employee (${empId.slice(0, 8)})`;
      const jobTitle = e?.positionData?.jobTitle || '';
      const raw = rawWeekly[empId] || new Array(weeks.length).fill(0);
      const corrected = correctedWeekly[empId];
      const weeklyHours = [];
      const fromRawPunchFallback = [];
      for (let w = 0; w < weeks.length; w++) {
        const correctedVal = corrected ? corrected[w] : null;
        const useRaw = correctedVal == null || correctedVal <= 0;
        const finalVal = useRaw ? raw[w] : correctedVal;
        weeklyHours.push(Math.round(finalVal * 100) / 100);
        fromRawPunchFallback.push(useRaw && raw[w] > 0 && correctedVal !== raw[w]);
      }
      const total = Math.round(weeklyHours.reduce((s, h) => s + h, 0) * 100) / 100;
      return { guid: empId, name, payrollId: e?.employeeNumber || e?.alternateEmployeeNumber || '', jobTitle, weeklyHours, fromRawPunchFallback, total };
    }).sort((a, b) => a.name.localeCompare(b.name));

    await blobSave(blobKey, { status: 'done', weeks, employees, finishedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[employee-hours-report-background] error:', err.message);
    await blobSave(blobKey, { status: 'error', error: err.message || 'Report generation failed', finishedAt: new Date().toISOString() });
  }

  return new Response(JSON.stringify({ ok: true }), { status: 202 });
};
