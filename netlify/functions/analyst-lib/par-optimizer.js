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
    safety = DEFAULT_SAFETY,
    weeks = DEFAULT_WEEKS,
  } = opts;
  const dow = dowOf(targetDate);
  const weatherMult = 1 + (weatherImpactPct || 0) / 100;
  const totalMult = weatherMult * safety;

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

  return {
    date: targetDate,
    dow,
    weatherCondition,
    weatherImpactPct,
    safety,
    weatherMultiplier: Math.round(weatherMult * 100) / 100,
    products,
    summary: buildSummary(products, weatherImpactPct, weatherCondition),
  };
}

// One-line manager-facing rationale, e.g.:
//   "Projected +15% (rain) — set donuts to 22 dozen (264, +48 vs avg), munchkins to 430 (+50)."
function buildSummary(products, impactPct, condition) {
  const d = products.donut, m = products.munchkin;
  const swing = impactPct > 0 ? `+${impactPct}%` : `${impactPct}%`;
  const wx = condition ? ` (${condition})` : '';
  const head = impactPct ? `Projected ${swing}${wx}` : `Typical day`;
  const dPart = d ? `donuts ${d.par} (${d.parDozens} dz, ${d.deltaVsBaseline >= 0 ? '+' : ''}${d.deltaVsBaseline} vs avg)` : '';
  const mPart = m ? `munchkins ${m.par} (${m.deltaVsBaseline >= 0 ? '+' : ''}${m.deltaVsBaseline})` : '';
  return `${head} — set ${dPart}, ${mPart}.`;
}

module.exports = { computeStorePar, dowBaseline, dowHourly, confidenceOf, ROUND_UNIT, DEFAULT_SAFETY };
