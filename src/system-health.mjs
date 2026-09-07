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
