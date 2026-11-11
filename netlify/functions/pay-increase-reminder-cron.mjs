// pay-increase-reminder-cron.mjs — Tools · Pay Increase approval reminders (v22.65).
// While a pay increase is still waiting for approval, the approver (Admin · Notifications · Pay
// Increase approval — Mike) gets the email + text again every 3 hours until it is approved or
// sent back (user, 2026-11-10). Reminders only go out 8am–9pm Eastern; one that comes due
// overnight goes out at 8am instead of waking anyone up.
// Runs every 15 minutes, so a reminder is never more than 15 minutes late.
import { sql } from './_shared/db.mjs';
import { notifyApprovers } from './pay-increase.mjs';
import { notifyViolationApprovers, ensureNoticeTable } from './violation-notice.mjs';
import { notifyMissingHoursApprovers, ensureMissingHoursTable } from './missing-hours.mjs';

export const config = { schedule: '*/15 * * * *' };

const EVERY_HOURS = 3;
const QUIET = { start: 8, end: 21 }; // send between 8:00 and 20:59 ET

function etHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d)) % 24;
}

export default async () => {
  const h = etHour();
  if (h < QUIET.start || h >= QUIET.end) return new Response('quiet hours');
  const db = sql();
  try {
    await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS reminded_at timestamptz`;
    await db`ALTER TABLE pay_increase_forms ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0`;
  } catch (e) { console.log('[pay-increase-reminder] table not ready yet:', e.message); return new Response('no table'); }
  const due = await db`SELECT * FROM pay_increase_forms WHERE status = 'pending'
    AND COALESCE(reminded_at, created_at) <= now() - make_interval(hours => ${EVERY_HOURS}) ORDER BY created_at`;
  let sent = 0;
  for (const row of due) {
    try { await notifyApprovers(db, row, { reminder: true }); sent++; }
    catch (e) { console.error('[pay-increase-reminder]', row.id, e.message); }
  }
  if (due.length) console.log(`[pay-increase-reminder] ${sent}/${due.length} reminder(s) sent`);
  // v22.81: Violation Notices waiting for approval (Sam) get the same 3-hour reminders.
  try {
    await ensureNoticeTable(db);
    const vDue = await db`SELECT * FROM violation_notices WHERE status = 'pending'
      AND COALESCE(reminded_at, pending_at, created_at) <= now() - make_interval(hours => ${EVERY_HOURS}) ORDER BY created_at`;
    for (const row of vDue) {
      try { await notifyViolationApprovers(db, row, { reminder: true }); sent++; }
      catch (e) { console.error('[violation-reminder]', row.id, e.message); }
    }
    if (vDue.length) console.log(`[violation-reminder] ${vDue.length} violation notice reminder(s)`);
  } catch (e) { console.error('[violation-reminder]', e.message); }
  // v22.89: Missing Hours waiting for approval (Ella) — same 3-hour reminders.
  try {
    await ensureMissingHoursTable(db);
    const mDue = await db`SELECT * FROM missing_hours_forms WHERE status = 'pending' AND deleted_at IS NULL
      AND COALESCE(reminded_at, created_at) <= now() - make_interval(hours => ${EVERY_HOURS}) ORDER BY created_at`;
    for (const row of mDue) {
      try { await notifyMissingHoursApprovers(db, row, { reminder: true }); sent++; }
      catch (e) { console.error('[missing-hours-reminder]', row.id, e.message); }
    }
    if (mDue.length) console.log(`[missing-hours-reminder] ${mDue.length} reminder(s)`);
  } catch (e) { console.error('[missing-hours-reminder]', e.message); }
  return new Response(`ok ${sent}`);
};
