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
 * Build a store's MULTI-metric weekly series from the uploaded scorecard.
 * Pulls sales (lwSale), guests (lwCC = customer count), and labor % (laborDollar
 * / lwSale × 100) for one store, shaped for beforeAfterMulti().
 *
 * @param {{weekEnd:string, stores:object[]}[]} salesWeeks
 * @param {string} pc  store pulse-cloud number
 * @returns {{weekOf:string, sales:number, guests:number|null, laborPct:number|null}[]}
 *          ascending by weekOf, weeks with sales>0 only
 */
export function weeklyMetricsFromScorecard(salesWeeks, pc) {
  return (salesWeeks || [])
    .map((w) => {
      const weekOf = isoWeekStartFromEnd(w && w.weekEnd);
      const row = w && w.stores && w.stores.find((s) => String(s.pc) === String(pc));
      const sales = row ? Number(row.lwSale) : NaN;
      if (!weekOf || !Number.isFinite(sales) || sales <= 0) return null;
      const guests = row && Number.isFinite(Number(row.lwCC)) && Number(row.lwCC) > 0 ? Number(row.lwCC) : null;
      const laborDollar = row && Number.isFinite(Number(row.laborDollar)) ? Number(row.laborDollar) : null;
      const rawLaborPct = laborDollar != null && sales > 0 ? round2((laborDollar / sales) * 100) : null;
      // Clamp: labor% > 60 on a Dunkin' store is a data error (bad paste, zero-sales week, etc.)
      const laborPct = rawLaborPct != null && rawLaborPct <= 60 ? rawLaborPct : null;
      return { weekOf, sales, guests, laborPct };
    })
    .filter(Boolean)
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf));
}

/**
 * Generalized before/after for ANY numeric metric key (e.g. 'sales', 'guests',
 * 'laborPct'). Same windowing convention as beforeAfter(): the event week is the
 * last "before" week. Rows missing/non-numeric for `key` are ignored for that metric.
 *
 * @param {object[]} weekly  records with {weekOf} + numeric [key]
 * @param {string} eventDate  ISO Monday/Sunday of the event week
 * @param {number} weeksBefore  max pre-event weeks (most recent N)
 * @param {number|null} weeksAfter  max post-event weeks; null = through now
 * @param {string} key  metric field name
 * @returns {{avgBefore:number, avgAfter:number, deltaPct:number, pointDelta:number,
 *            weeksBeforeUsed:number, weeksAfterUsed:number}}
 */
export function beforeAfterMetric(weekly, eventDate, weeksBefore, weeksAfter, key) {
  const rows = (weekly || [])
    .filter((w) => w && w.weekOf && Number.isFinite(Number(w[key])))
    .map((w) => ({ weekOf: w.weekOf, value: Number(w[key]), side: w.weekOf <= eventDate ? 'before' : 'after' }))
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf));

  const beforeAll = rows.filter((s) => s.side === 'before');
  const afterAll = rows.filter((s) => s.side === 'after');
  const beforeUsed = beforeAll.slice(Math.max(0, beforeAll.length - weeksBefore));
  const afterUsed = weeksAfter == null ? afterAll : afterAll.slice(0, weeksAfter);

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.value, 0) / arr.length : 0);
  const avgBefore = mean(beforeUsed);
  const avgAfter = mean(afterUsed);
  const has = beforeUsed.length && afterUsed.length;
  const deltaPct = has && avgBefore ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0;
  const pointDelta = has ? avgAfter - avgBefore : 0;

  return {
    avgBefore: round2(avgBefore),
    avgAfter: round2(avgAfter),
    deltaPct: round2(deltaPct),
    pointDelta: round2(pointDelta),
    weeksBeforeUsed: beforeUsed.length,
    weeksAfterUsed: afterUsed.length,
  };
}

/**
 * Run beforeAfterMetric for several keys at once.
 * @returns {Object<string, ReturnType<typeof beforeAfterMetric>>} keyed by metric
 */
export function beforeAfterMulti(weekly, eventDate, weeksBefore, weeksAfter, keys) {
  const out = {};
  (keys || []).forEach((k) => { out[k] = beforeAfterMetric(weekly, eventDate, weeksBefore, weeksAfter, k); });
  return out;
}

/**
 * Capital-project ROI: control-adjusted sales lift, labor savings, guest lift,
 * incremental annual profit, and payback period — anchored to grand opening.
 *
 * Control adjustment nets out peer movement over the same window so a remodel
 * isn't credited (or blamed) for a market-wide trend. Sales/guests adjust by
 * % change; labor adjusts by percentage-POINT change (labor% is already a ratio).
 *
 * Cost opts:
 *   cogsPct          — food cost % of sales (default 28). Used for variable cost breakdown.
 *   royaltiesPct     — Dunkin' royalty + ad fund % of sales (default 10.9).
 *   fixedCostsMonthly— rent + utilities + other (monthly $). Only subtracted for new
 *                      locations (type includes "new"); for remodels fixed costs are sunk.
 *   marginPct        — legacy single flow-through % override. When set, bypasses
 *                      cogsPct/royaltiesPct so existing callers keep the same result.
 *
 * @param {{pc:string, grandOpeningDate:string, totalBudget:number, type?:string}} project
 * @param {object[]} storeWeekly  the project store's multi-metric weekly[]
 * @param {object[][]} controlsWeekly  peer stores' multi-metric weekly[]
 * @param {{weeksBefore?:number, weeksAfter?:number|null, minWeeksAfter?:number,
 *          cogsPct?:number, royaltiesPct?:number, fixedCostsMonthly?:number,
 *          marginPct?:number}} [opts]
 * @returns {object} { status, ...inputs, metrics? }
 *          status ∈ no-date | maturing | no-baseline | ready | ready-new
 */
// Resolve a project's before/after window. END (reopen/done) walks a fallback
// chain so remodels — which carry completionDate, not grandOpeningDate — work.
// START (construction kickoff) becomes the "before" boundary so the disruption
// period between start and reopen is excluded from both averages.
const END_CHAIN = [
  ['grandOpeningDate', 'Grand opening'],
  ['dunkinCompletionDate', "Dunkin' completion"],
  ['constructionCompleteBy', 'Construction complete'],
  ['completionDate', 'Completion'],
  ['completedAt', 'Marked complete'],
];
export function resolveProjectWindow(project) {
  if (!project) return { beforeEnd: null, afterStart: null, endDate: null, startDate: null, endSource: null, hasStart: false };
  let endDate = null, endSource = null;
  for (const [k, label] of END_CHAIN) {
    if (project[k]) { endDate = String(project[k]).slice(0, 10); endSource = label; break; }
  }
  const startDate = project.startDate ? String(project.startDate).slice(0, 10) : null;
  const hasStart = !!(startDate && endDate && startDate < endDate);
  return {
    beforeEnd: hasStart ? startDate : endDate, // "before" weeks are those on/before this
    afterStart: endDate,                       // "after" weeks are those strictly after this
    endDate, startDate, endSource, hasStart,
  };
}

/**
 * Two-boundary before/after for one metric. "Before" = weeks ≤ beforeEnd (most
 * recent N). "After" = weeks > afterStart (earliest N, or all). Weeks in the gap
 * (beforeEnd, afterStart] are excluded — the construction/closure period.
 * When beforeEnd === afterStart this is identical to a single-anchor split.
 */
export function beforeAfterMetricWindow(weekly, beforeEnd, afterStart, weeksBefore, weeksAfter, key) {
  const rows = (weekly || [])
    .filter((w) => w && w.weekOf && Number.isFinite(Number(w[key])))
    .map((w) => ({ weekOf: w.weekOf, value: Number(w[key]) }))
    .sort((a, b) => a.weekOf.localeCompare(b.weekOf));

  const beforeAll = rows.filter((r) => r.weekOf <= beforeEnd);
  const afterAll = rows.filter((r) => r.weekOf > afterStart);
  const beforeUsed = beforeAll.slice(Math.max(0, beforeAll.length - weeksBefore));
  const afterUsed = weeksAfter == null ? afterAll : afterAll.slice(0, weeksAfter);

  const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x.value, 0) / arr.length : 0);
  const avgBefore = mean(beforeUsed);
  const avgAfter = mean(afterUsed);
  const has = beforeUsed.length && afterUsed.length;
  return {
    avgBefore: round2(avgBefore),
    avgAfter: round2(avgAfter),
    deltaPct: round2(has && avgBefore ? ((avgAfter - avgBefore) / avgBefore) * 100 : 0),
    pointDelta: round2(has ? avgAfter - avgBefore : 0),
    weeksBeforeUsed: beforeUsed.length,
    weeksAfterUsed: afterUsed.length,
  };
}

export function beforeAfterMultiWindow(weekly, beforeEnd, afterStart, weeksBefore, weeksAfter, keys) {
  const out = {};
  (keys || []).forEach((k) => { out[k] = beforeAfterMetricWindow(weekly, beforeEnd, afterStart, weeksBefore, weeksAfter, k); });
  return out;
}

export function computeProjectROI(project, storeWeekly, controlsWeekly, opts = {}) {
  const {
    weeksBefore = 13, weeksAfter = null, minWeeksAfter = 6,
    marginPct = null,        // legacy override: when set, skips cogsPct/royaltiesPct
    cogsPct = 28,            // food cost % of sales
    royaltiesPct = 10.9,     // Dunkin' royalty + ad fund % of sales
    fixedCostsMonthly = 0,   // rent + utilities + other (new locations only)
  } = opts;

  const win = resolveProjectWindow(project);
  // totalBudget is free-text in the form — tolerate "$250,000", "250000", etc.
  const budgetNum = project && project.totalBudget != null ? Number(String(project.totalBudget).replace(/[^0-9.]/g, '')) : NaN;
  const budget = Number.isFinite(budgetNum) && budgetNum > 0 ? budgetNum : null;
  const isNewLocation = /new/i.test(String(project?.type || ''));
  const base = {
    pc: project ? project.pc || null : null, type: project ? project.type || null : null,
    openDate: win.endDate, openSource: win.endSource, startDate: win.hasStart ? win.startDate : null,
    hasStart: win.hasStart, budget, marginPct, cogsPct, royaltiesPct, fixedCostsMonthly,
  };

  if (!win.endDate) return { ...base, status: 'no-date', metrics: null };

  const KEYS = ['sales', 'guests', 'laborPct'];
  const store = beforeAfterMultiWindow(storeWeekly, win.beforeEnd, win.afterStart, weeksBefore, weeksAfter, KEYS);
  const controls = (controlsWeekly || []).map((w) => beforeAfterMultiWindow(w, win.beforeEnd, win.afterStart, weeksBefore, weeksAfter, KEYS));

  // No pre-open weeks in our data.
  if (store.sales.weeksBeforeUsed === 0) {
    // New locations: if we have enough post-open weeks, compute absolute unit economics.
    if (isNewLocation && store.sales.weeksAfterUsed >= minWeeksAfter) {
      const fixedCostsAnnual = Math.round(fixedCostsMonthly * 12);
      const annualRevenue = Math.round(store.sales.avgAfter * 52);
      const cogsCost = Math.round(annualRevenue * cogsPct / 100);
      const royaltyCost = Math.round(annualRevenue * royaltiesPct / 100);
      const laborCost = store.laborPct.avgAfter != null
        ? Math.round(annualRevenue * store.laborPct.avgAfter / 100)
        : null;
      const annualNetProfit = annualRevenue - cogsCost - royaltyCost - (laborCost ?? 0) - fixedCostsAnnual;
      let paybackYears = null, paybackMonths = null;
      if (budget != null && annualNetProfit > 0) {
        paybackYears = round2(budget / annualNetProfit);
        paybackMonths = Math.round((budget / annualNetProfit) * 12);
      }
      return {
        ...base, status: 'ready-new',
        weeksAfterUsed: store.sales.weeksAfterUsed, weeksBeforeUsed: 0,
        store,
        metrics: {
          isNewStore: true,
          annualRevenue, cogsCost, royaltyCost, laborCost,
          laborPctAfter: store.laborPct.avgAfter,
          fixedCostsAnnual,
          annualNetProfit, paybackYears, paybackMonths,
          payingBack: annualNetProfit > 0,
          guestsAfter: store.guests.avgAfter,
        },
      };
    }
    return { ...base, status: 'no-baseline', weeksAfterUsed: store.sales.weeksAfterUsed, store, metrics: null };
  }

  // Average control change per metric — % for sales/guests, points for laborPct.
  const ctrlAvg = (key, field) => {
    const vals = controls.map((c) => c[key]).filter((m) => m && m.weeksAfterUsed > 0).map((m) => m[field]);
    return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : 0;
  };

  const weeksAfterUsed = store.sales.weeksAfterUsed;
  if (weeksAfterUsed < minWeeksAfter) {
    return { ...base, status: 'maturing', weeksAfterUsed, minWeeksAfter, store, metrics: null };
  }

  // Sales — control-adjusted % lift applied to the pre-opening weekly average
  const adjSalesPct = round2(store.sales.deltaPct - ctrlAvg('sales', 'deltaPct'));
  const weeklySalesLift = store.sales.avgBefore * (adjSalesPct / 100);
  const annualSalesLift = Math.round(weeklySalesLift * 52);

  // Guests — context metric, control-adjusted %
  const adjGuestsPct = round2(store.guests.deltaPct - ctrlAvg('guests', 'deltaPct'));

  // Labor — control-adjusted percentage-POINT change; negative = improved vs peers
  const adjLaborPoints = round2(store.laborPct.pointDelta - ctrlAvg('laborPct', 'pointDelta'));
  // $ saved/week = -(points/100) × post-opening weekly sales (drop in labor% saves money)
  const weeklyLaborSaved = -(adjLaborPoints / 100) * store.sales.avgAfter;
  const annualLaborSaved = Math.round(weeklyLaborSaved * 52);

  // Incremental profit: when marginPct is explicitly set use it (legacy callers);
  // otherwise break out COGS and royalties explicitly for a transparent P&L.
  let incrementalAnnualProfit, cogsCostOnLift, royaltyCostOnLift, contributionOnLift;
  if (marginPct !== null) {
    incrementalAnnualProfit = Math.round(annualSalesLift * (marginPct / 100) + annualLaborSaved);
    cogsCostOnLift = null; royaltyCostOnLift = null; contributionOnLift = null;
  } else {
    cogsCostOnLift = Math.round(annualSalesLift * cogsPct / 100);
    royaltyCostOnLift = Math.round(annualSalesLift * royaltiesPct / 100);
    contributionOnLift = annualSalesLift - cogsCostOnLift - royaltyCostOnLift;
    incrementalAnnualProfit = Math.round(contributionOnLift + annualLaborSaved);
  }

  let paybackYears = null, paybackMonths = null;
  if (budget != null && incrementalAnnualProfit > 0) {
    paybackYears = round2(budget / incrementalAnnualProfit);
    paybackMonths = Math.round((budget / incrementalAnnualProfit) * 12);
  }

  return {
    ...base,
    status: 'ready',
    weeksAfterUsed,
    weeksBeforeUsed: store.sales.weeksBeforeUsed,
    store,
    metrics: {
      adjSalesPct, annualSalesLift,
      cogsCostOnLift, royaltyCostOnLift, contributionOnLift,
      adjGuestsPct, guestsBefore: store.guests.avgBefore, guestsAfter: store.guests.avgAfter,
      adjLaborPoints, laborPctBefore: store.laborPct.avgBefore, laborPctAfter: store.laborPct.avgAfter, annualLaborSaved,
      incrementalAnnualProfit, paybackYears, paybackMonths,
      payingBack: incrementalAnnualProfit > 0,
    },
  };
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
