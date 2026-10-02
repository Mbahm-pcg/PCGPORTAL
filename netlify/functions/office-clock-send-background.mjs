// office-clock-send-background.mjs — Office Hourly Time Clock: stages each
// linked office_staff employee's exact worked hours into Paycor's paygrid
// (stagePayrollHours, v2, employeeId-keyed) for the closed biweekly period.
//
// Switched 2026-10-02 from writing real Paycor punches (CreatePunches) to
// this paygrid-staging approach, matching the pattern already proven live in
// production for tips (see paycor.mjs's stagePayrollHours action and
// app.jsx's sendToPaycor). Reasons for the switch:
//   - CreatePunches for this legal entity (193872) returned inconsistent,
//     undocumented errors tied to a "tparnerhubapi" partner-hub component —
//     a confirmed-valid, correctly-scoped EmployeeId was rejected outright,
//     and a later attempt returned an ambiguous 2xx with no tracking ID,
//     followed by a "duplicate request" rejection on retry, with nothing
//     ever actually created. CreatePunches also has NO delete/undo API.
//   - stagePayrollHours is synchronous (no tracking-ID/polling dance), and
//     per Paycor's own confirmation, only STAGES data into the paygrid for
//     human review — it does not submit payroll. A human still has to
//     review and hit submit in Paycor's own UI, and a re-stage with the same
//     processId + replaceData:true safely corrects a prior mistake any time
//     before that real submit happens. This is a STRICTLY SAFER failure mode
//     than CreatePunches ever was.
//
// Real worked hours still come entirely from the exact clock-in/clock-out
// data (src/office-clock-lib.mjs's dailyHoursFromPunches — same no-
// estimates math as the review screen's "Daily Hours" table). The one thing
// this file's write path is now responsible for that CreatePunches would
// have left to Paycor's own Time Policy engine: splitting each of the
// period's two Sunday-Saturday workweeks into Reg (<=40 hrs) / OT (>40 hrs)
// at the standard FLSA weekly threshold (weeklyRegOtFromPunches) — per
// explicit direction, never combined across the two weeks of a period.
//
// Fired fire-and-forget by office-clock-review.mjs's `send` action. Needs
// its own requireActiveUser check for the same reason this always has: its
// own URL takes nothing more secret than `{ periodEnd }`, so without a check
// here a direct hit would stage a whole period's pay to Paycor while
// bypassing office-clock-review.mjs's IT review/edit/lock step.
import { sql } from './_shared/db.mjs';
import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { requireActiveUser } from './auth-lib/require-user.js';
import { weeklyRegOtFromPunches } from '../../src/office-clock-lib.mjs';
import { callPaycor } from './paycor.mjs';
import { isPeriodFinalized } from './office-clock-review.mjs';

function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
async function blobSave(key, data) {
  await getBlobStore().setJSON(key, { savedAt: new Date().toISOString(), data });
}

const EARNING_CODE_REG = 'Reg';
const EARNING_CODE_OT = 'OT';

// Deterministic (not random) UUID per employee+period — the server-side twin
// of app.jsx's tipsStableProcessId (same version-5-style construction, built
// with Node's built-in crypto instead of the browser's Web Crypto, since
// this runs in a Netlify Function, not a page). Keyed per EMPLOYEE, not per
// legal entity, so one employee's re-stage/correction never touches another
// employee's already-staged batch, and a re-send for the same employee+
// period overwrites (replaceData:true) rather than stacking a duplicate.
function stableProcessId(seed) {
  const hash = createHash('sha256').update(seed).digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5 (name-based)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default async (request) => {
  let payload = {};
  try { payload = await request.json(); } catch { /* no body is a caller error, handled below */ }
  const { periodEnd } = payload;
  if (!periodEnd) return new Response(JSON.stringify({ error: 'Missing periodEnd' }), { status: 400 });

  const blobKey = `pcg_office_clock_send_${periodEnd}`;
  const db = sql();

  const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  if (await isPeriodFinalized(db, periodEnd)) {
    return new Response(JSON.stringify({ error: 'Pay period is finalized — it has already been fully sent to and confirmed by Paycor' }), { status: 409 });
  }

  const legalEntityId = process.env.OFFICE_LEGAL_ENTITY_ID;
  if (!legalEntityId) {
    await blobSave(blobKey, { status: 'error', error: 'OFFICE_LEGAL_ENTITY_ID is not configured', finishedAt: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }

  try {
    await blobSave(blobKey, { status: 'running', step: 'claiming', startedAt: new Date().toISOString() });

    // Atomic claim: same purpose as the old CreatePunches flow — a single
    // UPDATE ... WHERE paycor_status = 'unsent' ... RETURNING * closes the
    // double-submit race window a double-click or two near-simultaneous
    // admins could otherwise open. This determines WHICH USERS have
    // outstanding changes worth re-staging this round (a user with nothing
    // newly claimed is skipped — no need to re-call Paycor for someone
    // whose data hasn't changed since their last successful stage).
    const claimed = await db`
      WITH touched AS (
        UPDATE office_clock_punches
        SET paycor_status = 'pending'
        WHERE pay_period_end = ${periodEnd} AND paycor_status = 'unsent'
        RETURNING user_id
      )
      SELECT DISTINCT user_id FROM touched`;

    if (!claimed.length) {
      await blobSave(blobKey, { status: 'done', total: 0, confirmed: 0, failed: 0, finishedAt: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true, total: 0 }), { status: 200 });
    }

    const claimedUserIds = claimed.map((r) => r.user_id);

    // Fetch each claimed user's COMPLETE punch set for the period — not just
    // the newly-claimed subset — because stagePayrollHours' replaceData:true
    // always replaces the FULL current picture for that employee+period, the
    // same way tips' re-send always submits the full current total rather
    // than an incremental delta. Computing hours from only the new rows
    // would silently drop any already-confirmed hours from earlier in the
    // period out of the total.
    const rows = await db`
      SELECT p.*, u.name, u.paycor_employee_id, u.paycor_department_id
      FROM office_clock_punches p
      JOIN users u ON u.id = p.user_id
      WHERE p.pay_period_end = ${periodEnd} AND p.user_id = ANY(${claimedUserIds})
      ORDER BY p.captured_at`;

    const byUser = new Map();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, { name: r.name, paycorEmployeeId: r.paycor_employee_id, paycorDepartmentId: r.paycor_department_id, rows: [] });
      byUser.get(r.user_id).rows.push(r);
    }

    // A user's Paycor link can in principle be revoked between punching and
    // sending. Never silently drop these — revert to unsent (resendable
    // once re-linked) and report as skipped.
    const skippedUnlinked = [];
    const toProcess = [];
    for (const [userId, u] of byUser) {
      if (!u.paycorEmployeeId || !u.paycorDepartmentId) { skippedUnlinked.push(u.name || userId); continue; }
      toProcess.push([userId, u]);
    }
    if (skippedUnlinked.length) {
      const unlinkedIds = [...byUser.entries()].filter(([, u]) => !u.paycorEmployeeId || !u.paycorDepartmentId).map(([id]) => id);
      await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE pay_period_end = ${periodEnd} AND user_id = ANY(${unlinkedIds})`;
    }

    if (!toProcess.length) {
      await blobSave(blobKey, { status: 'done', total: 0, confirmed: 0, failed: 0, skippedUnlinked: skippedUnlinked.length, finishedAt: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true, total: 0 }), { status: 200 });
    }

    // Department GUID -> numeric departmentCode. stagePayrollHours' schema
    // requires the numeric code (confirmed live 2026-10-02: GUID
    // b55f12af-c3d0-0000-0000-000050f50200 = code "105", "Payroll -
    // Administration") — a different identifier than the department GUID
    // already stored as paycor_department_id for the (now unused for this
    // feature) CreatePunches write. Small, legal-entity-wide list — fetched
    // fresh each send rather than cached, same as payGroupId below.
    const deptRes = await callPaycor(`/legalentities/${legalEntityId}/departments`);
    if (deptRes.status < 200 || deptRes.status >= 300) {
      throw new Error(`Paycor departments lookup failed: HTTP ${deptRes.status}`);
    }
    const deptRecords = Array.isArray(deptRes.data?.records) ? deptRes.data.records : (Array.isArray(deptRes.data) ? deptRes.data : []);
    const deptCodeByGuid = new Map(deptRecords.map((d) => [d.id, d.code]));

    // payGroupId — one per legal entity, required on every earning entry.
    const payGroupRes = await callPaycor(`/legalentities/${legalEntityId}/paygroups`);
    const payGroupRecords = Array.isArray(payGroupRes.data?.records) ? payGroupRes.data.records : (Array.isArray(payGroupRes.data) ? payGroupRes.data : []);
    const payGroupId = payGroupRecords[0]?.payGroupId || null;
    if (!payGroupId) throw new Error("Couldn't look up this legal entity's Paycor pay group");

    let confirmedCount = 0;
    let failedCount = 0;
    let skippedZeroHours = 0;
    const perUserResults = [];

    for (const [userId, u] of toProcess) {
      const userRows = u.rows.map((r) => ({ punchType: r.punch_type, capturedAt: new Date(r.captured_at).toISOString() }));
      const weeks = weeklyRegOtFromPunches(userRows, periodEnd);

      if (weeks.some((w) => w.incomplete)) {
        await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE pay_period_end = ${periodEnd} AND user_id = ${userId}`;
        perUserResults.push({ userId, name: u.name, ok: false, reason: 'Incomplete punches this period (a missing clock-out or unmatched meal punch) — fix before resending' });
        failedCount++;
        continue;
      }

      const deptCode = deptCodeByGuid.get(u.paycorDepartmentId);
      if (!deptCode) {
        await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE pay_period_end = ${periodEnd} AND user_id = ${userId}`;
        perUserResults.push({ userId, name: u.name, ok: false, reason: `No Paycor department code found for this employee's department (GUID ${u.paycorDepartmentId})` });
        failedCount++;
        continue;
      }

      const importEarnings = [];
      for (const w of weeks) {
        if (w.regHours > 0) importEarnings.push({ departmentCode: Number(deptCode), earningCode: EARNING_CODE_REG, earningHours: w.regHours, businessStartDate: `${w.weekStart}T00:00:00Z`, businessEndDate: `${w.weekEnd}T23:59:59Z`, payGroupId });
        if (w.otHours > 0) importEarnings.push({ departmentCode: Number(deptCode), earningCode: EARNING_CODE_OT, earningHours: w.otHours, businessStartDate: `${w.weekStart}T00:00:00Z`, businessEndDate: `${w.weekEnd}T23:59:59Z`, payGroupId });
      }

      if (!importEarnings.length) {
        // Genuinely zero hours this period (e.g. a zero-duration test punch,
        // or no real shifts worked) — nothing meaningful to stage. Confirmed
        // without ever calling Paycor, rather than staging an empty/zero
        // earning entry.
        await db`UPDATE office_clock_punches SET paycor_status = 'confirmed' WHERE pay_period_end = ${periodEnd} AND user_id = ${userId}`;
        perUserResults.push({ userId, name: u.name, ok: true, reason: 'No hours to stage this period' });
        skippedZeroHours++;
        continue;
      }

      const processId = stableProcessId(`office-clock_${u.paycorEmployeeId}_${periodEnd}`);
      try {
        const res = await callPaycor(
          `/legalentities/${legalEntityId}/payrollhours?replaceData=true`,
          'POST',
          { integrationVendor: 'PCG Portal', processId, importEmployees: [{ employeeId: u.paycorEmployeeId, importEarnings }] },
          'v2',
        );
        if (res.status >= 200 && res.status < 300) {
          await db`UPDATE office_clock_punches SET paycor_status = 'confirmed' WHERE pay_period_end = ${periodEnd} AND user_id = ${userId}`;
          perUserResults.push({ userId, name: u.name, ok: true, weeks });
          confirmedCount++;
        } else {
          await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE pay_period_end = ${periodEnd} AND user_id = ${userId}`;
          perUserResults.push({ userId, name: u.name, ok: false, reason: res.data?.Detail || res.data?.message || `HTTP ${res.status}`, detail: res.data });
          failedCount++;
        }
      } catch (err) {
        await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE pay_period_end = ${periodEnd} AND user_id = ${userId}`;
        perUserResults.push({ userId, name: u.name, ok: false, reason: err.message });
        failedCount++;
      }
    }

    await blobSave(blobKey, {
      status: 'done', total: toProcess.length, confirmed: confirmedCount, failed: failedCount,
      skippedZeroHours, skippedUnlinked: skippedUnlinked.length, results: perUserResults,
      finishedAt: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ ok: true, confirmed: confirmedCount, failed: failedCount }), { status: 200 });
  } catch (err) {
    // Any failure before a given user's own try/catch resolves them (e.g.
    // the departments/paygroups lookups above throwing on a Paycor network
    // blip, before the per-user loop even starts) would otherwise leave
    // their rows stuck at 'pending' forever — not retryable by a future
    // send, since the atomic claim only ever picks up 'unsent' rows. This
    // sweep is idempotent and precise: it only touches rows still genuinely
    // 'pending' (unresolved), never a row the per-user loop already
    // resolved to 'confirmed' or reverted to 'unsent' earlier in this same
    // invocation.
    try { await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE pay_period_end = ${periodEnd} AND paycor_status = 'pending'`; } catch { /* best-effort cleanup */ }
    await blobSave(blobKey, { status: 'error', error: err.message, finishedAt: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};
