// Manual backfill for a single date's tips snapshot — for when the nightly
// tips-report-cron-background run failed/timed out for a specific day and
// nobody caught it. That function itself already supports POST {busDt} for
// exactly this, but it declares config.schedule, and Netlify's edge blocks
// ALL direct external POSTs to any scheduled function (same issue already
// solved for labor-cron.mjs / labor-refresh.mjs) — so this unscheduled sibling
// exists purely to make that manual path reachable. Reuses the exact same
// Phase 1 (Pulse tips) + Phase 2 (Paycor punches) logic via shared exports;
// does NOT send the daily/weekly/biweekly email — this only rebuilds and
// saves the one day's pcg_tips_snapshot_{busDt} blob so it's available to the
// nightly cron's own weekly/biweekly rollups and to the in-app Tips Report.
import { STORES, APIS, callUpstream, callPaycorProxy, fetchStoreCrew, toET, saveDaySnapshot, getBlobStore, dateRangeEndingAt } from './tips-report-cron-background.mjs';

// Deliberately NOT using tips-report-cron-background.mjs's loadDaySnapshot —
// it memoizes per busDt in a module-level Map that survives across
// invocations on a warm serverless instance. Confirmed directly (2026-08-11):
// firing several single-store targeted backfills back-to-back hit the same
// warm instance, so a later store's merge read a STALE cached copy of the
// snapshot from before an earlier store's fix had been saved, and silently
// overwrote that earlier fix with the old (bad) data. The targeted-merge path
// below must always see the true latest blob, so it reads uncached.
async function loadDaySnapshotUncached(busDt) {
  try {
    const raw = await getBlobStore().get(`pcg_tips_snapshot_${busDt}`, { type: 'json' });
    return raw?.data || null;
  } catch { return null; }
}

// 46 stores sequential (Phase 2) takes minutes — well past Netlify's ~26s
// synchronous function limit. Must be a background function (202 immediately,
// no body); caller polls pcg_tips_snapshot_{busDt} via storage.mjs afterward.
export const config = { background: true };

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const body = await request.json().catch(() => ({}));
  const busDt = body?.busDt;
  if (!busDt || !/^\d{4}-\d{2}-\d{2}$/.test(busDt)) {
    return new Response(JSON.stringify({ error: 'busDt required, format YYYY-MM-DD' }), { status: 400, headers });
  }

  // Optional: re-check just ONE store instead of all 46. Re-running everyone
  // every time risks a fresh Paycor hiccup corrupting stores that were already
  // fine in the last saved snapshot — merging one store's fresh result into
  // the existing snapshot leaves every other store untouched.
  const targetPc = body?.storePc ? String(body.storePc) : null;
  const targetStores = targetPc ? STORES.filter(s => String(s.pc) === targetPc) : STORES;
  if (targetPc && targetStores.length === 0) {
    return new Response(JSON.stringify({ error: `No store with pc ${targetPc}` }), { status: 400, headers });
  }

  console.log(`[tips-report-refresh] backfilling ${busDt} across ${targetStores.length} store(s)${targetPc ? ` (targeted: ${targetStores[0].name})` : ''}`);
  const invocationStart = Date.now();
  const storeResults = new Array(targetStores.length);

  // Phase 1: Pulse tip totals — batched, no shared auth state.
  const BATCH = 6;
  for (let i = 0; i < targetStores.length; i += BATCH) {
    const batch = targetStores.slice(i, i + BATCH);
    await Promise.all(batch.map(async (s, j) => {
      const idx = i + j;
      const cfg = APIS[s.pc === '345986' ? 'p227' : 'p228'];
      let rows = [], tipPool = 0, checksStatus = 'error';
      try {
        const checksRaw = await callUpstream(cfg, 'getGuestChecks', { locRef: s.pc, opnBusDt: busDt, clsdGuestChecksOnly: true, include: 'guestChecks' });
        const data = JSON.parse(checksRaw || '{}');
        const checks = Array.isArray(data.guestChecks) ? data.guestChecks : [];
        rows = checks
          .filter(c => (c.tipTotal || 0) > 0)
          .map(c => ({ chkNum: c.chkNum, time: c.clsdUTC ? toET(c.clsdUTC) : (c.opnUTC ? toET(c.opnUTC) : '--'), tip: c.tipTotal }))
          .sort((a, b) => a.time.localeCompare(b.time));
        tipPool = checks.reduce((sum, c) => sum + (c.tipTotal || 0), 0);
        checksStatus = 'ok';
      } catch (err) {
        console.error(`[tips-report-refresh] ${s.name} checks error:`, err.message);
      }
      storeResults[idx] = { pc: s.pc, name: s.name, district: s.district, status: checksStatus, crewStatus: 'error', rows, tipPool, crew: [] };
    }));
  }

  // Phase 2: Paycor punches/employees — sequential, same reasoning as the
  // scheduled cron (concurrent calls race the same refresh token). Same
  // wall-clock budget guard as the scheduled cron too — if Paycor goes
  // unresponsive mid-backfill, save whatever succeeded instead of losing the
  // whole run to Netlify's 15-min background ceiling.
  // Warm-up call — same reasoning as tips-report-cron-background.mjs: store 0
  // pays the cost of a cold OAuth token fetch inside our own paycor.mjs proxy
  // that no later store has to pay, and a slow-but-legitimate cold start can
  // eat the whole 15s timeout and get misclassified as a genuine Paycor hang.
  // One throwaway call before the timed loop starts absorbs that cost outside
  // any store's own budget.
  try {
    await callPaycorProxy('employees', { legalEntityId: targetStores[0].paycor });
  } catch (err) {
    console.warn('[tips-report-refresh] Paycor warm-up call failed (continuing — store 0 just loses the head start):', err.message);
  }

  const PHASE2_BUDGET_MS = 11 * 60 * 1000;
  for (let idx = 0; idx < targetStores.length; idx++) {
    if (Date.now() - invocationStart > PHASE2_BUDGET_MS) {
      console.warn(`[tips-report-refresh] Phase 2 time budget hit at store ${idx}/${targetStores.length} (${targetStores[idx].name}) — saving what's done, skipping the rest`);
      break;
    }
    const s = targetStores[idx];
    // Uses the shared, canonical fetchStoreCrew() rather than a hand-rolled
    // copy — confirmed via audit (2026-08-20) that this file's PREVIOUS inline
    // duplicate was missing fetchStoreCrew's disguised-Paycor-error-body
    // check (a 4xx error with a Title/CorrelationId but no `records` array,
    // confirmed real at Hatboro 2026-08-12), which silently defeated the
    // same-day merge-overwrite protection below: a disguised error looked
    // exactly like crewStatus:'ok', crew:[], so the guard never fired.
    // Reusing the shared function means any future fix to it (like this one)
    // automatically applies here too, instead of silently drifting apart.
    const { crew, crewStatus } = await fetchStoreCrew(s, busDt);
    storeResults[idx].crew = crew;
    storeResults[idx].crewStatus = crewStatus;
  }

  // Targeted single-store mode merges into whatever's already saved for this
  // date instead of overwriting the whole day — every other store's existing
  // (possibly already-good) data is left untouched.
  let finalResults = storeResults;
  if (targetPc) {
    const existing = await loadDaySnapshotUncached(busDt);
    const existingArr = Array.isArray(existing) ? existing : [];
    const existingEntry = existingArr.find(s => String(s.pc) === targetPc);
    const fresh = storeResults[0];

    // Don't let a FAILED refresh attempt downgrade previously-good data on
    // EITHER side (Pulse pool or Paycor crew) — confirmed real (2026-08-20):
    // firing concurrent targeted refreshes for the same store across
    // different dates hit a transient Paycor hiccup on some of them, and
    // this merge used to unconditionally overwrite already-good data with
    // the failed result, silently erasing a correct answer that was sitting
    // right there. Each side is protected independently since a fresh
    // attempt can succeed on one side (e.g. Pulse) while failing on the
    // other (Paycor), or vice versa.
    // Beyond an outright status flip, ALSO distrust a fresh attempt that
    // reports success but came back suspiciously emptier than what's already
    // saved — confirmed real (2026-08-20): Paycor can return HTTP 200 with a
    // short/empty records array during transient lag (BJ's, Grant, Red Lion
    // all hit this), which sails through as crewStatus:'ok' with no
    // exception thrown, so a pure status-flip check never catches it. This
    // is a heuristic, not a certainty (a store's crew genuinely CAN drop to
    // zero, e.g. a closure) — erring toward keeping existing data and
    // logging loudly is the safer default for a tool whose whole job is
    // fixing data, not occasionally re-breaking it.
    let merged = fresh;
    if (existingEntry) {
      const keepOldPulse = (existingEntry.status === 'ok' && fresh.status !== 'ok')
        || ((existingEntry.rows?.length || 0) > 0 && (fresh.rows?.length || 0) === 0);
      const keepOldCrew = (existingEntry.crewStatus === 'ok' && fresh.crewStatus !== 'ok')
        || ((existingEntry.crew?.length || 0) > 0 && (fresh.crew?.length || 0) === 0);
      if (keepOldPulse || keepOldCrew) {
        merged = {
          ...fresh,
          ...(keepOldPulse ? { status: existingEntry.status, rows: existingEntry.rows, tipPool: existingEntry.tipPool } : {}),
          ...(keepOldCrew ? { crewStatus: existingEntry.crewStatus, crew: existingEntry.crew } : {}),
        };
        console.warn(`[tips-report-refresh] ${busDt}/${targetPc}: fresh refresh regressed (pulse:${keepOldPulse}, crew:${keepOldCrew}) — keeping existing good data instead of overwriting it`);
      }
    }
    finalResults = existingArr.some(s => String(s.pc) === targetPc)
      ? existingArr.map(s => String(s.pc) === targetPc ? merged : s)
      : [...existingArr, fresh];
  }

  await saveDaySnapshot(busDt, finalResults);
  const staleDate = dateRangeEndingAt(busDt, 40)[0];
  getBlobStore().delete(`pcg_tips_snapshot_${staleDate}`).catch(() => {});

  const storesWithTips = finalResults.filter(s => s.status === 'ok' && s.rows.length > 0).length;
  const grandTotal = finalResults.reduce((sum, s) => sum + s.rows.reduce((a, r) => a + r.tip, 0), 0);
  console.log(`[tips-report-refresh] done: ${busDt} — ${storesWithTips}/${finalResults.length} stores had tips, $${grandTotal.toFixed(2)} total${targetPc ? ` (targeted refresh of ${targetStores[0].name}: crewStatus=${storeResults[0].crewStatus})` : ''}`);
  return new Response(JSON.stringify({ ok: true, busDt, storesWithTips, totalStores: finalResults.length, grandTotal, targeted: targetPc ? { pc: targetPc, crewStatus: storeResults[0].crewStatus } : null }), { status: 200, headers });
};
