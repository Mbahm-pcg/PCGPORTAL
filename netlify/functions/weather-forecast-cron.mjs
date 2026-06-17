// weather-forecast-cron.mjs — Daily: 7-day forecast per district + weekly correlation rebuild
import https from 'node:https';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.js';

export const config = { schedule: '0 12 * * *' };

const DISTRICT_COORDS = {
  1: { lat: 40.205, lon: -75.092 },
  2: { lat: 40.200, lon: -75.070 },
  3: { lat: 39.925, lon: -75.275 },
  4: { lat: 40.000, lon: -75.150 },
  5: { lat: 40.240, lon: -75.340 },
  6: { lat: 40.010, lon: -75.530 },
  7: { lat: 40.070, lon: -75.020 },
  8: { lat: 40.310, lon: -75.230 },
};

const STORES = [
  { pc:"339616", district:1 },{ pc:"340794", district:1 },
  { pc:"351099", district:2 },{ pc:"351259", district:2 },{ pc:"302642", district:2 },
  { pc:"352894", district:2 },{ pc:"341350", district:2 },{ pc:"337839", district:2 },
  { pc:"330338", district:3 },{ pc:"337063", district:3 },{ pc:"343832", district:3 },
  { pc:"304669", district:3 },{ pc:"355146", district:3 },{ pc:"300496", district:3 },
  { pc:"304863", district:3 },{ pc:"354561", district:3 },{ pc:"332393", district:3 },
  { pc:"341167", district:4 },{ pc:"340870", district:4 },{ pc:"335981", district:4 },
  { pc:"353150", district:4 },{ pc:"351050", district:4 },{ pc:"345985", district:4 },
  { pc:"356374", district:5 },{ pc:"353843", district:5 },{ pc:"353047", district:5 },
  { pc:"340538", district:5 },
  { pc:"343079", district:6 },{ pc:"342144", district:6 },{ pc:"364295", district:6 },
  { pc:"365361", district:7 },{ pc:"310382", district:7 },{ pc:"332941", district:7 },
  { pc:"343497", district:7 },{ pc:"302446", district:7 },{ pc:"337079", district:7 },
  { pc:"345986", district:7 },{ pc:"364412", district:7 },{ pc:"345489", district:7 },
  { pc:"336372", district:7 },
  { pc:"358933", district:8 },{ pc:"354865", district:8 },{ pc:"353689", district:8 },
  { pc:"342184", district:8 },{ pc:"356316", district:8 },
];

function wmoToCondition(code) {
  if (code === 0)  return 'clear';
  if (code <= 3)   return 'cloudy';
  if (code <= 48)  return 'fog';
  if (code <= 67)  return 'rain';
  if (code <= 77)  return 'snow';
  if (code <= 82)  return 'rain';
  if (code <= 86)  return 'snow';
  return 'storm';
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchForecasts() {
  const forecasts = {};
  await Promise.all(
    Object.entries(DISTRICT_COORDS).map(async ([district, { lat, lon }]) => {
      const url = `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
        `&temperature_unit=fahrenheit` +
        `&timezone=America%2FNew_York&forecast_days=7`;
      try {
        const json = await getJSON(url);
        const d = json.daily || {};
        const days = (d.time || []).map((date, i) => ({
          date,
          condition: wmoToCondition((d.weathercode || [])[i] ?? 0),
          wmoCode: (d.weathercode || [])[i] ?? 0,
          tempHighF: Math.round((d.temperature_2m_max || [])[i] ?? 0),
          tempLowF: Math.round((d.temperature_2m_min || [])[i] ?? 0),
          precipMm: Math.round(((d.precipitation_sum || [])[i] ?? 0) * 10) / 10,
        }));
        forecasts[district] = { days };
      } catch (e) {
        console.warn(`[weather-forecast] Forecast failed for D${district}: ${e.message}`);
        forecasts[district] = { days: [], error: e.message };
      }
    })
  );
  return forecasts;
}

async function buildCorrelations() {
  const conditionSales = {};
  for (let d = 1; d <= 8; d++) conditionSales[d] = {};

  const districtStores = {};
  for (const s of STORES) {
    if (!districtStores[s.district]) districtStores[s.district] = [];
    districtStores[s.district].push(s.pc);
  }

  for (const [district, pcs] of Object.entries(districtStores)) {
    const allDays = [];
    for (const pc of pcs) {
      const history = await cacheLoad(`pcg_hourly_history_${pc}`);
      if (!Array.isArray(history)) continue;
      for (const entry of history) {
        if (!entry.weather?.condition || !entry.hours) continue;
        const daySales = entry.hours.reduce((sum, h) => sum + (h.sales || 0), 0);
        if (daySales <= 0) continue;
        allDays.push({ condition: entry.weather.condition, sales: daySales });
      }
    }

    if (allDays.length === 0) continue;
    const overallAvg = allDays.reduce((s, d) => s + d.sales, 0) / allDays.length;
    if (overallAvg <= 0) continue;

    const byCondition = {};
    for (const day of allDays) {
      if (!byCondition[day.condition]) byCondition[day.condition] = [];
      byCondition[day.condition].push(day.sales);
    }

    for (const [cond, salesArr] of Object.entries(byCondition)) {
      const avg = salesArr.reduce((s, v) => s + v, 0) / salesArr.length;
      conditionSales[district][cond] = Math.round((avg / overallAvg) * 100) / 100;
    }
    conditionSales[district].sampleSize = allDays.length;
  }

  return conditionSales;
}

function getDayOfWeekBaseline(history, dayOfWeek) {
  const matching = history.filter(entry => {
    if (!entry.hours) return false;
    const d = new Date(entry.date + 'T12:00:00');
    return d.getDay() === dayOfWeek;
  });
  if (matching.length === 0) return 0;
  const sales = matching.map(e => e.hours.reduce((s, h) => s + (h.sales || 0), 0));
  return sales.reduce((s, v) => s + v, 0) / sales.length;
}

async function computeAdjustedTargets(forecasts, correlations) {
  const districtStores = {};
  for (const s of STORES) {
    if (!districtStores[s.district]) districtStores[s.district] = [];
    districtStores[s.district].push(s.pc);
  }

  for (const [district, forecast] of Object.entries(forecasts)) {
    if (!forecast.days || forecast.days.length === 0) continue;
    const corr = correlations[district] || {};

    const allHistory = [];
    for (const pc of (districtStores[district] || [])) {
      const history = await cacheLoad(`pcg_hourly_history_${pc}`);
      if (Array.isArray(history)) allHistory.push(...history);
    }

    for (const day of forecast.days) {
      const dow = new Date(day.date + 'T12:00:00').getDay();
      const baseline = getDayOfWeekBaseline(allHistory, dow);
      const impact = corr[day.condition] || 1.0;
      day.adjustedTarget = Math.round(baseline * impact);
      day.impactPct = Math.round((impact - 1) * 100);
    }
  }
}

export default async (request) => {
  const isManual = request.method === 'POST';
  console.log('[weather-forecast] Starting', isManual ? '(manual)' : '(scheduled)');

  const forecasts = await fetchForecasts();
  console.log('[weather-forecast] Fetched forecasts for', Object.keys(forecasts).length, 'districts');

  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  let correlations = await cacheLoad('pcg_weather_correlations');

  if (!correlations || isMonday || isManual) {
    console.log('[weather-forecast] Building correlations...');
    correlations = await buildCorrelations();
    await cacheSave('pcg_weather_correlations', correlations);
    console.log('[weather-forecast] Correlations saved');
  }

  await computeAdjustedTargets(forecasts, correlations);
  await cacheSave('pcg_weather_forecast', forecasts);

  console.log('[weather-forecast] Complete');
  return new Response(
    JSON.stringify({ ok: true, districts: Object.keys(forecasts).length }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
