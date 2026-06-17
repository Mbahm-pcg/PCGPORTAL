// impact-math.js — CommonJS port of the pure impact-analysis helpers from
// src/impact.mjs, for use in Netlify functions (competitor.js). Keep the math
// in sync with src/impact.mjs (the ImpactRadar UI uses the ESM original).
const EARTH_RADIUS_MI = 3958.7613;

/** Great-circle distance between two {lat,lng} points, in miles. */
function haversineMiles(a, b) {
  if (!a || !b) return NaN;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Split a store's weekly net-sales series into before/after the event week.
 * Event week (weekOf === eventDate) counts as the LAST "before" week.
 * @param {{weekOf:string, sales:number}[]} weekly
 * @param {string} eventDate ISO 'YYYY-MM-DD'
 * @param {number} weeksBefore  max pre-event weeks to average (most recent N)
 * @param {number|null} weeksAfter  max post-event weeks; null = through now
 */
function beforeAfter(weekly, eventDate, weeksBefore, weeksAfter) {
  const rows = (weekly || [])
    .filter((w) => w && w.weekOf && typeof w.sales === 'number')
    .slice()
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf));

  const series = rows.map((w) => ({ weekOf: w.weekOf, sales: w.sales, side: w.weekOf <= eventDate ? 'before' : 'after' }));
  const beforeAll = series.filter((s) => s.side === 'before');
  const afterAll = series.filter((s) => s.side === 'after');
  const beforeUsed = beforeAll.slice(Math.max(0, beforeAll.length - weeksBefore));
  const afterUsed = weeksAfter == null ? afterAll : afterAll.slice(0, weeksAfter);

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.sales, 0) / arr.length : 0);
  const avgBefore = mean(beforeUsed);
  const avgAfter = mean(afterUsed);
  const deltaPct = avgBefore && afterUsed.length ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0;
  const annualizedLoss = afterUsed.length ? (avgBefore - avgAfter) * 52 : 0;

  return {
    avgBefore: round2(avgBefore), avgAfter: round2(avgAfter), deltaPct: round2(deltaPct),
    annualizedLoss: Math.round(annualizedLoss), weeksBeforeUsed: beforeUsed.length, weeksAfterUsed: afterUsed.length,
  };
}

/**
 * Choose representative near/mid/far control stores from a distance-ranked list,
 * excluding the impacted store. Always picks nearest + farthest, evenly spread between.
 * @param {{pc:string, distance:number}[]} rankedStores
 * @param {string} impactedPc
 * @param {number} [n=3]
 */
function pickControls(rankedStores, impactedPc, n = 3) {
  const pool = (rankedStores || []).filter((s) => s && s.pc !== impactedPc).slice().sort((a, b) => a.distance - b.distance);
  if (pool.length <= n) return pool;
  if (n <= 1) return pool.slice(0, Math.max(0, n));
  const picks = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (pool.length - 1)) / (n - 1));
    picks.push(pool[idx]);
  }
  const seen = new Set();
  return picks.filter((s) => (seen.has(s.pc) ? false : seen.add(s.pc)));
}

export { haversineMiles, beforeAfter, pickControls };
