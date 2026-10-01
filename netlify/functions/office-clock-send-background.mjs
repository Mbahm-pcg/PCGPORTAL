// office-clock-send-background.mjs — Office Hourly Time Clock, Task 6: the
// actual batch write to Paycor's CreatePunches API, plus async error-log
// polling to find out what really happened.
//
// Fired fire-and-forget by office-clock-review.mjs's `send` action, which is
// already exec/it-gated one layer up — this file does no auth of its own,
// matching every other *-background.mjs in this codebase (labor-cron-
// background.mjs, tips-report-refresh-background.mjs, minor-timecard-detect-
// cron-background.mjs — none of them re-check a session token either; a
// background function's trust boundary is "whoever can reach this URL",
// accepted elsewhere in this codebase, not something this task introduces).
//
// Calls Paycor directly via paycor.mjs's own exported `callPaycor` (the same
// raw OAuth-wrapped HTTP call paycor.mjs's own in-file actions use) instead of
// looping back through paycor.mjs's public HTTP `createPunches` action. That
// action's own exec/it `requireActiveUser` gate protects direct public HTTP
// access to /.netlify/functions/paycor; it is not a gate this already-
// privileged, server-internal call needs to satisfy a second time — same
// trust boundary as labor-cron.mjs's own already-exported `callPaycor`, reused
// directly elsewhere in this codebase with no auth re-check either.
import { sql } from './_shared/db.mjs';
import { getStore } from '@netlify/blobs';
import { punchStatusAndActivity } from '../../src/office-clock-lib.mjs';
import { resolvePunchLogResponse } from '../../src/paycor-punch-resolve.mjs';
import { callPaycor } from './paycor.mjs';
import { ensureActivityTypes } from './office-clock-review.mjs';

function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}
// Standard { savedAt, data } wrapper for cloudLoad compatibility, same shape
// as minor-timecard-detect-cron-background.mjs's blobSave.
async function blobSave(key, data) {
  await getBlobStore().setJSON(key, { savedAt: new Date().toISOString(), data });
}

const POLL_INTERVAL_MS = 5000;
const MAX_POLLS = 60; // 5 minutes of polling; leaves well over half of the 15-min budget unused
const UNRESOLVED_LOG_CAP = 10; // cap repeated "still unresolved" log lines, don't spam on a long stretch

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async (request) => {
  let payload = {};
  try { payload = await request.json(); } catch { /* no body is a caller error, handled below */ }
  const { periodEnd } = payload;
  if (!periodEnd) return new Response(JSON.stringify({ error: 'Missing periodEnd' }), { status: 400 });

  const blobKey = `pcg_office_clock_send_${periodEnd}`;
  const legalEntityId = process.env.OFFICE_LEGAL_ENTITY_ID;
  if (!legalEntityId) {
    await blobSave(blobKey, { status: 'error', error: 'OFFICE_LEGAL_ENTITY_ID is not configured', finishedAt: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }

  const db = sql();

  try {
    await blobSave(blobKey, { status: 'running', step: 'activityTypes', startedAt: new Date().toISOString() });

    // Same cache office-clock-review.mjs's own handler reads/writes — calling
    // the shared helper (not a second copy of this logic) so both files agree
    // on the GUIDs and on the "throw rather than cache a partial mapping" rule.
    const { workActivityTypeId, mealActivityTypeId } = await ensureActivityTypes(db, legalEntityId);
    const activityTypeIdFor = (activity) => (activity === 'Work' ? workActivityTypeId : mealActivityTypeId);

    const rows = await db`
      SELECT cp.*, u.paycor_employee_id, u.paycor_department_id
      FROM office_clock_punches cp
      JOIN users u ON u.id = cp.user_id
      WHERE cp.pay_period_end = ${periodEnd} AND cp.paycor_status = 'unsent'
      ORDER BY cp.captured_at`;

    if (!rows.length) {
      await blobSave(blobKey, { status: 'done', total: 0, confirmed: 0, failed: 0, finishedAt: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true, total: 0 }), { status: 200 });
    }

    // Defensive: a user's Paycor link can in principle be revoked between
    // punching and sending. office-clock-punch.mjs's own enablement gate
    // should make this impossible for a NEW punch, but it says nothing about
    // punches already sitting unsent from before a revoke — never silently
    // drop these from the count, report them as skipped instead.
    const sendable = [];
    const skippedUnlinked = [];
    for (const r of rows) {
      if (!r.paycor_employee_id || !r.paycor_department_id) skippedUnlinked.push(r);
      else sendable.push(r);
    }

    if (!sendable.length) {
      await blobSave(blobKey, {
        status: 'done', total: rows.length, confirmed: 0, failed: 0,
        skippedUnlinked: skippedUnlinked.length, finishedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ ok: true, total: 0 }), { status: 200 });
    }

    // Build one punch object per sendable row. IsTransfer is REQUIRED on every
    // record — confirmed against real production Paycor during this feature's
    // Controlled Test: the first attempt without it got a genuine 400 back
    // ("The IsTransfer field is required"), contradicting earlier secondhand
    // docs that called it optional. Always `false` here; this feature never
    // represents a location transfer.
    const punchObjects = sendable.map((r) => {
      const { status, activity } = punchStatusAndActivity(r.punch_type);
      const obj = {
        EmployeeId: r.paycor_employee_id,
        DepartmentId: r.paycor_department_id,
        PunchDateTime: new Date(r.captured_at).toISOString(),
        PunchStatusType: status,
        ActivityTypeId: activityTypeIdFor(activity),
        IsTransfer: false,
      };
      if (r.note) obj.Note = r.note;
      return obj;
    });

    const createRes = await callPaycor(`/legalentities/${legalEntityId}/CreatePunches`, 'POST', punchObjects);
    if (createRes.status < 200 || createRes.status >= 300) {
      await blobSave(blobKey, {
        status: 'error', error: `CreatePunches failed: HTTP ${createRes.status}`, detail: createRes.data,
        finishedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ ok: false }), { status: 502 });
    }
    const trackingId = createRes.data?.trackingId || createRes.data?.TrackingId
      || createRes.data?.id || createRes.data?.Id;
    if (!trackingId) {
      await blobSave(blobKey, {
        status: 'error', error: 'CreatePunches response had no tracking ID', detail: createRes.data,
        finishedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ ok: false }), { status: 502 });
    }

    const sendableIds = sendable.map((r) => r.id);
    await db`UPDATE office_clock_punches SET paycor_status = 'pending', paycor_tracking_id = ${trackingId} WHERE id = ANY(${sendableIds})`;
    await blobSave(blobKey, {
      status: 'running', step: 'polling', trackingId, total: sendable.length,
      skippedUnlinked: skippedUnlinked.length, startedAt: new Date().toISOString(),
    });

    // Poll punchErrorLog via resolvePunchLogResponse's exact semantics:
    // 'pending' (404) keeps polling; 'unresolved' (anything non-2xx, non-404 —
    // e.g. a transient 401/403/500) keeps polling too, but is NEVER read as
    // success — rows stay 'pending' the whole time this loop runs, only a real
    // 'resolved' (2xx) moves them to confirmed/failed. If the loop exhausts
    // its budget still unresolved, rows are deliberately left 'pending' for a
    // later retry rather than inventing a fake terminal failure.
    let finalState = null;
    let unresolvedLogged = 0;
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const logRes = await callPaycor(`/legalentities/${legalEntityId}/punchErrorLog/${trackingId}`);
      const resolution = resolvePunchLogResponse(logRes.status, logRes.data);

      if (resolution.state === 'pending') continue;

      if (resolution.state === 'unresolved') {
        unresolvedLogged++;
        if (unresolvedLogged <= UNRESOLVED_LOG_CAP) {
          console.warn(`[office-clock-send] punchErrorLog unresolved on attempt ${attempt + 1}/${MAX_POLLS} (tracking ${trackingId}): ${resolution.reason}`);
        }
        continue;
      }

      finalState = resolution; // 'resolved'
      break;
    }

    if (!finalState) {
      await blobSave(blobKey, {
        status: 'pending_retry', total: sendable.length, skippedUnlinked: skippedUnlinked.length, trackingId,
        note: 'punchErrorLog never resolved within the polling window — rows left pending for a later retry',
        finishedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ ok: true, pending: true }), { status: 200 });
    }

    // Match each resolved record back to the row it came from. The real
    // response shape confirmed in Task 1's Controlled Test returns per-record
    // results in the same order the punches were submitted — matched
    // primarily by request-order position. If a given response's record count
    // doesn't match what was sent (order can't be trusted), fall back to
    // matching on EmployeeId + PunchDateTime instead of guessing.
    const { succeeded, failed } = finalState;
    const outcomes = [
      ...succeeded.map((record) => ({ record, ok: true })),
      ...failed.map(({ record, errors }) => ({ record, ok: false, errors })),
    ];

    const matchedIds = new Set();
    let confirmedCount = 0;
    let failedCount = 0;
    const matchByOrder = outcomes.length === sendable.length;

    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      let row = null;
      if (matchByOrder) {
        row = sendable[i];
      } else {
        const rec = outcome.record || {};
        const recEmployeeId = rec.EmployeeId ?? rec.employeeId;
        const recPunchDateTime = rec.PunchDateTime ?? rec.punchDateTime;
        row = sendable.find((r) => !matchedIds.has(r.id)
          && String(r.paycor_employee_id) === String(recEmployeeId)
          && recPunchDateTime != null
          && new Date(r.captured_at).toISOString() === new Date(recPunchDateTime).toISOString());
      }
      if (!row) continue;
      matchedIds.add(row.id);

      if (outcome.ok) {
        await db`UPDATE office_clock_punches SET paycor_status = 'confirmed' WHERE id = ${row.id}`;
        confirmedCount++;
      } else {
        const errNote = `Paycor error: ${JSON.stringify(outcome.errors)}`;
        await db`UPDATE office_clock_punches SET paycor_status = 'failed', note = COALESCE(note || ' | ', '') || ${errNote} WHERE id = ${row.id}`;
        failedCount++;
      }
    }

    // Any sendable row never matched to a record at all is left 'pending'
    // (not silently assumed confirmed) — a resolved response with fewer
    // records than were sent is a real anomaly worth surfacing, not hiding.
    const unmatchedCount = sendable.filter((r) => !matchedIds.has(r.id)).length;

    await blobSave(blobKey, {
      status: 'done', total: sendable.length, confirmed: confirmedCount, failed: failedCount,
      unmatched: unmatchedCount, skippedUnlinked: skippedUnlinked.length, trackingId,
      finishedAt: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ ok: true, confirmed: confirmedCount, failed: failedCount, unmatched: unmatchedCount }), { status: 200 });
  } catch (err) {
    await blobSave(blobKey, { status: 'error', error: err.message, finishedAt: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: false, error: err.message }), { status: 500 });
  }
};
