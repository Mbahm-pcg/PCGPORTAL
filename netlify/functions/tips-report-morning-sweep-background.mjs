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
  const datesWithErrors = new Set(remaining.map(e => e.busDt));
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
    if (!datesWithErrors.has(busDt)) continue;
    const arr = snapshotByDate.get(busDt);
    if (arr) await saveDaySnapshot(busDt, arr);
  }

  return { healedCount, stillFailing: pickErrorEntries(dates, snapshotByDate), skippedForBudget };
}

// A day with NO saved snapshot at all (not even one with crewStatus:'error' —
// genuinely never written, e.g. a night the nightly cron itself never ran or
// crashed before its first save) needs a full 46-store rebuild, not a
// per-store retry — there's nothing here to patch into. Confirmed real
// (2026-09-04): a day sat completely missing for two full days with nothing
// ever retrying it, since retryErrorDays only ever looks at days that already
// have a snapshot to inspect.
//
// Fire-and-forget: tips-report-refresh-background.mjs's full-day rebuild is a
// real multi-minute Paycor scrape, well beyond what this run should block on.
// If it doesn't fully land before this function's own next scheduled run,
// that day is still missing and gets triggered again then — this is what
// makes a genuinely-missing day keep getting retried every morning until it's
// actually filled in, instead of silently sitting broken until a human
// notices via the in-app Tips Report and re-fetches it by hand.
export async function retryMissingDays(dates) {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://pcg-ops.netlify.app';
  const triggered = [];
  for (const busDt of dates) {
    const existing = await loadDaySnapshotUncached(busDt);
    if (Array.isArray(existing)) continue; // has SOME snapshot already — retryErrorDays' concern, not this one
    triggered.push(busDt);
    fetch(`${base}/.netlify/functions/tips-report-refresh-background`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ busDt }),
    }).catch(() => {});
  }
  return { triggered };
}

export default async (request) => {
  const busDt = etDate(1); // same day the 3am report just covered

  try {
    const { healedCount, stillFailing, skippedForBudget } = await retryErrorDays([busDt]);
    const stillBad = stillFailing.map(({ pc }) => STORES.find(s => String(s.pc) === pc)?.name || pc);

    // Rolling window, not just yesterday — a completely missing day can sit
    // unnoticed for days if nobody happens to open the Tips Report. Checking
    // the last 5 keeps retrying it every morning until it lands, without
    // re-scanning the whole ~30-day retention window every single day (older
    // gaps than that are also covered by the biweekly finalize-gate settle
    // pass, which re-checks the whole closed period on its own boundary).
    const missingWindow = [1, 2, 3, 4, 5].map(n => etDate(n));
    const { triggered } = await retryMissingDays(missingWindow);

    const summary = { ok: true, busDt, retried: healedCount + stillFailing.length, fixed: healedCount, stillFailing: stillBad, skippedForBudget, missingDaysTriggered: triggered };
    console.log('[tips-morning-sweep] done:', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { status: 200 });
  } catch (err) {
    console.error('[tips-morning-sweep] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
