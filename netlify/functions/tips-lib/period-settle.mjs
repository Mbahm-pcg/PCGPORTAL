// tips-lib/period-settle.mjs — Pure decision logic for the biweekly
// finalize-gate settle pass (see docs/superpowers/specs/2026-09-02-tips-
// biweekly-finalize-gate-design.md). No network or blob I/O here — the
// orchestration that actually fetches live Paycor data and reads/writes
// snapshot blobs lives in tips-report-morning-sweep-background.mjs
// (retryErrorDays) and tips-reconcile-cron.mjs (runReconcileForDates);
// both consume these helpers so the underlying "is this store/day
// actually trustworthy" logic is tested once, here, instead of embedded
// untested inside side-effecting cron code.

// Mirrors the exact same check tips-report-cron-background.mjs's nightly
// run already uses to flag a store in its own warning email: real tip
// money collected, but nobody eligible found in Paycor that day.
export function isZeroEligibleCrewWithTips(storeEntry) {
  return storeEntry.crewStatus === 'ok'
    && Array.isArray(storeEntry.crew)
    && storeEntry.crew.length === 0
    && Number((storeEntry.tipPool || 0).toFixed(2)) > 0;
}

// tips-reconcile-cron.mjs's runReconcile/runReconcileForDates withholds an
// entire store/day's corrections (rather than silently deleting someone's
// pay) whenever a saved crew member looks dropped from a live re-fetch —
// those rows carry the literal substring "POSSIBLE DROP" in their
// `change` field. Extracting the (pc, busDt) pairs here lets the settle
// pass treat "withheld, needs manual review" as its own finalize-blocking
// reason without re-deriving reconcile's own drop-detection logic.
export function deriveWithheldSet(reconcileDetails) {
  const set = new Set();
  for (const d of reconcileDetails || []) {
    if (typeof d.change === 'string' && d.change.includes('POSSIBLE DROP')) {
      set.add(`${d.pc}|${d.busDt}`);
    }
  }
  return set;
}

// Which (pc, busDt) pairs still need a fetchStoreCrew retry — i.e. their
// saved snapshot says crewStatus:'error'. A date with no saved snapshot
// at all is skipped (nothing to retry from), not treated as an error.
export function pickErrorEntries(dates, snapshotByDate) {
  const entries = [];
  for (const busDt of dates) {
    const arr = snapshotByDate.get(busDt);
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (r.crewStatus === 'error') entries.push({ pc: String(r.pc), busDt });
    }
  }
  return entries;
}

// Per-store finalize status across a closed pay period. A store is only
// finalized when every day in periodDates has a saved snapshot entry that
// is crewStatus:'ok', is not the zero-eligible-crew-with-tips anomaly, and
// was not withheld by the reconcile pass as a possible drop.
export function computeFinalizeStatuses(stores, periodDates, snapshotsByDate, withheldSet) {
  const result = {};
  for (const store of stores) {
    const pc = String(store.pc);
    const unresolvedDays = [];
    for (const busDt of periodDates) {
      const arr = snapshotsByDate.get(busDt);
      const entry = Array.isArray(arr) ? arr.find(r => String(r.pc) === pc) : null;
      if (!entry) {
        unresolvedDays.push({ busDt, reason: 'missing-snapshot' });
        continue;
      }
      if (entry.crewStatus === 'error') {
        unresolvedDays.push({ busDt, reason: 'crew-fetch-error' });
        continue;
      }
      if (isZeroEligibleCrewWithTips(entry)) {
        unresolvedDays.push({ busDt, reason: 'zero-eligible-crew-with-tips' });
        continue;
      }
      if (withheldSet.has(`${pc}|${busDt}`)) {
        unresolvedDays.push({ busDt, reason: 'reconcile-withheld-possible-drop' });
      }
    }
    result[pc] = { finalized: unresolvedDays.length === 0, unresolvedDays };
  }
  return result;
}
