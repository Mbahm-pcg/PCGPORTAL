// forecast.mjs — baseline sales forecaster (v0).
// Trains on the per-store hourly history blob (pcg_hourly_history_{pc}) and
// projects a target day's sales by hour / daypart / total. Method:
//   1. same-weekday history  → per-hour median (robust to a single odd day)
//   2. recent-trend factor   → last 14 days vs full period (is the store drifting?)
//   3. weather factor (opt)   → how similar-condition days ran vs the store's norm
// Pure + dependency-light so it can run in the Orion brief, an HTTP action, or a
// manager dashboard card. Honest about confidence: thin samples → wide band.
import { cacheLoad } from './analyst-cache.mjs';

const dowFor = (d) => new Date(`${d}T12:00:00`).getDay();
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const median = (a) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const dailyTotal = (e) => (e.hours || []).reduce((s, h) => s + (h.sales || 0), 0);

/** Tomorrow (local) as YYYY-MM-DD. */
export function tomorrowISO(base = new Date()) {
  const d = new Date(base.getTime() + 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Project a single day from a store's history entries (newest-first).
 * @param entries  array of { date, hours:[{h,sales,checks}], weather, ... }
 * @param targetDate  'YYYY-MM-DD' to forecast
 * @param opts.weather  { condition } expected weather for the target day (optional)
 * @returns null if there's no matching-weekday history, else a projection object
 */
export function computeForecast(entries, targetDate, opts = {}) {
  // Never train on the day being predicted (keeps "Forecast vs Actual" honest
  // when the target day is already in history).
  const valid = (entries || []).filter((e) => e && e.date && e.date !== targetDate && Array.isArray(e.hours) && e.hours.length);
  if (valid.length < 2) return null;

  const tDow = dowFor(targetDate);
  const sameDow = valid.filter((e) => dowFor(e.date) === tDow);
  if (!sameDow.length) return null;

  // 2. recent-trend factor (bounded so a quiet/busy fortnight can't run away)
  const sorted = [...valid].sort((a, b) => (a.date < b.date ? -1 : 1));
  const allAvg = mean(sorted.map(dailyTotal));
  const recentAvg = mean(sorted.slice(-14).map(dailyTotal));
  const trend = allAvg ? clamp(recentAvg / allAvg, 0.7, 1.4) : 1;

  // 3. weather factor — only when we have an expected condition and ≥3 matching
  //    days, otherwise neutral. Compares similar-condition days to the norm.
  let weatherFactor = 1;
  const cond = opts.weather && opts.weather.condition;
  if (cond) {
    const sameCond = valid.filter((e) => e.weather && e.weather.condition === cond);
    if (sameCond.length >= 3) {
      const r = mean(sameCond.map(dailyTotal)) / (allAvg || 1);
      weatherFactor = clamp(r, 0.82, 1.18);
    }
  }
  const factor = trend * weatherFactor;

  // 1. per-hour median across same-weekday days, scaled by the factors
  const hourSet = [...new Set(sameDow.flatMap((e) => e.hours.map((h) => h.h)))].sort((a, b) => a - b);
  const hourly = hourSet.map((h) => {
    const vals = sameDow.map((e) => e.hours.find((x) => x.h === h)).filter(Boolean).map((x) => x.sales || 0);
    return { hour: h, sales: Math.round(median(vals) * factor) };
  });

  const dayTotal = hourly.reduce((s, h) => s + h.sales, 0);
  const totals = sameDow.map(dailyTotal).map((v) => v * factor);
  const low = Math.round(Math.min(...totals));
  const high = Math.round(Math.max(...totals));

  const partSum = (lo, hi) => hourly.filter((h) => h.hour >= lo && h.hour < hi).reduce((s, h) => s + h.sales, 0);
  const dayparts = { amRush: partSum(5, 9), midMorning: partSum(9, 11), lunch: partSum(11, 14), afternoon: partSum(14, 24) };

  const samples = sameDow.length;
  const confidence = samples >= 7 ? 'medium' : samples >= 4 ? 'low' : 'very-low';

  return {
    date: targetDate,
    dowLabel: DOW[tDow],
    dayTotal: Math.round(dayTotal),
    low,
    high,
    dayparts,
    hourly,
    samples,
    confidence,
    trend: Math.round(trend * 1000) / 1000,
    weatherFactor: Math.round(weatherFactor * 1000) / 1000,
    sampleDates: sameDow.map((e) => e.date).sort(),
  };
}

/**
 * Walk-forward backtest — the accuracy scoreboard. For each of the last `window`
 * completed days, re-forecast it using ONLY the days before it (no leakage) and
 * compare to what actually happened. Returns MAPE + per-day errors. Computed live
 * so it always reflects the current model on the current data — as more weeks
 * accrue, the error naturally drops and you can *see* it improve.
 */
export function backtest(entries, window = 14) {
  const valid = (entries || [])
    .filter((e) => e && e.date && Array.isArray(e.hours) && e.hours.length)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = [];
  const start = Math.max(4, valid.length - window); // need some history before the first scored day
  for (let i = start; i < valid.length; i++) {
    const target = valid[i];
    const fc = computeForecast(valid.slice(0, i), target.date, { weather: target.weather });
    if (!fc) continue;
    const actual = target.hours.reduce((s, h) => s + (h.sales || 0), 0);
    if (actual <= 0) continue;
    days.push({
      date: target.date,
      projected: fc.dayTotal,
      actual: Math.round(actual),
      absPctErr: Math.round((Math.abs(fc.dayTotal - actual) / actual) * 1000) / 10,
    });
  }
  if (!days.length) return null;
  const mape = days.reduce((s, d) => s + d.absPctErr, 0) / days.length;
  return { window: days.length, mape: Math.round(mape * 10) / 10, days };
}

/** Convenience: load a store's history blob and forecast a date (default tomorrow). */
export async function forecastStore(pc, targetDate, weather) {
  const raw = await cacheLoad(`pcg_hourly_history_${pc}`);
  const entries = Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : [];
  return computeForecast(entries, targetDate || tomorrowISO(), { weather });
}

/** Forecast + live accuracy in one blob read — used by the manager card / endpoint. */
export async function forecastStoreFull(pc, targetDate, weather, window = 14) {
  const raw = await cacheLoad(`pcg_hourly_history_${pc}`);
  const entries = Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : [];
  return {
    forecast: computeForecast(entries, targetDate || tomorrowISO(), { weather }),
    accuracy: backtest(entries, window),
  };
}

/** One-line narration for the Orion brief / store-detail bullet. */
export function forecastSentence(fc, storeName) {
  if (!fc) return null;
  const dp = fc.dayparts;
  const peak = Object.entries(dp).sort((a, b) => b[1] - a[1])[0];
  const peakLabel = { amRush: 'AM rush', midMorning: 'mid-morning', lunch: 'lunch', afternoon: 'afternoon' }[peak[0]] || peak[0];
  const conf = fc.confidence === 'medium' ? '' : ` (early estimate, ${fc.samples} ${fc.dowLabel}s)`;
  return `${storeName ? storeName + ' — ' : ''}${fc.dowLabel} forecast ~$${fc.dayTotal.toLocaleString()} (range $${fc.low.toLocaleString()}–$${fc.high.toLocaleString()}), peak ${peakLabel}${conf}.`;
}
