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
