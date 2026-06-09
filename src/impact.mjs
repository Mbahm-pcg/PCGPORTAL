// src/impact.mjs — Impact Radar math engine. Pure: no DOM, no fetch, no globals.

const EARTH_RADIUS_MI = 3958.7613; // mean Earth radius in miles

/**
 * Great-circle distance between two {lat,lng} points, in miles.
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} miles
 */
export function haversineMiles(a, b) {
  if (!a || !b) return NaN;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Split a store's weekly net-sales series into before/after the event week and
 * compute averages, % change, and annualized loss.
 *
 * Convention: the event week (weekOf === eventDate) is the LAST "before" week,
 * matching the manual 18th-St claim (competitor licensed the day after that Monday).
 *
 * @param {{weekOf:string, sales:number}[]} weekly  store's weekly[] (any order)
 * @param {string} eventDate  ISO Monday of the opening week, e.g. '2025-12-28'
 * @param {number} weeksBefore  max pre-event weeks to average (most recent N)
 * @param {number|null} weeksAfter  max post-event weeks to average; null = through now
 * @returns {{avgBefore:number, avgAfter:number, deltaPct:number, annualizedLoss:number,
 *            weeksBeforeUsed:number, weeksAfterUsed:number,
 *            series:{weekOf:string, sales:number, side:'before'|'after'}[]}}
 */
export function beforeAfter(weekly, eventDate, weeksBefore, weeksAfter) {
  const rows = (weekly || [])
    .filter((w) => w && w.weekOf && typeof w.sales === 'number')
    .slice()
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf)); // ascending by date

  const series = rows.map((w) => ({
    weekOf: w.weekOf,
    sales: w.sales,
    side: w.weekOf <= eventDate ? 'before' : 'after',
  }));

  const beforeAll = series.filter((s) => s.side === 'before');
  const afterAll = series.filter((s) => s.side === 'after');

  // before = the most recent `weeksBefore` pre-event weeks (tail of the before set)
  const beforeUsed = beforeAll.slice(Math.max(0, beforeAll.length - weeksBefore));
  // after = the earliest `weeksAfter` post-event weeks, or all when null
  const afterUsed = weeksAfter == null ? afterAll : afterAll.slice(0, weeksAfter);

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.sales, 0) / arr.length : 0);
  const avgBefore = mean(beforeUsed);
  const avgAfter = mean(afterUsed);

  const deltaPct = avgBefore && afterUsed.length ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0;
  const annualizedLoss = afterUsed.length ? (avgBefore - avgAfter) * 52 : 0;

  return {
    avgBefore: round2(avgBefore),
    avgAfter: round2(avgAfter),
    deltaPct: round2(deltaPct),
    annualizedLoss: Math.round(annualizedLoss),
    weeksBeforeUsed: beforeUsed.length,
    weeksAfterUsed: afterUsed.length,
    series,
  };
}

/**
 * Convert a scorecard week-END date (MM/DD/YYYY or MM/DD/YY) to the ISO week-START
 * date (Sunday), i.e. end − 6 days, matching the Pulse/claim "week of" convention.
 * @param {string} endStr e.g. '01/03/2026'
 * @returns {string|null} ISO 'YYYY-MM-DD' week start, or null if unparseable
 */
export function isoWeekStartFromEnd(endStr) {
  const m = String(endStr || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let y = +m[3];
  if (y < 100) y += 2000;
  const endUtc = Date.UTC(y, +m[1] - 1, +m[2]);
  return new Date(endUtc - 6 * 86400000).toISOString().slice(0, 10);
}

/**
 * Build a store's weekly net-sales series from the uploaded weekly scorecard
 * (`pcg_sales_v1` / salesWeeks). Each scorecard week is `{ weekEnd, stores:[{pc, lwSale}] }`;
 * `lwSale` is that week's net sales. Returns `{weekOf, sales}[]` shaped for beforeAfter().
 *
 * @param {{weekEnd:string, stores:{pc:string, lwSale:number}[]}[]} salesWeeks
 * @param {string} pc  store pulse-cloud number
 * @returns {{weekOf:string, sales:number}[]} ascending by weekOf, weeks with sales>0
 */
export function weeklyFromScorecard(salesWeeks, pc) {
  return (salesWeeks || [])
    .map((w) => {
      const weekOf = isoWeekStartFromEnd(w && w.weekEnd);
      const row = w && w.stores && w.stores.find((s) => String(s.pc) === String(pc));
      const sales = row ? Number(row.lwSale) : NaN;
      return weekOf && Number.isFinite(sales) && sales > 0 ? { weekOf, sales } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
}

/**
 * Choose representative near/mid/far control stores from a distance-ranked list,
 * excluding the impacted store. Picks an even spread across the available range:
 * always the nearest and farthest, then evenly-indexed picks in between.
 *
 * @param {{pc:string, distance:number}[]} rankedStores  sorted ascending by distance
 * @param {string} impactedPc  the impacted store's pc (excluded)
 * @param {number} [n=3]  number of controls to return
 * @returns {{pc:string, distance:number}[]}
 */
export function pickControls(rankedStores, impactedPc, n = 3) {
  const pool = (rankedStores || [])
    .filter((s) => s && s.pc !== impactedPc)
    .slice()
    .sort((a, b) => a.distance - b.distance);

  if (pool.length <= n) return pool;
  if (n <= 1) return pool.slice(0, Math.max(0, n));

  // Even spread across [0 .. pool.length-1], inclusive of both ends.
  const picks = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (pool.length - 1)) / (n - 1));
    picks.push(pool[idx]);
  }
  // De-dupe in case rounding collides on small pools.
  const seen = new Set();
  return picks.filter((s) => (seen.has(s.pc) ? false : seen.add(s.pc)));
}
