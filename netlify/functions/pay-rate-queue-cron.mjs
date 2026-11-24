// pay-rate-queue-cron.mjs — sends queued pay increases to Paycor on their effective date (v23.10).
//
// The office (Roxy) completes a pay increase, presses "Update pay in Paycor" and confirms; if the
// effective date is still ahead it waits in the queue (pay_increase_forms.paycor_rate_status =
// 'queued'). On the day, this sends it — reading Paycor first, so it only writes when Paycor still
// shows the form's current pay — and tells Admin · Notifications · Pay Increase Paycor update how it
// went. Runs every 15 minutes between 7am and 9pm ET (nobody gets a text at midnight), at most 4 a
// run so it stays well inside the scheduled-function time limit; more just go 15 minutes later.
// Nothing is sent while exec / IT have "Update Paycor" switched OFF — queued ones simply wait.
import { sql } from './_shared/db.mjs';
import { runDuePayRates } from './pay-increase.mjs';

export const config = { schedule: '*/15 * * * *' };

const HOURS = { start: 7, end: 21 }; // 7:00–20:59 ET

function etHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(d)) % 24;
}

export default async () => {
  const h = etHour();
  if (h < HOURS.start || h >= HOURS.end) return new Response('outside hours');
  const db = sql();
  try {
    await db`SELECT 1 FROM pay_increase_forms LIMIT 1`;
  } catch (e) { console.log('[pay-rate-queue] table not ready yet:', e.message); return new Response('no table'); }
  try {
    const r = await runDuePayRates(db, { limit: 4 });
    if (r.held) console.log(`[pay-rate-queue] ${r.held} due but held: Update Paycor is switched OFF`);
    if (r.sent || r.problems) console.log(`[pay-rate-queue] sent ${r.sent}, problems ${r.problems}`);
    return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[pay-rate-queue]', e.message);
    return new Response('error', { status: 500 });
  }
};
