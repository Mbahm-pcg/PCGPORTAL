// office-clock-punch.mjs — Office Hourly Time Clock, Task 5: live punch capture.
//
// The endpoint an enabled office_staff user's phone/browser calls the instant they
// tap Clock In / Meal Start / Meal End / Clock Out. Writes straight to its own
// self-created `office_clock_punches` table — nothing here talks to Paycor at all;
// that batch-send step is Task 6 (office-clock-review.mjs / office-clock-send-
// background.mjs).
//
// Two actions only, both scoped to the calling office_staff user's own punches:
//   punch { punchType } -> { ok: true, punch: {...} }
//   today {}            -> { punches: [...] }   (today = the ET calendar day)
//
// The 409 "not linked to Paycor yet" check inside `punch` is the ONLY enablement
// gate in this whole feature — there is no boolean "enabled" flag anywhere (see
// office-clock-roster.mjs, Task 4). Being unlinked must block punching server-side,
// not just hide the tab in the UI, so it's re-checked here on every single punch
// rather than trusted from a cached/claims value.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { payPeriodEndFor } from '../../src/office-clock-lib.mjs';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: cors });

const PUNCH_TYPES = new Set(['clock_in', 'meal_start', 'meal_end', 'clock_out']);

// Self-creating table, idempotent across warm invocations — same module-level
// once-flag + `CREATE TABLE IF NOT EXISTS` shape as tickets.mjs:33-114,
// safe-audits.mjs:98-154 and incident-reports.mjs:21-66. No internal try/catch
// here either, matching all three of those: a genuine schema/connection failure
// propagates up to this file's own outer try/catch (a clean 500), the same path
// a real query failure later in the handler would take — so a DB error is never
// silently swallowed or mislabeled, just handled once, in one place.
//
// Exported (I7) so office-clock-review.mjs and office-clock-compare.mjs — the
// other two files that query office_clock_punches but never created it —
// call this exact function too, rather than a second copy of this DDL. Same
// shared-helper shape as office-clock-review.mjs's own exported
// `ensureActivityTypes`. The module-level `_ready` flag below is scoped to
// THIS module's own warm instance; each file that imports this still runs
// its own first-call CREATE TABLE IF NOT EXISTS once per cold start, which is
// cheap and idempotent either way.
let _ready = false;
export async function ensurePunchesTable(db) {
  if (_ready) return;
  await db`CREATE TABLE IF NOT EXISTS office_clock_punches (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id            integer NOT NULL,
    punch_type         text NOT NULL,
    captured_at        timestamptz NOT NULL,
    pay_period_end     date NOT NULL,
    source             text NOT NULL DEFAULT 'live',
    edited_by          text,
    paycor_status      text NOT NULL DEFAULT 'unsent',
    paycor_tracking_id text,
    paycor_punch_id    text,
    note               text,
    created_at         timestamptz NOT NULL DEFAULT now()
  )`;
  _ready = true;
}

// Shared "is this user actually linked to Paycor right now" check — fetched
// fresh from the DB every call (never trusted from the signed session token,
// which doesn't carry these fields at all — see this file's `today` action
// and app.jsx's OfficeClockTab for why). Both paycor_employee_id and
// paycor_department_id must be set; a department-less link can never
// actually send a punch (see office-clock-roster.mjs's departmentId
// gating, I6).
async function isLinkedToPaycor(db, userId) {
  const rows = await db`SELECT paycor_employee_id, paycor_department_id FROM users WHERE id = ${userId}`;
  const link = rows[0];
  return !!(link && link.paycor_employee_id && link.paycor_department_id);
}

// The ET (America/New_York) calendar date of a UTC instant, as a
// "YYYY-MM-DD" string — the same idiom office-clock-compare.mjs's etDayOf
// already uses, reused here (not UTC's own `toISOString().slice(0,10)`) so a
// punch made after ~8pm ET is assigned to the correct pay period instead of
// silently rolling into the next UTC calendar day (I4).
function etDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function rowToPunch(r) {
  return {
    id: r.id,
    userId: r.user_id,
    punchType: r.punch_type,
    capturedAt: new Date(r.captured_at).toISOString(),
    // The neon driver parses `date` columns (OID 1082) into native JS Date
    // objects, same as timestamptz — left as-is, `payPeriodEnd` would
    // serialize as a full ISO-8601 datetime instead of the plain
    // "YYYY-MM-DD" string payPeriodEndFor() actually produces and that
    // Task 6 compares/groups by. Normalize it the same way capturedAt/
    // createdAt already are.
    payPeriodEnd: new Date(r.pay_period_end).toISOString().slice(0, 10),
    source: r.source,
    editedBy: r.edited_by ?? undefined,
    paycorStatus: r.paycor_status,
    paycorTrackingId: r.paycor_tracking_id ?? undefined,
    paycorPunchId: r.paycor_punch_id ?? undefined,
    note: r.note ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const db = sql();
    await ensurePunchesTable(db);

    // Whole-handler role gate, same shape as office-clock-roster.mjs's exec/it check
    // (Task 4) — every action in this file is this office_staff user's own punch
    // clock, so there's nothing to do here for any other role or an unauthenticated
    // caller.
    const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
    if (!authedUser || authedUser.userType !== 'office_staff') {
      return json(403, { error: 'forbidden' });
    }

    let payload;
    try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }

    const { action } = payload || {};

    if (action === 'punch') {
      const punchType = payload.punchType;
      if (!PUNCH_TYPES.has(punchType)) {
        return json(400, { error: `Invalid punchType: ${punchType}` });
      }

      // The ONLY enablement check in this whole feature. Fetched fresh per-request
      // (not trusted from the signed token) so a just-revoked link blocks the very
      // next punch, not just the next login — and this runs BEFORE any row is
      // written, so an unlinked user never gets a half-written punch.
      const linked = await isLinkedToPaycor(db, authedUser.sub);
      if (!linked) {
        return json(409, { error: 'not linked to Paycor yet — contact IT' });
      }

      // Server-generated timestamp — never trust a client-supplied capturedAt.
      // The pay period is keyed off the ET calendar date of that instant, not
      // its UTC date (I4) — otherwise a punch after ~8pm ET would be filed
      // under the NEXT pay period, two weeks later than it actually belongs.
      const capturedAt = new Date();
      const payPeriodEnd = payPeriodEndFor(etDateStr(capturedAt));

      const [row] = await db`
        INSERT INTO office_clock_punches (user_id, punch_type, captured_at, pay_period_end, source, paycor_status)
        VALUES (${authedUser.sub}, ${punchType}, ${capturedAt.toISOString()}, ${payPeriodEnd}, 'live', 'unsent')
        RETURNING *`;

      return json(200, { ok: true, punch: rowToPunch(row) });
    }

    if (action === 'today') {
      // Returns `linked` alongside today's punches (C1) — this is a fresh DB
      // read of the session user's own paycor_employee_id/paycor_department_id,
      // the same check `punch` above performs, NOT derived from the session
      // user object. portal-auth.mjs's `issue()`/`me` action never puts these
      // fields on the signed token at all (only users.mjs's own projection,
      // used by the admin screens, carries them) — so a client that tried to
      // derive "linked" from `user?.paycorEmployeeId` would see "not set up"
      // forever, even for a correctly linked user. This also stays accurate if
      // a link is revoked mid-session, since it's re-checked on every load.
      const linked = await isLinkedToPaycor(db, authedUser.sub);

      // "Today" = the ET calendar day (America/New_York), not a UTC-day boundary,
      // which would roll over mid-afternoon for Philadelphia-based office staff.
      // Computed in SQL via the standard double `AT TIME ZONE` idiom rather than
      // hand-rolled JS offset math: `now() AT TIME ZONE 'zone'` converts the
      // current instant to ET wall-clock time (naive timestamp), date_trunc('day',
      // ...) floors it to ET midnight (still naive), and the second `AT TIME ZONE
      // 'zone'` reinterprets that naive midnight AS ET to get back the correct
      // absolute instant — DST-correct both sides via Postgres' own tz database.
      const rows = await db`
        SELECT * FROM office_clock_punches
        WHERE user_id = ${authedUser.sub}
          AND captured_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')
        ORDER BY captured_at ASC`;
      return json(200, { linked, punches: rows.map(rowToPunch) });
    }

    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
