// tips-report-morning-sweep-background.mjs — Runs a few hours after the nightly tips
// report (7am ET, vs. the main report's 3am ET), rechecking whatever's still
// marked crewStatus:'error' in that day's saved snapshot and retrying ONLY
// those stores — not the full 46-store sweep again. Confirmed directly
// (2026-08-11/12): individually retrying failures is far more reliable than
// re-running everyone (fewer total Paycor calls per attempt means much less
// surface area for intermittent flakiness to land on), and by 7am any
// Paycor issue from a few hours earlier has often cleared on its own.
//
// Does NOT re-send the daily email — this only repairs the saved snapshot so
// the in-app Tips Report (and any later weekly/biweekly rollup, which reads
// these same snapshots) reflects the most accurate data available. A store
// still failing after this (e.g. a genuine Paycor permissions gap, not
// flakiness — confirmed on Hatboro, 2026-08-12) needs a human to look at it;
// this can't fix problems retrying doesn't fix.
//
// retryErrorDays (below) generalizes this to an arbitrary list of dates —
// added 2026-09-02 so the biweekly finalize-gate settle pass
// (tips-report-cron-background.mjs, isBiweekBoundary branch) can retry
// every crewStatus:'error' day across a whole closed pay period in one
// call, sharing a single time budget across all of them, instead of one
// date at a time. The scheduled export below is unchanged in behavior —
// it just calls retryErrorDays with a single-element date array.
export const config = { schedule: '0 11 * * *' }; // 7am ET

import { STORES, fetchStoreCrew, saveDaySnapshot, getBlobStore, etDate } from './tips-report-cron-background.mjs';
import { pickErrorEntries } from './tips-lib/period-settle.mjs';

// Deliberately NOT tips-report-cron-background.mjs's loadDaySnapshot — it
// memoizes per busDt in a module-level Map that survives across invocations
// on a warm serverless instance, which caused real data loss the last time
// this pattern was used without an uncached read (tips-report-refresh-
// background.mjs, 2026-08-11 — see that file's history). Always read fresh.
async function loadDaySnapshotUncached(busDt) {
  try {
    const raw = await getBlobStore().get(`pcg_tips_snapshot_${busDt}`, { type: 'json' });
    return raw?.data || null;
  } catch { return null; }
}

// Retries every crewStatus:'error' entry across `dates`, sharing one time
// budget and up to `maxPasses` bounded passes across the whole set (not
// per-date) — a store healed in pass 1 isn't retried again in pass 2.
// Persists each touched date once, after all passes finish.
export async function retryErrorDays(dates, opts = {}) {
  const budgetMs = opts.budgetMs ?? 11 * 60 * 1000;
  const maxPasses = opts.maxPasses ?? 6;
  const invocationStart = Date.now();

  const snapshotByDate = new Map();
  for (const busDt of dates) {
    const arr = await loadDaySnapshotUncached(busDt);
    if (Array.isArray(arr)) snapshotByDate.set(busDt, arr);
  }

  let remaining = pickErrorEntries(dates, snapshotByDate);
  let healedCount = 0;
  let skippedForBudget = false;

  for (let pass = 1; pass <= maxPasses && remaining.length > 0; pass++) {
    if (Date.now() - invocationStart > budgetMs) { skippedForBudget = true; break; }
    for (const { pc, busDt } of remaining) {
      if (Date.now() - invocationStart > budgetMs) { skippedForBudget = true; break; }
      const store = STORES.find(s => String(s.pc) === pc);
      if (!store) continue;
      const { crew, crewStatus } = await fetchStoreCrew(store, busDt);
      const arr = snapshotByDate.get(busDt);
      const idx = arr ? arr.findIndex(r => String(r.pc) === pc) : -1;
      if (idx >= 0) arr[idx] = { ...arr[idx], crew, crewStatus };
      if (crewStatus === 'ok') healedCount++;
    }
    remaining = pickErrorEntries(dates, snapshotByDate);
  }

  for (const busDt of dates) {
    const arr = snapshotByDate.get(busDt);
    if (arr) await saveDaySnapshot(busDt, arr);
  }

  return { healedCount, stillFailing: pickErrorEntries(dates, snapshotByDate), skippedForBudget };
}

export default async (request) => {
  const busDt = etDate(1); // same day the 3am report just covered

  try {
    const { healedCount, stillFailing, skippedForBudget } = await retryErrorDays([busDt]);
    const stillBad = stillFailing.map(({ pc }) => STORES.find(s => String(s.pc) === pc)?.name || pc);
    const summary = { ok: true, busDt, retried: healedCount + stillFailing.length, fixed: healedCount, stillFailing: stillBad, skippedForBudget };
    console.log('[tips-morning-sweep] done:', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { status: 200 });
  } catch (err) {
    console.error('[tips-morning-sweep] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
