// office-clock-review.mjs — Office Hourly Time Clock, Task 6: pay period review,
// manual edit, and batch-send trigger (exec/it only).
//
// Lets IT/exec review every office_staff user's punches for one biweekly
// pay period (everyone linked to Paycor — paycor_employee_id AND
// paycor_department_id both set — across the single office/corporate legal
// entity; there is no per-store loop here, unlike labor/tips), edit them
// freely until the period is "finalized" (see `isPeriodFinalized` below —
// there is no automatic time-based deadline: a period can be reviewed and
// sent whenever IT/exec is ready), and fire the actual Paycor CreatePunches
// batch write as a background job (office-clock-send-background.mjs). This
// file itself never writes a punch to Paycor — only the one-time
// activityTypes lookup (read-only) runs here, shared with the background
// sender via the exported `ensureActivityTypes` helper.
//
// Four actions, all exec/it only:
//   period     { periodEnd }                                   -> { locked, punches, incompleteDays }
//   edit       { periodEnd, userId, punchType, capturedAt, punchId?, note? } -> { ok, punch }  (409 if finalized)
//   send       { periodEnd }                                   -> { started: true }            (409 if finalized)
//   sendStatus { periodEnd }                                   -> the pcg_office_clock_send_{periodEnd} blob's data
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { getStore } from '@netlify/blobs';
import { findIncompleteDays, payPeriodEndFor } from '../../src/office-clock-lib.mjs';
import { callPaycor } from './paycor.mjs';
import { ensurePunchesTable } from './office-clock-punch.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

const PUNCH_TYPES = new Set(['clock_in', 'meal_start', 'meal_end', 'clock_out']);

// The ET (America/New_York) calendar date of a UTC instant, as a
// "YYYY-MM-DD" string — the same idiom office-clock-compare.mjs's etDayOf and
// office-clock-punch.mjs's etDateStr already use, reused here so pay-period
// derivation during an edit (I3/I4) agrees with every other place this
// feature assigns a punch to a day/period.
function etDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

// Self-creating tables, idempotent across warm invocations — same module-level
// once-flag + `CREATE TABLE IF NOT EXISTS` shape as office-clock-punch.mjs:39-57
// (Task 5), tickets.mjs, safe-audits.mjs and incident-reports.mjs. No internal
// try/catch here either: a genuine schema/connection failure propagates to this
// file's own outer try/catch (a clean 500).
let _tablesReady = false;
async function ensureTables(db) {
  if (_tablesReady) return;
  // I7 — office-clock-punch.mjs created office_clock_punches, but this file
  // queries it too (every action below) and never ensured it existed. On a
  // fresh database (or before any office_staff user has ever punched), that
  // would 500 with "relation does not exist" instead of a clean empty result.
  // Shared helper, not a second copy of the DDL — same pattern as
  // `ensureActivityTypes` below, which office-clock-send-background.mjs
  // itself already reuses from this file.
  await ensurePunchesTable(db);
  await db`CREATE TABLE IF NOT EXISTS office_clock_activity_types (
    legal_entity_id        text PRIMARY KEY,
    work_activity_type_id  text NOT NULL,
    meal_activity_type_id  text NOT NULL,
    fetched_at             timestamptz NOT NULL DEFAULT now()
  )`;
  await db`CREATE TABLE IF NOT EXISTS office_clock_pay_period_sends (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_period_end  date NOT NULL,
    sent_at         timestamptz NOT NULL DEFAULT now(),
    sent_by         text NOT NULL
  )`;
  _tablesReady = true;
}

// Resolves (and caches in Postgres) the Work/Meal ActivityTypeId GUIDs for a
// legal entity. Exported so office-clock-send-background.mjs (Task 6's other
// file) calls this exact same function rather than a second copy of this
// logic — it self-ensures its own table via ensureTables() above, so it works
// whether or not this file's own handler has already run in this process.
// Throws (never caches a partial mapping) if either Work or Meal is missing
// from Paycor's activityTypes response — a half-populated cache would silently
// send one of the two punch kinds with an undefined ActivityTypeId later.
export async function ensureActivityTypes(db, legalEntityId) {
  await ensureTables(db);

  const cached = await db`
    SELECT work_activity_type_id, meal_activity_type_id
    FROM office_clock_activity_types
    WHERE legal_entity_id = ${legalEntityId}`;
  if (cached.length) {
    return {
      workActivityTypeId: cached[0].work_activity_type_id,
      mealActivityTypeId: cached[0].meal_activity_type_id,
    };
  }

  const res = await callPaycor(`/legalentities/${legalEntityId}/activityTypes`);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Paycor activityTypes request failed: HTTP ${res.status}`);
  }
  // Paycor's list endpoints are inconsistent about wrapping records in a
  // `records` array vs. returning a bare array (same ambiguity already
  // handled for /employees and /punches elsewhere in this codebase) — accept
  // either shape rather than assuming one.
  const records = Array.isArray(res.data?.records) ? res.data.records
    : (Array.isArray(res.data) ? res.data : []);
  const work = records.find(r => (r.name || r.Name) === 'Work');
  const meal = records.find(r => (r.name || r.Name) === 'Meal');
  if (!work || !meal) {
    const found = records.map(r => r.name || r.Name).join(', ') || '(none)';
    throw new Error(`Paycor activityTypes for legal entity ${legalEntityId} is missing Work and/or Meal (found: ${found})`);
  }
  const workId = work.id || work.Id;
  const mealId = meal.id || meal.Id;

  const [row] = await db`
    INSERT INTO office_clock_activity_types (legal_entity_id, work_activity_type_id, meal_activity_type_id)
    VALUES (${legalEntityId}, ${workId}, ${mealId})
    ON CONFLICT (legal_entity_id) DO UPDATE SET
      work_activity_type_id = EXCLUDED.work_activity_type_id,
      meal_activity_type_id = EXCLUDED.meal_activity_type_id,
      fetched_at = now()
    RETURNING work_activity_type_id, meal_activity_type_id`;
  return { workActivityTypeId: row.work_activity_type_id, mealActivityTypeId: row.meal_activity_type_id };
}

// A pay period is "finalized" (read-only) once ALL of these are true:
//   1. at least one send has actually been triggered for it — a row exists
//      in office_clock_pay_period_sends for this pay_period_end,
//   2. the period actually has at least one punch at all, and
//   3. every punch in office_clock_punches for this period is 'confirmed' —
//      zero rows with paycor_status in ('unsent', 'pending', 'failed').
//
// This replaces the old time-based `isPeriodLocked` (a Tuesday-night
// deadline, src/office-clock-period-math.mjs): the user explicitly does not
// want an automatic cutoff — they want to review and send a period whenever
// they're ready — but still wants a safety rail once a period has actually
// gone to Paycor, since there is no delete/update endpoint for a punch
// Paycor already has (CreatePunches is create-only; confirmed via this
// build's own Controlled Test).
//
// If a send was triggered but some punches are still unsent/pending/failed,
// the period stays OPEN so IT can fix the problem and resend — that's
// exactly the workflow this feature exists for. Condition 2 is its own
// explicit guard (not left to fall out of condition 3's vacuous truth on an
// empty set): office-clock-send-background.mjs happily writes a
// `status: 'done', total: 0` sends-table row even when a send is triggered on
// a period with zero punches, so condition 1 alone is NOT enough to rule out
// an empty period — condition 2 requires a real punch to exist before a
// period can ever be called finalized.
//
// Exported so office-clock-send-background.mjs's own I1 lock check (added in
// the final review's fix wave) calls this exact same function rather than a
// second copy of this logic — same sharing pattern as `ensureActivityTypes`
// above, which that file already imports from here.
export async function isPeriodFinalized(db, periodEnd) {
  await ensureTables(db);
  const sent = await db`SELECT 1 FROM office_clock_pay_period_sends WHERE pay_period_end = ${periodEnd} LIMIT 1`;
  if (!sent.length) return false;
  const anyPunches = await db`SELECT 1 FROM office_clock_punches WHERE pay_period_end = ${periodEnd} LIMIT 1`;
  if (!anyPunches.length) return false;
  const outstanding = await db`
    SELECT 1 FROM office_clock_punches
    WHERE pay_period_end = ${periodEnd} AND paycor_status IN ('unsent', 'pending', 'failed')
    LIMIT 1`;
  return outstanding.length === 0;
}

// office_clock_punches rows come back snake_case from Postgres; the pure
// helpers in office-clock-lib.mjs (findIncompleteDays, punchStatusAndActivity)
// expect camelCase { punchType, capturedAt }. This maps every field this file
// reads/returns, in one place, rather than leaving ad hoc snake_case reads
// scattered through the action handlers below. `pay_period_end` (and
// `captured_at`) are normalized to plain strings here too — the neon driver
// parses Postgres `date`/`timestamptz` columns into native JS Date objects
// (same root cause Task 5's review caught in office-clock-punch.mjs), and
// Task 6 compares/groups by payPeriodEnd as a string throughout.
function rowToPunch(r) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.name ?? undefined,
    paycorEmployeeId: r.paycor_employee_id ?? undefined,
    paycorDepartmentId: r.paycor_department_id ?? undefined,
    punchType: r.punch_type,
    capturedAt: new Date(r.captured_at).toISOString(),
    payPeriodEnd: new Date(r.pay_period_end).toISOString().slice(0, 10),
    source: r.source,
    editedBy: r.edited_by ?? undefined,
    paycorStatus: r.paycor_status,
    paycorTrackingId: r.paycor_tracking_id ?? undefined,
    paycorPunchId: r.paycor_punch_id ?? undefined,
    note: r.note ?? undefined,
  };
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const db = sql();
    await ensureTables(db);

    // Whole-handler role gate — every action here is IT/exec review of every
    // office_staff user's pay data, same shape as office-clock-roster.mjs's
    // exec/it check (Task 4) and paycor.mjs's createPunches check (Task 1).
    const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
    if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
      return json(403, { error: 'forbidden' });
    }

    let payload;
    try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
    const { action } = payload || {};

    if (action === 'period') {
      const { periodEnd } = payload;
      if (!periodEnd) return json(400, { error: 'Missing periodEnd' });

      const rows = await db`
        SELECT cp.*, u.name, u.paycor_employee_id, u.paycor_department_id
        FROM office_clock_punches cp
        JOIN users u ON u.id = cp.user_id
        WHERE cp.pay_period_end = ${periodEnd}
        ORDER BY u.name, cp.captured_at`;
      const punches = rows.map(rowToPunch);

      // Group by employee and run findIncompleteDays per employee — it's
      // defined over one person's punch sequence, not the whole period mixed
      // together, and expects the camelCase { punchType, capturedAt } shape.
      const byUser = new Map();
      for (const p of punches) {
        if (!byUser.has(p.userId)) byUser.set(p.userId, { userName: p.userName, punches: [] });
        byUser.get(p.userId).punches.push({ punchType: p.punchType, capturedAt: p.capturedAt });
      }
      const incompleteDays = [];
      for (const [userId, { userName, punches: userPunches }] of byUser) {
        for (const issue of findIncompleteDays(userPunches)) {
          incompleteDays.push({ userId, userName, ...issue });
        }
      }

      return json(200, {
        locked: await isPeriodFinalized(db, periodEnd),
        punches,
        incompleteDays,
      });
    }

    if (action === 'edit') {
      const { periodEnd, punchId, userId, punchType, capturedAt, note } = payload;
      if (!periodEnd) return json(400, { error: 'Missing periodEnd' });

      if (!punchId) {
        // Inserting a brand-new punch (e.g. IT adding a missed clock-out)
        // still needs the full set of fields.
        if (!userId || !punchType || !capturedAt) {
          return json(400, { error: 'Missing userId, punchType, or capturedAt' });
        }
      }
      if (punchType && !PUNCH_TYPES.has(punchType)) {
        return json(400, { error: `Invalid punchType: ${punchType}` });
      }

      const editedBy = authedUser.username;
      const editNote = `edited by ${editedBy} at ${new Date().toISOString()}${note ? ` — ${note}` : ''}`;

      let row;
      if (punchId) {
        // Load the row's own current state first — the already-sent check,
        // the lock check, and the period-consistency check below all have to
        // run against what THIS ROW actually is, never against whatever the
        // request payload merely claims. Zero DB mutation happens until every
        // one of these passes.
        const existingRows = await db`SELECT * FROM office_clock_punches WHERE id = ${punchId}`;
        const existing = existingRows[0];
        if (!existing) return json(404, { error: 'Punch not found' });

        // C2 — editing a punch already accepted by (or mid-send to) Paycor
        // would save here but never actually reach Paycor: the background
        // sender only ever claims paycor_status = 'unsent' rows, so this edit
        // would silently diverge from the real payroll record while the UI
        // reports success. There is no way to un-send a punch from here.
        if (existing.paycor_status === 'pending' || existing.paycor_status === 'confirmed') {
          return json(409, { error: "This punch has already been sent to Paycor — correct it directly in Paycor's own timecard editor instead; there is no way to un-send a punch from this screen" });
        }

        // I2 — finalized check against the ROW's own stored pay_period_end,
        // never the payload's periodEnd. Otherwise a caller could submit a
        // finalized punch's real id alongside an unrelated, still-open
        // periodEnd and slip past the check entirely.
        const existingPeriodEnd = new Date(existing.pay_period_end).toISOString().slice(0, 10);
        if (await isPeriodFinalized(db, existingPeriodEnd)) return json(409, { error: 'Pay period is finalized — it has already been fully sent to and confirmed by Paycor' });

        // I3 — when capturedAt is changing, the new pay_period_end is derived
        // server-side from that timestamp's own ET calendar date (never
        // trusted straight off the payload's periodEnd) and must match the
        // period the admin is actually editing from. Otherwise this could
        // file a punch under a period that doesn't actually contain its own
        // timestamp, where no future `period` view would ever find it again.
        let newPayPeriodEnd = existingPeriodEnd;
        if (capturedAt) {
          newPayPeriodEnd = payPeriodEndFor(etDateStr(new Date(capturedAt)));
          if (newPayPeriodEnd !== periodEnd) {
            return json(400, { error: `That time falls in the pay period ending ${newPayPeriodEnd}, not ${periodEnd} — edit it from that period instead` });
          }
        }

        [row] = await db`
          UPDATE office_clock_punches
          SET punch_type = COALESCE(${punchType || null}, punch_type),
              captured_at = COALESCE(${capturedAt || null}, captured_at),
              pay_period_end = ${newPayPeriodEnd},
              source = 'manual_edit',
              edited_by = ${editedBy},
              note = ${editNote}
          WHERE id = ${punchId}
          RETURNING *`;
      } else {
        // New punch — same finalized check as before (there's no existing row
        // to key it off of), plus the same server-derived-period check as the
        // edit path above (I3): pay_period_end comes from capturedAt's own ET
        // calendar date, not straight from the payload's periodEnd.
        if (await isPeriodFinalized(db, periodEnd)) return json(409, { error: 'Pay period is finalized — it has already been fully sent to and confirmed by Paycor' });
        const newPayPeriodEnd = payPeriodEndFor(etDateStr(new Date(capturedAt)));
        if (newPayPeriodEnd !== periodEnd) {
          return json(400, { error: `That time falls in the pay period ending ${newPayPeriodEnd}, not ${periodEnd} — add it from that period instead` });
        }
        [row] = await db`
          INSERT INTO office_clock_punches (user_id, punch_type, captured_at, pay_period_end, source, edited_by, note, paycor_status)
          VALUES (${userId}, ${punchType}, ${capturedAt}, ${newPayPeriodEnd}, 'manual_edit', ${editedBy}, ${editNote}, 'unsent')
          RETURNING *`;
      }
      return json(200, { ok: true, punch: rowToPunch(row) });
    }

    if (action === 'send') {
      const { periodEnd } = payload;
      if (!periodEnd) return json(400, { error: 'Missing periodEnd' });
      // 409, zero override path — a period can be sent more than once while
      // still open (each attempt gets its own audit row below; this is how
      // IT fixes a partial/failed send and resends), but never once it's
      // fully finalized.
      if (await isPeriodFinalized(db, periodEnd)) return json(409, { error: 'Pay period is finalized — it has already been fully sent to and confirmed by Paycor' });

      await db`INSERT INTO office_clock_pay_period_sends (pay_period_end, sent_by) VALUES (${periodEnd}, ${authedUser.username})`;

      // Fire-and-forget POST to the 15-min background function, matching this
      // codebase's established *-background pattern for anything past the 26s
      // manual-invocation timeout (see labor-cron.mjs:1376's identical
      // dispatch-and-don't-await-the-body shape). sendStatus then polls the
      // result blob the background function writes.
      //
      // Forward the triggering admin's own Authorization header (or, absent
      // that, the pcg_session cookie — require-user.js's own `bearer()`
      // accepts either) so office-clock-send-background.mjs can run its own
      // requireActiveUser check against this exact caller before it writes
      // anything to Paycor. This is the one piece of real auth this endpoint
      // needs: office-clock-send-background.mjs's URL takes only
      // `{ periodEnd }`, which is trivially derivable
      // (payPeriodEndFor(today) off a published anchor date), so without this
      // forward, anyone who reaches that URL directly could push a whole pay
      // period to Paycor without ever going through this file's review/edit
      // gate. No new auth mechanism — just reusing the real inbound request's
      // own already-verified credential one call further.
      const inboundAuth = request.headers.get('authorization');
      const inboundCookie = request.headers.get('cookie');
      const forwardHeaders = { 'Content-Type': 'application/json' };
      if (inboundAuth) forwardHeaders['Authorization'] = inboundAuth;
      if (inboundCookie) forwardHeaders['Cookie'] = inboundCookie;

      const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://pcg-ops.netlify.app';
      fetch(`${base}/.netlify/functions/office-clock-send-background`, {
        method: 'POST',
        headers: forwardHeaders,
        body: JSON.stringify({ periodEnd }),
      }).catch(() => {});

      return json(200, { started: true });
    }

    if (action === 'sendStatus') {
      const { periodEnd } = payload;
      if (!periodEnd) return json(400, { error: 'Missing periodEnd' });
      let raw;
      try { raw = await getBlobStore().get(`pcg_office_clock_send_${periodEnd}`, { type: 'json' }); }
      catch { raw = null; }
      if (!raw) return json(200, { status: 'not_started' });
      return json(200, raw.data !== undefined ? raw.data : raw);
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
