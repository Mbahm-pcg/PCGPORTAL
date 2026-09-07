// src/system-health.mjs
// Pure system-health logic — no I/O. Single source of truth for the
// System Health dashboard, the 30-min monitor cron, and the on-demand endpoint.

/**
 * Classify one feed by the freshness of its blob's savedAt.
 * @param {number|null} savedAtMs  epoch ms of the blob's savedAt, or null if missing
 * @param {number} nowMs
 * @param {{expectedMaxAgeMin:number}} spec
 * @returns {'OK'|'STALE'|'DOWN'}
 */
export function classifyFeed(savedAtMs, nowMs, spec) {
  if (savedAtMs == null || !Number.isFinite(savedAtMs)) return 'DOWN';
  const ageMin = (nowMs - savedAtMs) / 60000;
  if (ageMin <= spec.expectedMaxAgeMin) return 'OK';
  if (ageMin <= spec.expectedMaxAgeMin * 2) return 'STALE';
  return 'DOWN';
}

/**
 * Roll feed statuses up to one overall banner colour.
 * Critical DOWN drives RED. Non-critical issues (and any STALE) cap at YELLOW.
 * @param {Array<{status:string,critical:boolean}>} feedStatuses
 * @returns {'GREEN'|'YELLOW'|'RED'}
 */
export function rollup(feedStatuses) {
  let anyCriticalDown = false;
  let anyYellow = false;
  for (const f of feedStatuses) {
    if (f.critical && f.status === 'DOWN') anyCriticalDown = true;
    else if (f.status === 'STALE' || f.status === 'DOWN') anyYellow = true;
  }
  if (anyCriticalDown) return 'RED';
  if (anyYellow) return 'YELLOW';
  return 'GREEN';
}

/**
 * Classify a per-store feed across the active store set.
 * @param {{[pc:string]: number|null}} perStoreSavedAt  savedAt ms per store pc
 * @param {number} nowMs
 * @param {{expectedMaxAgeMin:number}} spec
 * @param {string[]} activePcs
 */
export function classifyPerStore(perStoreSavedAt, nowMs, spec, activePcs) {
  const staleStores = [];
  let storesOk = 0;
  let downCount = 0;
  const total = activePcs.length;
  for (const pc of activePcs) {
    const st = classifyFeed(perStoreSavedAt[pc] ?? null, nowMs, spec);
    if (st === 'OK') storesOk++;
    else {
      staleStores.push({ pc, status: st });
      if (st === 'DOWN') downCount++;
    }
  }
  let status;
  if (total === 0) status = 'DOWN';
  else if (storesOk === total) status = 'OK';
  else if (downCount === total) status = 'DOWN';
  else status = 'STALE';
  return { status, storesOk, storesTotal: total, staleStores };
}

/**
 * Diff two snapshots, returning only feeds whose status changed.
 * A feed missing from prev is treated as previously 'OK'.
 * @param {{feeds:Array<{key:string,status:string}>}|null} prevSnapshot
 * @param {{feeds:Array<{key:string,status:string,critical?:boolean}>}} nextSnapshot
 */
export function diffForAlerts(prevSnapshot, nextSnapshot) {
  const prevMap = {};
  for (const f of (prevSnapshot?.feeds || [])) prevMap[f.key] = f.status;
  const out = [];
  for (const f of (nextSnapshot?.feeds || [])) {
    const from = prevMap[f.key] ?? 'OK';
    if (from !== f.status) out.push({ key: f.key, from, to: f.status, critical: !!f.critical });
  }
  return out;
}

// ── FEEDS registry ────────────────────────────────────────────────────────
// expectedMaxAgeMin derives from each cron's schedule with a tolerance multiple.
export const FEEDS = [
  // Sales
  { key: 'pulse-sales', label: 'Pulse Sales (daily notify)', blobKey: 'pcg_pulse_notify_last_run',
    expectedMaxAgeMin: 1560, perStore: false, critical: true, category: 'Sales' }, // daily 9pm ET, 26h tol
  { key: 'pulse-hourly', label: 'Pulse Hourly Snapshot', blobKey: 'pcg_hourly_history_',
    expectedMaxAgeMin: 1560, perStore: true, critical: true, category: 'Sales' }, // daily snapshot per store
  // Labor
  { key: 'labor', label: 'Labor (network)', blobKey: 'pcg_labor_v1',
    expectedMaxAgeMin: 420, perStore: false, critical: true, category: 'Labor' }, // labor-cron has a ~6h overnight gap (schedule 0 9-23,0-3 UTC); 420 clears it so no nightly false alarms. Token death is caught immediately via the recordHealth heartbeat regardless of this window.
  { key: 'labor-store', label: 'Labor (per-store history)', blobKey: 'pcg_labor_store_',
    expectedMaxAgeMin: 420, perStore: true, critical: true, category: 'Labor' }, // see labor: 420 clears the overnight gap
  { key: 'schedule-alerts', label: 'Labor Schedule Alerts', blobKey: 'pcg_schedule_alerts_v1',
    expectedMaxAgeMin: 5760, perStore: false, critical: false, category: 'Labor' }, // Mon/Thu, 4d tol
  // Cash
  { key: 'tips', label: 'Tips Report', blobKey: 'pcg_tips_report_last_run',
    expectedMaxAgeMin: 1680, perStore: false, critical: true, category: 'Cash' }, // daily 7am ET, 28h tol
  { key: 'pnl-live', label: 'P&L (live)', blobKey: 'pcg_pnl_live_v1',
    expectedMaxAgeMin: 420, perStore: false, critical: true, category: 'Cash' }, // written by labor-cron (same ~6h overnight gap); 420 clears it
  { key: 'pnl-store', label: 'P&L (per-store)', blobKey: 'pcg_pnl_store_',
    expectedMaxAgeMin: 420, perStore: true, critical: true, category: 'Cash' }, // per-store P&L; active set scoped to stores with a P&L blob (see cron/endpoint activePcsByKey)
  // Comms / AI / Platform (non-critical)
  { key: 'reviews', label: 'Google Reviews', blobKey: 'pcg_reviews_network',
    expectedMaxAgeMin: 11520, perStore: false, critical: false, category: 'Comms' }, // weekly, 8d tol
  { key: 'analyst', label: 'Orion Analyst (DM scorecard)', blobKey: 'pcg_dm_scorecard',
    expectedMaxAgeMin: 1560, perStore: false, critical: false, category: 'AI' }, // twice daily
  { key: 'weather', label: 'Weather Forecast', blobKey: 'pcg_weather_forecast',
    expectedMaxAgeMin: 1560, perStore: false, critical: false, category: 'Platform' }, // daily 8am ET
];

/**
 * Build a full snapshot by reading each feed's blob freshness via an injected
 * async reader (kept injectable so this stays pure and unit-testable).
 * @param {{ readSavedAt:(key:string)=>Promise<number|null>, activePcs?:string[], activePcsByKey?:object, nowMs:number, beats?:object }} args
 */
export async function buildSnapshot({ readSavedAt, activePcs = [], activePcsByKey = {}, nowMs, beats = {} }) {
  const feeds = [];
  for (const spec of FEEDS) {
    let entry;
    try {
      if (spec.perStore) {
        const pcs = activePcsByKey[spec.key] || activePcs;
        const perStoreSavedAt = {};
        for (const pc of pcs) perStoreSavedAt[pc] = await readSavedAt(spec.blobKey + pc);
        const r = classifyPerStore(perStoreSavedAt, nowMs, spec, pcs);
        entry = { key: spec.key, label: spec.label, category: spec.category, critical: spec.critical, perStore: true, ...r };
      } else {
        const savedAt = await readSavedAt(spec.blobKey);
        entry = { key: spec.key, label: spec.label, category: spec.category, critical: spec.critical, perStore: false,
          status: classifyFeed(savedAt, nowMs, spec), savedAt };
      }
    } catch (e) {
      entry = { key: spec.key, label: spec.label, category: spec.category, critical: spec.critical,
        perStore: !!spec.perStore, status: 'DOWN', error: String(e?.message || e) };
    }
    const b = beats[spec.key];
    if (b) {
      entry.beat = b;
      if (b.ok === false && entry.status === 'OK') entry.status = 'STALE';
      entry.error = entry.error || b.error || null;
    }
    feeds.push(entry);
  }
  const overall = rollup(feeds.map(f => ({ status: f.status, critical: f.critical })));
  return { overall, feeds, asOf: nowMs };
}
