// par-preview.mjs — on-demand Par Level Optimizer (9.2) preview/test endpoint.
//
// Computes recommended donut/munchkin pars for a store (or all stores) for a target date,
// wiring the pure engine (analyst-lib/par-optimizer) to the real blobs:
//   pcg_item_history_{pc}   — donut/munchkin sales history (Phase 0 backfill)
//   pcg_weather_forecast    — 7-day forecast w/ per-day impactPct (weather-forecast-cron)
//
// POST body: { "pc": "339616", "date": "2026-06-17", "safety": 1.10 }
//   - pc omitted  → returns a recommendation for every store
//   - date omitted → tomorrow (ET)

import { cacheLoad } from './analyst-lib/analyst-cache.mjs';
import { computeStorePar } from './analyst-lib/par-optimizer.mjs';
import { STORES } from './pulse-hourly-snapshot.mjs';

function tomorrowET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() + 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

// Pull the forward weather signal (impactPct + condition) for a store's district/date.
function weatherForDay(forecast, district, date) {
  const days = (forecast?.[district] || forecast?.[String(district)] || {}).days || [];
  const d = days.find(x => x.date === date);
  return d ? { impactPct: d.impactPct || 0, condition: d.condition || null } : { impactPct: 0, condition: null };
}

async function recommendFor(store, date, forecast, safety) {
  const itemHistory = (await cacheLoad(`pcg_item_history_${store.pc}`)) || [];
  const wx = weatherForDay(forecast, store.district, date);
  const rec = computeStorePar(itemHistory, {
    targetDate: date,
    weatherImpactPct: wx.impactPct,
    weatherCondition: wx.condition,
    safety,
  });
  return { pc: store.pc, store: store.name, district: store.district, ...rec };
}

export default async (request) => {
  let body = {};
  try { body = await request.json(); } catch {}
  const date = body.date || tomorrowET();
  const safety = Number(body.safety) > 0 ? Number(body.safety) : undefined;
  const forecast = (await cacheLoad('pcg_weather_forecast')) || {};

  const headers = { 'Content-Type': 'application/json' };

  if (body.pc) {
    const store = STORES.find(s => s.pc === String(body.pc));
    if (!store) return new Response(JSON.stringify({ error: `Unknown store ${body.pc}` }), { status: 404, headers });
    const rec = await recommendFor(store, date, forecast, safety);
    return new Response(JSON.stringify(rec), { status: 200, headers });
  }

  // All stores (sequential to stay gentle on blob reads).
  const all = [];
  for (const store of STORES) all.push(await recommendFor(store, date, forecast, safety));
  return new Response(JSON.stringify({ date, count: all.length, recommendations: all }), { status: 200, headers });
};
