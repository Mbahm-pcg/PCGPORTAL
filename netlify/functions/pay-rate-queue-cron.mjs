// pay-rate-queue-cron.mjs — the day a pay rate change starts (v23.10; v23.11).
//
// The office (Roxy) completes a pay rate change, presses "Update pay in Paycor" and confirms; the new
// rate goes into Paycor right then, dated on the effective date — Paycor holds it and keeps paying the
// old rate until that day (v23.11, user: "Paycor has their own queue"). On the day, this reads Paycor
// (read only) and tells Admin · Notifications · Pay Rate Change Paycor update "starts today, Paycor shows
// $16.50" — or "check Paycor" if it shows something else. It also sends anything v23.10 left queued.
// Every 15 minutes, 7am–9pm ET (nobody gets a text at midnight), at most 4 a run.
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
    if (r.started || r.checks) console.log(`[pay-rate-queue] day-of: ${r.started} confirmed in Paycor, ${r.checks} to check`);
    if (r.held) console.log(`[pay-rate-queue] ${r.held} queued but held: Update Paycor is switched OFF`);
    if (r.sent || r.problems) console.log(`[pay-rate-queue] sent ${r.sent}, problems ${r.problems}`);
    return new Response(JSON.stringify(r), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[pay-rate-queue]', e.message);
    return new Response('error', { status: 500 });
  }
};
