// case-outcomes.mjs — "did Orion's recommendation actually work?" outcome tracking.
// Orion detects anomalies and files Business Cases recommending an action, but until now
// nothing ever checked back: does the metric that triggered the case actually improve after
// someone accepts/works it? This module closes that loop — once a case has been Accepted/
// In Progress/Done for at least SETTLE_DAYS, it re-measures the SAME metric for the SAME
// store and records improved/worsened/unchanged, so Orion (and execs) can see whether its
// advice is actually working, not just whether it got acted on.
import { cacheLoad } from './analyst-cache.mjs';
import { loadCasesIndex, loadCase, recordCaseOutcome } from './analyst-cases.mjs';
import { buildKPISnapshot } from './analyst-data.mjs';

const SETTLE_DAYS = 14;      // give an accepted fix at least this long before judging it
const NOISE_BAND_PCT = 3;    // |delta%| below this = "no clear change", not improved/worsened

// Which direction counts as "improved" per anomaly type — lower-is-better metrics
// (labor%, OT count) vs higher-is-better (sales).
const METRIC_DIRECTION = {
  labor_high: 'lower', labor_watch: 'lower', overtime_spike: 'lower',
  network_labor_high: 'lower',
  sales_drop: 'higher', zero_sales: 'higher',
};

// Fetch the CURRENT value of the same metric for the same store (or network-wide).
// Returns null when there's nothing to measure against — callers must treat that as
// "unmeasurable", never as a zero/bad value.
async function fetchCurrentValue(anomalyType, storePC) {
  if (anomalyType === 'network_labor_high') {
    const snap = await buildKPISnapshot({});
    return snap?.error ? null : snap.network.laborPct;
  }
  if (!storePC) return null;

  if (anomalyType === 'labor_high' || anomalyType === 'labor_watch') {
    // Most recent COMPLETE week's labor% — settled data, not one noisy day.
    const blob = await cacheLoad(`pcg_labor_store_${storePC}`);
    const weekly = Array.isArray(blob?.weekly) ? blob.weekly : [];
    const latest = weekly.slice().sort((a, b) => (b.weekOf || '').localeCompare(a.weekOf || ''))[0];
    return latest?.laborPct ?? null;
  }
  if (anomalyType === 'overtime_spike') {
    // Only a live snapshot exists for OT count — best-effort "as of measurement day".
    const net = await cacheLoad('pcg_labor_v1');
    return net?.stores?.[storePC]?.today?.overtimeCount ?? null;
  }
  if (anomalyType === 'sales_drop' || anomalyType === 'zero_sales') {
    // Approx avg daily sales for the most recent complete week.
    const blob = await cacheLoad(`pcg_labor_store_${storePC}`);
    const weekly = Array.isArray(blob?.weekly) ? blob.weekly : [];
    const latest = weekly.slice().sort((a, b) => (b.weekOf || '').localeCompare(a.weekOf || ''))[0];
    return latest?.sales ? latest.sales / 7 : null;
  }
  return null;
}

// Classify whether the metric moved enough to call it improved/worsened, or stayed flat.
// For sales-type anomalies the meaningful yardstick is the THRESHOLD the anomaly was
// measured against (the healthy WTD daily average), not the bad day's own $ value — "improved"
// means sales are back at/above that bar, not merely "higher than the anomaly day".
function classify(anomalyType, baselineValue, currentValue, baselineThreshold) {
  const dir = METRIC_DIRECTION[anomalyType] || 'lower';
  const isSales = anomalyType === 'sales_drop' || anomalyType === 'zero_sales';
  const compareBase = isSales && typeof baselineThreshold === 'number' ? baselineThreshold : baselineValue;
  if (typeof compareBase !== 'number' || compareBase === 0 || typeof currentValue !== 'number') return { verdict: 'unmeasurable', deltaPct: null };
  const deltaPct = Math.round(((currentValue - compareBase) / Math.abs(compareBase)) * 1000) / 10;
  if (Math.abs(deltaPct) < NOISE_BAND_PCT) return { verdict: 'unchanged', deltaPct };
  const better = dir === 'lower' ? deltaPct < 0 : deltaPct > 0;
  return { verdict: better ? 'improved' : 'worsened', deltaPct };
}

// Timestamp the case first moved to Accepted/In Progress — the "clock start" for settling.
function decidedAt(caseObj) {
  const entry = (caseObj.statusHistory || []).find((h) => h.status === 'Accepted' || h.status === 'In Progress');
  return entry?.at || null;
}

/**
 * Weekly job: measure outcomes for cases that were actioned (Accepted/In Progress/Done)
 * at least SETTLE_DAYS ago and haven't been measured yet. Measures each case ONCE — this
 * is a verdict on whether the fix worked, not a running tracker, so it doesn't oscillate.
 * Bounded per run (default 30) to keep the weekly cron step cheap.
 */
async function measurePendingOutcomes({ limit = 30 } = {}) {
  const index = await loadCasesIndex();
  const cutoff = Date.now() - SETTLE_DAYS * 86400000;
  // Cap total candidates SCANNED (not just measured) — most won't pass the settle/already-
  // measured checks below, so bounding only successes could still mean loading every case
  // in the index (up to 100) every week. 2x the measure limit is enough headroom in practice.
  const candidates = index.filter((c) => ['Accepted', 'In Progress', 'Done'].includes(c.status)).slice(0, limit * 2);
  let measured = 0;
  for (const entry of candidates) {
    if (measured >= limit) break;
    let full;
    try { full = await loadCase(entry.id); } catch { continue; }
    if (!full || full.outcome) continue; // already measured
    const at = decidedAt(full);
    if (!at || new Date(at).getTime() > cutoff) continue; // not settled long enough yet
    if (!full.anomalyType || full.baselineValue == null) continue; // pre-upgrade case — nothing to measure against

    let currentValue = null;
    try { currentValue = await fetchCurrentValue(full.anomalyType, full.storePC); }
    catch (e) { console.warn(`[case-outcomes] fetch failed for ${full.id}:`, e.message); }

    const result = classify(full.anomalyType, full.baselineValue, currentValue, full.baselineThreshold);
    const outcome = {
      verdict: result.verdict, deltaPct: result.deltaPct,
      baselineValue: full.baselineValue, currentValue,
      measuredAt: new Date().toISOString(), decidedAt: at,
    };
    try { await recordCaseOutcome(full.id, outcome); measured++; }
    catch (e) { console.warn(`[case-outcomes] save failed for ${full.id}:`, e.message); }
  }
  return measured;
}

export { measurePendingOutcomes, fetchCurrentValue, classify, decidedAt };
