// par-optimizer.js — Par Level Optimizer (roadmap 9.2) core math.
//
// Pure, deterministic computation (no I/O) so it's auditable and unit-testable: given a
// store's donut/munchkin history (pcg_item_history_{pc}) and a forward weather signal,
// recommend how many units to have ready for a target day.
//
//   par = day-of-week unit baseline  ×  weather demand multiplier  ×  safety buffer
//
// Kept intentionally statistical (moving averages, not ML): managers must trust and
// sanity-check it, and the inputs/weights are all visible in the output.

// Round each product's par UP to a practical prep unit (donuts come in dozens).
const ROUND_UNIT = { donut: 12, munchkin: 10 };
// Default buffer above expected demand — running out costs a sale + a letdown customer,
// which is worse than modest waste, so bias slightly high. Configurable per call.
const DEFAULT_SAFETY = 1.10;
const DEFAULT_WEEKS = 8; // trailing same-weekday samples to average

const SUBS = ['donut', 'munchkin'];

function dowOf(dateStr) {
  return new Date(`${dateStr}T12:00:00`).getDay();
}

// Average daily units for a product on a given weekday, over the most recent `weeks`
// occurrences (history is stored newest-first). Also returns spread for confidence.
function dowBaseline(itemHistory, targetDow, sub, weeks = DEFAULT_WEEKS) {
  const samples = (itemHistory || [])
    .filter(e => e && e.dow === targetDow && e.bakery && e.bakery[sub])
    .slice(0, weeks)
    .map(e => e.bakery[sub].total || 0);
  if (!samples.length) return { avg: 0, samples: 0, min: 0, max: 0 };
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  return {
    avg,
    samples: samples.length,
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}

// Average per-hour curve for a product on a weekday (units/hour), for daypart prep timing
// and as the baseline Phase 2 stockout detection compares against.
function dowHourly(itemHistory, targetDow, sub, weeks = DEFAULT_WEEKS) {
  const rows = (itemHistory || [])
    .filter(e => e && e.dow === targetDow && e.bakery && e.bakery[sub])
    .slice(0, weeks);
  if (!rows.length) return {};
  const acc = {};
  for (const e of rows) {
    for (const [h, u] of Object.entries(e.bakery[sub].byHour || {})) {
      acc[h] = (acc[h] || 0) + (u || 0);
    }
  }
  const byHour = {};
  for (const [h, u] of Object.entries(acc)) byHour[h] = Math.round((u / rows.length) * 10) / 10;
  return byHour;
}

function roundUp(n, unit) {
  return Math.ceil(n / unit) * unit;
}

// Confidence from sample count + relative spread. Few samples or a wild range → "low".
function confidenceOf(base) {
  if (base.samples < 3) return 'low';
  const spread = base.avg > 0 ? (base.max - base.min) / base.avg : 0;
  if (base.samples < 5 || spread > 1.0) return 'medium';
  return 'high';
}

// Compute the recommended par for one store for one target date.
//   opts.weatherImpactPct — forward demand swing for the day (e.g. +15 / -8), from
//     pcg_weather_forecast[district].days[].impactPct. 0 = neutral / unknown.
//   opts.safety — buffer multiplier (default 1.10). opts.weeks — trailing samples.
function computeStorePar(itemHistory, opts = {}) {
  const {
    targetDate,
    weatherImpactPct = 0,
    weatherCondition = null,
    // Holiday demand swing — learned from the store's prior-year Pulse sales on the same
    // holiday (learnHolidayFactor). holidayUnknown = it IS a holiday but we couldn't learn a
    // factor (no usable prior-year data) → don't fake a lift, flag it for manual review.
    holidayFactor = 1,
    holidayName = null,
    holidayUnknown = false,
    safety = DEFAULT_SAFETY,
    weeks = DEFAULT_WEEKS,
  } = opts;
  const dow = dowOf(targetDate);
  const weatherMult = 1 + (weatherImpactPct || 0) / 100;
  const holidayMult = (holidayFactor && holidayFactor > 0) ? holidayFactor : 1;
  const totalMult = weatherMult * holidayMult * safety;

  const products = {};
  for (const sub of SUBS) {
    const base = dowBaseline(itemHistory, dow, sub, weeks);
    const recommendedUnits = Math.round(base.avg * totalMult);
    const par = roundUp(recommendedUnits, ROUND_UNIT[sub]);
    const deltaVsBaseline = par - Math.round(base.avg);
    products[sub] = {
      baselineAvg: Math.round(base.avg),
      samples: base.samples,
      recommendedUnits,
      par,
      parDozens: sub === 'donut' ? Math.round((par / 12) * 10) / 10 : null,
      deltaVsBaseline,
      confidence: confidenceOf(base),
      byHour: dowHourly(itemHistory, dow, sub, weeks),
    };
  }

  const totalSwingPct = Math.round((weatherMult * holidayMult - 1) * 100);
  return {
    date: targetDate,
    dow,
    weatherCondition,
    weatherImpactPct,
    holidayName,
    holidayFactor: Math.round(holidayMult * 100) / 100,
    holidayImpactPct: Math.round((holidayMult - 1) * 100),
    holidayUnknown,
    safety,
    weatherMultiplier: Math.round(weatherMult * 100) / 100,
    totalSwingPct,
    products,
    summary: buildSummary(products, { weatherCondition, holidayName, holidayUnknown, totalSwingPct }),
  };
}

// One-line manager-facing rationale, e.g.:
//   "Projected +35% (Thanksgiving, rain) — set donuts to 26 dozen (312, +96 vs avg), munchkins to 480 (+90)."
function buildSummary(products, ctx = {}) {
  const { weatherCondition, holidayName, holidayUnknown, totalSwingPct = 0 } = ctx;
  const d = products.donut, m = products.munchkin;
  const drivers = [holidayName, weatherCondition].filter(Boolean).join(', ');
  const wx = drivers ? ` (${drivers})` : '';
  let head;
  if (holidayUnknown && holidayName) head = `${holidayName} — no prior-year data, review par manually`;
  else if (totalSwingPct) head = `Projected ${totalSwingPct > 0 ? '+' : ''}${totalSwingPct}%${wx}`;
  else head = `Typical day${wx}`;
  const dPart = d ? `donuts ${d.par} (${d.parDozens} dz, ${d.deltaVsBaseline >= 0 ? '+' : ''}${d.deltaVsBaseline} vs avg)` : '';
  const mPart = m ? `munchkins ${m.par} (${m.deltaVsBaseline >= 0 ? '+' : ''}${m.deltaVsBaseline})` : '';
  return `${head} — set ${dPart}, ${mPart}.`;
}

export { computeStorePar, dowBaseline, dowHourly, confidenceOf, ROUND_UNIT, DEFAULT_SAFETY };
