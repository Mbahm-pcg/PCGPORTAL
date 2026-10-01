// office-clock-compare.mjs — Office Hourly Time Clock, Task 7: Paycor
// comparison / validation view (exec/it only).
//
// Read-only confidence check: for every account linked to Paycor
// (paycor_employee_id AND paycor_department_id both set, same "linked" test
// as office-clock-punch.mjs's enablement gate and office-clock-review.mjs's
// period query), compares what we wrote to our own office_clock_punches
// table against what Paycor's own employeePunches read endpoint reports for
// the same employee over the same date range, and flags any day where the
// two counts disagree. Nothing here writes anything, anywhere — not to
// Postgres, not to Paycor. Useful as a spot-check after the first few
// office-clock-review.mjs sends; there is no "cutover" to validate against,
// since there's no physical clock being replaced in this feature.
//
// Single action:
//   compare { startDate, endDate } (YYYY-MM-DD, inclusive both ends)
//     -> { perEmployee: [{ userId, name, appPunchCount, paycorPunchCount, mismatchDays }] }
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { callPaycor } from './paycor.mjs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// office_clock_punches.captured_at is a real UTC instant (set server-side by
// office-clock-punch.mjs via `new Date()`), bucketed here by its ET calendar
// day — the same "today = ET calendar day" convention office-clock-punch.mjs
// itself uses for its own `today` action, so this lines up with what the
// employee actually saw as "the day they punched" rather than a UTC-day
// boundary that would roll over mid-afternoon for Philadelphia-based staff.
function etDayOf(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Paycor punch records carry their timestamp as an ET wall-clock string with
// no timezone suffix (e.g. "2026-09-16T05:37:00" — confirmed against real
// Paycor responses, see src/minor-timecard-detect.mjs's `punchTime`/grouping
// comments). The date portion of that string IS already the ET calendar day,
// so it's taken directly rather than round-tripped through `new Date()`,
// which would silently reinterpret the naive string using whatever timezone
// this process happens to be running under.
function paycorDayOf(p) {
  const t = p?.punchDateTime || p?.punchIn || p?.timeIn || p?.PunchDateTime || null;
  return typeof t === 'string' && t.length >= 10 ? t.slice(0, 10) : null;
}

export default async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Max-Age': '86400' } });
  if (request.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const db = sql();

    // Whole-handler role gate, exec/it only — same shape as
    // office-clock-roster.mjs (Task 4) and office-clock-review.mjs (Task 6).
    const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
    if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
      return json(403, { error: 'forbidden' });
    }

    let payload;
    try { payload = await request.json(); } catch { return json(400, { error: 'Invalid JSON' }); }
    const { action, startDate, endDate } = payload || {};

    if (action !== 'compare') return json(400, { error: `Unknown action: ${action}` });
    if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return json(400, { error: 'Missing or invalid startDate/endDate (expected YYYY-MM-DD)' });
    }

    const linkedUsers = await db`
      SELECT id, name, paycor_employee_id
      FROM users
      WHERE paycor_employee_id IS NOT NULL AND paycor_department_id IS NOT NULL
      ORDER BY name`;

    const perEmployee = await Promise.all(linkedUsers.map(async (u) => {
      // Pulled with a one-day buffer on each side of the requested window and
      // then re-filtered after ET-day bucketing below — a straight UTC
      // `captured_at >= startDate AND < endDate+1` bound would silently drop
      // a punch made late at night ET (e.g. 11:50pm ET, which is already past
      // midnight UTC the following day) or double-count one made in the
      // small hours ET. The buffer + string-filter approach makes the ET
      // calendar day the only thing that decides inclusion, not the UTC
      // column bound.
      const appRows = await db`
        SELECT captured_at FROM office_clock_punches
        WHERE user_id = ${u.id}
          AND captured_at >= (${startDate}::date - interval '1 day')
          AND captured_at < (${endDate}::date + interval '2 days')`;

      // captured_at comes back as a native JS Date from this driver (same
      // quirk already handled in office-clock-punch.mjs/office-clock-review.mjs),
      // not a string — wrap in `new Date()` defensively either way.
      const appByDay = new Map();
      for (const r of appRows) {
        const day = etDayOf(new Date(r.captured_at));
        if (day < startDate || day > endDate) continue; // trim the buffer back off
        appByDay.set(day, (appByDay.get(day) || 0) + 1);
      }

      // Existing, unchanged Paycor read action — same call shape already used
      // by no-clockin-lib/run.mjs and minor-timecard-detect-cron-background.mjs
      // for this exact endpoint.
      let paycorRecords = [];
      let paycorError = null;
      try {
        const res = await callPaycor(`/employees/${u.paycor_employee_id}/employeePunches?startDate=${startDate}&endDate=${endDate}`);
        if (res.status >= 200 && res.status < 300) {
          paycorRecords = Array.isArray(res.data?.records) ? res.data.records
            : (Array.isArray(res.data) ? res.data : []);
        } else {
          paycorError = `Paycor HTTP ${res.status}`;
        }
      } catch (err) {
        paycorError = err.message;
      }

      const paycorByDay = new Map();
      for (const p of paycorRecords) {
        const day = paycorDayOf(p);
        if (!day || day < startDate || day > endDate) continue;
        paycorByDay.set(day, (paycorByDay.get(day) || 0) + 1);
      }

      const appPunchCount = [...appByDay.values()].reduce((a, b) => a + b, 0);
      const paycorPunchCount = [...paycorByDay.values()].reduce((a, b) => a + b, 0);

      const mismatchDays = [];
      // A failed Paycor fetch is "unknown", never "zero" — flagging every app
      // day as a mismatch in that case would misreport a Paycor outage as a
      // real data discrepancy, so mismatch detection is skipped and the
      // failure is surfaced via `paycorError` instead.
      if (!paycorError) {
        const allDays = new Set([...appByDay.keys(), ...paycorByDay.keys()]);
        for (const day of allDays) {
          const appCount = appByDay.get(day) || 0;
          const paycorCount = paycorByDay.get(day) || 0;
          if (appCount !== paycorCount) mismatchDays.push({ day, appCount, paycorCount });
        }
        mismatchDays.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      }

      const result = { userId: u.id, name: u.name, appPunchCount, paycorPunchCount, mismatchDays };
      if (paycorError) result.paycorError = paycorError;
      return result;
    }));

    return json(200, { perEmployee });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
