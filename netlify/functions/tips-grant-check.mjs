// tips-grant-check.mjs — TEMPORARY, read-only, exec/IT-gated.
// Recomputes the biweekly (Sep 13-26, 2026) per-employee tip shares for one
// store (default: Grant, pc 310382) from already-saved daily snapshots — no
// new Paycor calls, no email sent, no other stores touched. Built to verify
// Jara Ibrahim's tip share after tips-reconcile-cron fixed a missing-punch
// gap in Grant's daily snapshots. Remove once this pay period's numbers are
// confirmed correct.
import { requireActiveUser } from './auth-lib/require-user.js';
import { neon } from '@neondatabase/serverless';
import { buildPeriodStoreResults } from './tips-report-cron-background.mjs';

const db = () => neon(process.env.NEON_DATABASE_URL);

const PERIOD_END = '2026-09-26';
const PERIOD_DAYS = 14;

export default async (request) => {
  const caller = await requireActiveUser({ headers: Object.fromEntries(request.headers.entries()) }, db());
  if (!caller || (caller.userType !== 'executive' && caller.userType !== 'it')) {
    return new Response(JSON.stringify({ error: 'Exec/IT session required.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  let pc = '310382';
  try {
    const body = await request.json();
    if (body?.pc) pc = String(body.pc);
  } catch { /* GET-style call with no body is fine — use the default */ }

  const { storeResults, missingDates } = await buildPeriodStoreResults(PERIOD_END, PERIOD_DAYS);
  const store = storeResults.find(s => String(s.pc) === pc);
  if (!store) return new Response(JSON.stringify({ error: `No results for pc ${pc}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });

  const crew = (store.crew || [])
    .map(c => ({ name: c.name, hours: Number(c.hours.toFixed(4)), share: Number(c.share.toFixed(2)) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return new Response(JSON.stringify({
    ok: true, store: store.name, pc: store.pc, status: store.status, crewStatus: store.crewStatus,
    tipPool: Number(store.tipPool.toFixed(2)), missingDates, crew,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
