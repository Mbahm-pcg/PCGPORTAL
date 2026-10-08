// weekly-hours-schedule-report-manual-background.mjs — exec/IT-only manual
// trigger for weekly-hours-schedule-report-cron.mjs's report, for testing a
// specific past week without waiting for next Monday's scheduled run. Exists
// as a SEPARATE, non-schedule-registered function (same reason
// no-clockin.mjs exists alongside no-clockin-cron.mjs): once a function is
// schedule-registered in netlify.toml, Netlify refuses direct HTTP calls to
// it, so the real scheduled file can't double as its own manual-test
// endpoint.
//
// Background (not a manual 26s function) for the same reason the cron
// itself needs to be: 45 stores x punches + schedulingShifts + employees
// calls is well past the 26s budget.
//
// POST body: { weekStart?, weekEnd? } — both ISO (YYYY-MM-DD), inclusive.
// Omit both to use the same "previous Sun-Sat week" the real cron computes.
// Emails whoever's configured in Admin · Notifications · "Weekly Hours +
// Schedule" (pcg_weekly_hours_schedule_notify_v1) — this is a test of the
// real report and its real recipient list, not a preview sent elsewhere. An
// empty list means nobody gets it (logged, not an error) — add yourself
// there first if you want a test run to actually land somewhere.
import { sql } from './_shared/db.mjs';
import { requireActiveUser } from './auth-lib/require-user.js';
import { etDate } from './tips-report-cron-background.mjs';
import { runWeeklyReport } from './weekly-hours-schedule-report-cron.mjs';

export default async (request) => {
  let payload = {};
  try { payload = await request.json(); } catch { /* no body is fine — defaults apply */ }

  const db = sql();
  const authedUser = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db);
  if (!authedUser || (authedUser.userType !== 'executive' && authedUser.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
  }

  const weekStart = payload.weekStart || etDate(7);
  const weekEnd = payload.weekEnd || etDate(1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || !/^\d{4}-\d{2}-\d{2}$/.test(weekEnd) || weekEnd < weekStart) {
    return new Response(JSON.stringify({ error: 'weekStart/weekEnd must be YYYY-MM-DD, with weekEnd on or after weekStart' }), { status: 400 });
  }

  try {
    const summary = await runWeeklyReport(weekStart, weekEnd);
    console.log('[weekly-hours-schedule-report-manual] done', { by: authedUser.username, ...summary });
  } catch (err) {
    console.error('[weekly-hours-schedule-report-manual] error:', err.message);
  }
  return new Response(JSON.stringify({ ok: true, note: 'Running in the background — check email in a few minutes.' }), { status: 202 });
};
