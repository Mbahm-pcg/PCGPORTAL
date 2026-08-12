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
export const config = { schedule: '0 11 * * *' }; // 7am ET

import { STORES, fetchStoreCrew, saveDaySnapshot, getBlobStore, etDate } from './tips-report-cron-background.mjs';

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

export default async (request) => {
  const invocationStart = Date.now();
  const busDt = etDate(1); // same day the 3am report just covered

  try {
    const existing = await loadDaySnapshotUncached(busDt);
    if (!Array.isArray(existing)) {
      console.log(`[tips-morning-sweep] No snapshot found for ${busDt} — nothing to sweep`);
      return new Response(JSON.stringify({ ok: true, busDt, message: 'no snapshot found' }), { status: 200 });
    }

    const failedPcs = new Set(existing.filter(r => r.crewStatus === 'error').map(r => String(r.pc)));
    if (failedPcs.size === 0) {
      console.log(`[tips-morning-sweep] ${busDt}: everything already ok, nothing to retry`);
      return new Response(JSON.stringify({ ok: true, busDt, retried: 0 }), { status: 200 });
    }

    console.log(`[tips-morning-sweep] ${busDt}: retrying ${failedPcs.size} failed store(s): ${[...failedPcs].join(', ')}`);

    // Same multi-pass approach as the nightly cron's own retry logic, just
    // scoped to only the stores that were still bad from last night.
    const BUDGET_MS = 11 * 60 * 1000;
    const MAX_PASSES = 6;
    const byPc = new Map(existing.map(r => [String(r.pc), r]));
    let fixedCount = 0;

    for (let pass = 1; pass <= MAX_PASSES; pass++) {
      const remaining = [...failedPcs].filter(pc => byPc.get(pc)?.crewStatus === 'error');
      if (remaining.length === 0) break;
      if (Date.now() - invocationStart > BUDGET_MS) {
        console.warn(`[tips-morning-sweep] Pass ${pass}: time budget hit — ${remaining.length} store(s) still failing`);
        break;
      }
      for (const pc of remaining) {
        if (Date.now() - invocationStart > BUDGET_MS) break;
        const store = STORES.find(s => String(s.pc) === pc);
        if (!store) continue;
        const { crew, crewStatus } = await fetchStoreCrew(store, busDt);
        if (crewStatus === 'ok') fixedCount++;
        byPc.set(pc, { ...byPc.get(pc), crew, crewStatus });
      }
    }

    const finalResults = existing.map(r => byPc.get(String(r.pc)) || r);
    await saveDaySnapshot(busDt, finalResults);

    const stillBad = finalResults.filter(r => r.crewStatus === 'error').map(r => r.name);
    const summary = { ok: true, busDt, retried: failedPcs.size, fixed: fixedCount, stillFailing: stillBad };
    console.log('[tips-morning-sweep] done:', JSON.stringify(summary));
    return new Response(JSON.stringify(summary), { status: 200 });
  } catch (err) {
    console.error('[tips-morning-sweep] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
