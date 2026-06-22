// forecast.mjs — baseline sales forecaster (v0).
// Trains on the per-store hourly history blob (pcg_hourly_history_{pc}) and
// projects a target day's sales by hour / daypart / total. Method:
//   1. same-weekday history  → per-hour median (robust to a single odd day)
//   2. recent-trend factor   → last 14 days vs full period (is the store drifting?)
//   3. weather factor (opt)   → how similar-condition days ran vs the store's norm
// Pure + dependency-light so it can run in the Orion brief, an HTTP action, or a
// manager dashboard card. Honest about confidence: thin samples → wide band.
import { cacheLoad, cacheSave } from './analyst-cache.mjs';
import { holidayInfo, holidayDateFor } from './holidays.mjs';

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

/** Add `n` days to a YYYY-MM-DD string (DST-safe via a noon anchor). */
export function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
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
  // 4. holiday factor — learned from real Pulse history (prior-year same
  //    holiday vs the store's normal same-weekday baseline). Supplied by the
  //    caller (async I/O lives outside this pure function); 1 = no effect.
  const holidayFactor = opts.holidayFactor && opts.holidayFactor > 0 ? opts.holidayFactor : 1;
  const factor = trend * weatherFactor * holidayFactor;

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
    holidayFactor: Math.round(holidayFactor * 1000) / 1000,
    holidayName: opts.holidayName || null,
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
    // Holidays are forecast via a separate learned factor (not available here),
    // so scoring the base model against a holiday's actuals would unfairly inflate
    // MAPE. Skip them — the scoreboard measures the ordinary-day model.
    if (holidayInfo(target.date)) continue;
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

/** Load a store's hourly-history entries from the blob (newest-first). */
async function loadEntries(pc) {
  const raw = await cacheLoad(`pcg_hourly_history_${pc}`);
  return Array.isArray(raw) ? raw : raw && Array.isArray(raw.data) ? raw.data : [];
}

/** Convenience: load a store's history blob and forecast a date (default tomorrow).
 *  opts: { weather, holidayFactor, holidayName }. */
export async function forecastStore(pc, targetDate, opts = {}) {
  const entries = await loadEntries(pc);
  return computeForecast(entries, targetDate || tomorrowISO(), opts);
}

/** Forecast + live accuracy in one blob read — used by the manager card / endpoint.
 *  opts: { weather, holidayFactor, holidayName, window }. */
export async function forecastStoreFull(pc, targetDate, opts = {}) {
  const entries = await loadEntries(pc);
  return {
    forecast: computeForecast(entries, targetDate || tomorrowISO(), opts),
    accuracy: backtest(entries, opts.window || 14),
  };
}

/**
 * Learn a store's sales factor for the holiday on `targetDate` from REAL Pulse
 * history — prior-year same-holiday sales ÷ that store's normal same-weekday
 * baseline around the holiday (so July 4 isn't treated as an ordinary Friday).
 * Cached per store (factors are stable year-to-year). Returns
 * { factor, name, basis } or null (not a holiday / no usable prior-year data).
 * @param pulseDailySales async (pc, 'YYYY-MM-DD') => netSales | null
 */
export async function learnHolidayFactor(pc, targetDate, pulseDailySales) {
  const info = holidayInfo(targetDate);
  if (!info || typeof pulseDailySales !== 'function') return null;

  const forYear = Number(targetDate.slice(0, 4));
  const cacheKey = `pcg_holiday_factor_${pc}`;
  let cache = await cacheLoad(cacheKey).catch(() => null);
  cache = cache && typeof cache === 'object' ? (cache.data || cache) : {};
  const cached = cache[info.key];
  // Serve the cache only when it was learned for THIS year. A factor stamped to
  // an older year is re-learned, because a newer prior year of Pulse data has
  // since accrued (and a one-off bad sample shouldn't be frozen forever). The
  // cached value may be a negative (miss) result — we cache those too so stores
  // with no usable history don't re-hit Pulse on every request.
  if (cached && cached.forYear === forYear) return cached.miss ? null : cached;

  for (const yearsBack of [1, 2]) {
    const y = forYear - yearsBack;
    const hd = holidayDateFor(info.key, y);
    if (!hd) continue;
    const holidaySales = await Promise.resolve(pulseDailySales(pc, hd)).catch(() => null);
    if (!holidaySales || holidaySales <= 0) continue;
    // Baseline = same weekday on nearby weeks, EXCLUDING dates that are themselves
    // holidays (e.g. Christmas's ±7/±14 land on New Year's Day) so the "normal day"
    // baseline isn't skewed by other abnormal days. Extra offsets give headroom
    // to still clear the ≥2-sample bar after filtering.
    const baseVals = (await Promise.all(
      [-21, -14, -7, 7, 14, 21]
        .map((o) => addDaysISO(hd, o))
        .filter((d) => !holidayInfo(d))
        .map((d) => Promise.resolve(pulseDailySales(pc, d)).catch(() => null))
    )).filter((v) => v && v > 0);
    if (baseVals.length < 2) continue;
    const baseAvg = mean(baseVals);
    if (!baseAvg) continue;
    const result = {
      factor: Math.round(clamp(holidaySales / baseAvg, 0.3, 2.5) * 1000) / 1000,
      name: info.name,
      forYear,
      basis: { year: y, holidaySales: Math.round(holidaySales), baseAvg: Math.round(baseAvg), baseDays: baseVals.length },
    };
    cache[info.key] = result;
    await cacheSave(cacheKey, cache).catch(() => {});
    return result;
  }
  // No usable prior-year data — cache a miss (stamped to this year) so we don't
  // re-fetch all of Pulse on every request; retried once a newer year accrues.
  cache[info.key] = { factor: 1, miss: true, name: info.name, forYear };
  await cacheSave(cacheKey, cache).catch(() => {});
  return null;
}

/**
 * Forecast `days` consecutive days from startDate (default 7). Each day is
 * projected independently from its OWN weekday history (computeForecast) — next
 * Monday from past Mondays, etc. — then summed into a weekly view. Confidence is
 * the weakest day's (honest). Days lacking history come back with null totals
 * but still appear in the list so the UI can show the gap.
 */
export function computeWeekForecast(entries, startDate, opts = {}) {
  const n = opts.days || 7;
  const weatherByDate = opts.weatherByDate || {};
  const holidayFactorByDate = opts.holidayFactorByDate || {};
  const holidayNameByDate = opts.holidayNameByDate || {};
  const days = [];
  for (let i = 0; i < n; i++) {
    const date = addDaysISO(startDate, i);
    const fc = computeForecast(entries, date, {
      weather: weatherByDate[date],
      holidayFactor: holidayFactorByDate[date],
      holidayName: holidayNameByDate[date],
    });
    days.push(fc
      ? { date, dowLabel: fc.dowLabel, dayTotal: fc.dayTotal, low: fc.low, high: fc.high, samples: fc.samples, confidence: fc.confidence, dayparts: fc.dayparts, holidayName: fc.holidayName }
      : { date, dowLabel: DOW[dowFor(date)], dayTotal: null, low: null, high: null, samples: 0, confidence: null, dayparts: null, holidayName: holidayNameByDate[date] || null });
  }
  const valid = days.filter((d) => d.dayTotal != null);
  if (!valid.length) return null;
  const order = { 'very-low': 0, low: 1, medium: 2 };
  const confidence = valid.map((d) => d.confidence).sort((a, b) => order[a] - order[b])[0];
  // Weekly band: combine per-day deviations in quadrature (root-sum-of-squares),
  // not by summing each day's individual min/max. Summing extremes assumes all 7
  // days hit their worst (or best) day at once — near-impossible, and far too wide
  // to staff against. Quadrature treats day-to-day variation as independent, which
  // matches reality much better. Down/up sides kept separate to preserve skew.
  const weekTotal = valid.reduce((s, d) => s + d.dayTotal, 0);
  const downDev = Math.sqrt(valid.reduce((s, d) => s + Math.pow(d.dayTotal - d.low, 2), 0));
  const upDev = Math.sqrt(valid.reduce((s, d) => s + Math.pow(d.high - d.dayTotal, 2), 0));
  return {
    startDate,
    endDate: days[days.length - 1].date,
    weekTotal: Math.round(weekTotal),
    low: Math.round(weekTotal - downDev),
    high: Math.round(weekTotal + upDev),
    confidence,
    daysWithData: valid.length,
    days,
  };
}

/** Convenience: load a store's history blob and forecast the next 7 days.
 *  opts: { weatherByDate, holidayFactorByDate, holidayNameByDate }. */
export async function forecastStoreWeek(pc, startDate, opts = {}) {
  const entries = await loadEntries(pc);
  return computeWeekForecast(entries, startDate || tomorrowISO(), { days: 7, ...opts });
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
