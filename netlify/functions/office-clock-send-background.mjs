// office-clock-send-background.mjs — Office Hourly Time Clock, Task 6: the
// actual batch write to Paycor's CreatePunches API, plus async error-log
// polling to find out what really happened.
//
// Fired fire-and-forget by office-clock-review.mjs's `send` action. UNLIKE
// this codebase's other *-background.mjs jobs (labor-cron-background.mjs,
// tips-report-refresh-background.mjs, minor-timecard-detect-cron-
// background.mjs), which only ever redo an internal recompute if someone
// reaches their URL without authorization, THIS file is the literal function
// that pushes real punches to production Paycor payroll — the same stakes
// category no-clockin.mjs (this codebase's own "Manual exec/IT endpoint")
// already treats as needing its own `requireActiveUser` check, not the
// recompute-job category. Its own URL takes nothing more secret than
// `{ periodEnd }` — trivially derivable (`payPeriodEndFor(today)` off a
// published anchor date) — so without its own auth check, reaching this URL
// directly would push a whole pay period to Paycor while completely
// bypassing office-clock-review.mjs's IT review/edit/lock step. Re-checked
// here via the SAME `requireActiveUser` mechanism both files already import —
// no new auth code, just also calling it from this file — against the
// Authorization header / pcg_session cookie office-clock-review.mjs's `send`
// action forwards from the real triggering admin's own request.
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
import { requireActiveUser } from './auth-lib/require-user.js';
import { punchStatusAndActivity } from '../../src/office-clock-lib.mjs';
import { resolvePunchLogResponse } from '../../src/paycor-punch-resolve.mjs';
import { callPaycor } from './paycor.mjs';
import { ensureActivityTypes, isPeriodFinalized } from './office-clock-review.mjs';

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
  const db = sql();

  // Auth gate (see header comment for why this file needs its own, unlike
  // this codebase's other *-background.mjs jobs) — same shape as office-
  // clock-review.mjs's own exec/it check. Checked before anything else,
  // including the OFFICE_LEGAL_ENTITY_ID check below, so an unauthorized
  // caller learns nothing about this function's configuration state either.
  const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  // I1 — this file's own finalized check, not just office-clock-review.mjs's.
  // That file's `send` action already rejects a finalized period with a 409,
  // but this function's own URL takes nothing more secret than
  // `{ periodEnd }` (see header comment), so without checking here too, any
  // exec/it caller who reaches THIS url directly could bypass that 409 and
  // re-push an already-fully-confirmed period to Paycor anyway. Checked right
  // after auth, before any DB claim/write. Uses the same shared
  // isPeriodFinalized office-clock-review.mjs exports (not a second copy) —
  // see that function's header comment for the full finalization rule (a
  // period stays open, and sendable, while a send has been triggered but some
  // punches are still unsent/pending/failed; that's this feature's own
  // fix-and-resend workflow, not a bug).
  if (await isPeriodFinalized(db, periodEnd)) {
    return new Response(JSON.stringify({ error: 'Pay period is finalized — it has already been fully sent to and confirmed by Paycor' }), { status: 409 });
  }

  const legalEntityId = process.env.OFFICE_LEGAL_ENTITY_ID;
  if (!legalEntityId) {
    await blobSave(blobKey, { status: 'error', error: 'OFFICE_LEGAL_ENTITY_ID is not configured', finishedAt: new Date().toISOString() });
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }

  try {
    await blobSave(blobKey, { status: 'running', step: 'activityTypes', startedAt: new Date().toISOString() });

    // Same cache office-clock-review.mjs's own handler reads/writes — calling
    // the shared helper (not a second copy of this logic) so both files agree
    // on the GUIDs and on the "throw rather than cache a partial mapping" rule.
    const { workActivityTypeId, mealActivityTypeId } = await ensureActivityTypes(db, legalEntityId);
    const activityTypeIdFor = (activity) => (activity === 'Work' ? workActivityTypeId : mealActivityTypeId);

    // Atomic claim: SELECT-then-UPDATE would let two overlapping `send`
    // invocations (a double-click, or two exec/it users within seconds of
    // each other) both read the same 'unsent' rows before either UPDATE
    // commits, submitting the same punches to Paycor twice. A single
    // UPDATE ... WHERE paycor_status = 'unsent' ... RETURNING * closes that
    // window completely — Postgres row-level locking means only one
    // invocation's UPDATE can ever actually flip a given row, so a second,
    // overlapping invocation's claim simply returns fewer (or zero) rows for
    // whatever the first one already took. The punch batch below is built
    // from what THIS UPDATE actually returned, never from a separate prior
    // SELECT.
    const rows = await db`
      WITH claimed AS (
        UPDATE office_clock_punches
        SET paycor_status = 'pending', paycor_tracking_id = NULL
        WHERE pay_period_end = ${periodEnd} AND paycor_status = 'unsent'
        RETURNING *
      )
      SELECT claimed.*, u.paycor_employee_id, u.paycor_department_id
      FROM claimed
      JOIN users u ON u.id = claimed.user_id
      ORDER BY claimed.captured_at`;

    if (!rows.length) {
      await blobSave(blobKey, { status: 'done', total: 0, confirmed: 0, failed: 0, finishedAt: new Date().toISOString() });
      return new Response(JSON.stringify({ ok: true, total: 0 }), { status: 200 });
    }

    // Defensive: a user's Paycor link can in principle be revoked between
    // punching and sending. office-clock-punch.mjs's own enablement gate
    // should make this impossible for a NEW punch, but it says nothing about
    // punches already sitting unsent from before a revoke — never silently
    // drop these from the count, report them as skipped instead. These rows
    // were already claimed ('pending') by the UPDATE above along with
    // everything else for this period, so they're reverted back to 'unsent'
    // here rather than left stuck 'pending' forever with nothing actually
    // sent — a future send (once re-linked, or by IT fixing the link) can
    // pick them up normally.
    const sendable = [];
    const skippedUnlinked = [];
    for (const r of rows) {
      if (!r.paycor_employee_id || !r.paycor_department_id) skippedUnlinked.push(r);
      else sendable.push(r);
    }
    if (skippedUnlinked.length) {
      const skippedIds = skippedUnlinked.map((r) => r.id);
      await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE id = ANY(${skippedIds})`;
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

    const sendableIds = sendable.map((r) => r.id);

    const createRes = await callPaycor(`/legalentities/${legalEntityId}/CreatePunches`, 'POST', punchObjects);
    if (createRes.status < 200 || createRes.status >= 300) {
      // Nothing was actually accepted by Paycor — release the claim so these
      // rows are eligible for a normal retry instead of stuck 'pending'
      // forever with no tracking ID to ever poll for.
      await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE id = ANY(${sendableIds})`;
      await blobSave(blobKey, {
        status: 'error', error: `CreatePunches failed: HTTP ${createRes.status}`, detail: createRes.data,
        finishedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ ok: false }), { status: 502 });
    }
    const trackingId = createRes.data?.trackingId || createRes.data?.TrackingId
      || createRes.data?.id || createRes.data?.Id;
    if (!trackingId) {
      await db`UPDATE office_clock_punches SET paycor_status = 'unsent' WHERE id = ANY(${sendableIds})`;
      await blobSave(blobKey, {
        status: 'error', error: 'CreatePunches response had no tracking ID', detail: createRes.data,
        finishedAt: new Date().toISOString(),
      });
      return new Response(JSON.stringify({ ok: false }), { status: 502 });
    }

    // Rows are already 'pending' from the atomic claim above — just attach
    // the tracking ID now that Paycor has actually accepted the batch.
    await db`UPDATE office_clock_punches SET paycor_tracking_id = ${trackingId} WHERE id = ANY(${sendableIds})`;
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

    // ⚠️ GO-LIVE CHECKLIST ITEM — NOT YET VERIFIED AT BATCH SCALE ⚠️
    // Match each resolved record back to the row it came from. The real
    // response shape confirmed in Task 1's Controlled Test returns per-record
    // results in the same order the punches were submitted — matched
    // primarily by request-order position. BUT that Controlled Test only ever
    // sent ONE punch; request-order preservation for a real multi-record
    // CreatePunches batch has never been confirmed against production Paycor.
    // The EmployeeId + PunchDateTime fallback below is a reasonable safety
    // net if a given response's record count doesn't match what was sent, but
    // it is not a substitute for actually checking: before the very first
    // live biweekly send, verify this matching logic against a real
    // multi-record batch the same deliberate way Task 1's Controlled Test
    // validated the single-punch case — don't let this go live unverified.
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
