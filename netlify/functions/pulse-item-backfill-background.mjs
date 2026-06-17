// pulse-item-backfill-background.mjs
// One-time (re-runnable) backfill of donut/munchkin sales history.
//
// Replays past Pulse guest checks to build pcg_item_history_{pc} entries for dates
// already in the past, so the Par Level Optimizer launches with months of history
// instead of waiting for the nightly snapshot to accumulate it.
//
// Resumable: ~4,050 heavy getGuestChecks calls (90 days × 45 stores) can't finish in
// one 15-min background window, so each invocation processes STORES_PER_RUN stores,
// persists progress to a state blob, and re-triggers itself until the queue is empty.
// Idempotent: merges by date, so a re-run (or overlap with the nightly job) is safe.
//
// Trigger:  POST /.netlify/functions/pulse-item-backfill-background
//   body (optional): { "days": 90, "reset": true }   reset=true restarts from scratch.

import https from 'node:https';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.mjs';
import {
  STORES, DISTRICT_COORDS, MAX_HISTORY_DAYS, apiRoute, APIS,
  postJSON, getJSON, wmoToCondition, buildBakeryClassMap, extractBakery, dowFor,
} from './pulse-hourly-snapshot.mjs';

export const config = { background: true };

const STORES_PER_RUN = 5;     // stores processed per invocation (keeps each run ~3 min)
const DATE_CONCURRENCY = 6;   // concurrent getGuestChecks per store

// ── Date helpers ────────────────────────────────────────────────────────────────

// YYYY-MM-DD for (today in ET − offset days).
function ymdET(offset) {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - offset);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

// Business dates to backfill: yesterday (offset 1) back through `days` days, newest first.
function backfillDates(days) {
  const out = [];
  for (let i = 1; i <= days; i++) out.push(ymdET(i));
  return out;
}

// ── Weather (one archive call per district covers the whole range) ────────────────

async function fetchDistrictWeatherRange(startDate, endDate) {
  const byDistrict = {};
  await Promise.all(Object.entries(DISTRICT_COORDS).map(async ([district, { lat, lon }]) => {
    const url = `https://archive-api.open-meteo.com/v1/archive` +
      `?latitude=${lat}&longitude=${lon}` +
      `&start_date=${startDate}&end_date=${endDate}` +
      `&daily=precipitation_sum,temperature_2m_max,weathercode` +
      `&temperature_unit=fahrenheit&timezone=America%2FNew_York`;
    const map = {};
    try {
      const json = await getJSON(url);
      const d = json.daily || {};
      (d.time || []).forEach((date, i) => {
        const code = (d.weathercode || [])[i] ?? 0;
        const precipMm = (d.precipitation_sum || [])[i] ?? 0;
        const tempMaxF = (d.temperature_2m_max || [])[i] ?? null;
        map[date] = {
          condition: wmoToCondition(code),
          wmoCode: code,
          precipMm: Math.round(precipMm * 10) / 10,
          tempMaxF: tempMaxF !== null ? Math.round(tempMaxF) : null,
        };
      });
    } catch (e) {
      console.warn(`[item-backfill] weather range failed for district ${district}: ${e.message}`);
    }
    byDistrict[district] = map;
  }));
  return byDistrict;
}

// ── Per-store backfill ────────────────────────────────────────────────────────────

async function backfillStore(store, dates, classMap, weatherForDistrict) {
  const entries = [];
  // Fetch dates in small concurrent chunks to bound load on the Pulse API.
  for (let i = 0; i < dates.length; i += DATE_CONCURRENCY) {
    const slice = dates.slice(i, i + DATE_CONCURRENCY);
    const results = await Promise.all(slice.map(async (busDt) => {
      try {
        const json = await postJSON(APIS[apiRoute(store.pc)], 'getGuestChecks', {
          locRef: store.pc, busDt,
          include: 'guestChecks.opnUTC,guestChecks.detailLines',
        });
        const checks = json.guestChecks || [];
        const { bakery, flavors } = extractBakery(checks, classMap);
        const weather = (weatherForDistrict || {})[busDt] || null;
        return { date: busDt, dow: dowFor(busDt), weather, bakery, flavors };
      } catch (e) {
        console.warn(`[item-backfill] ${store.pc} ${busDt} failed: ${e.message}`);
        return null;
      }
    }));
    for (const r of results) if (r) entries.push(r);
  }

  // Merge into existing history (idempotent by date), newest-first, capped.
  const key = `pcg_item_history_${store.pc}`;
  const existing = await cacheLoad(key);
  const prev = Array.isArray(existing) ? existing : [];
  const newDates = new Set(entries.map(e => e.date));
  const merged = [...entries, ...prev.filter(e => !newDates.has(e.date))]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, MAX_HISTORY_DAYS);
  await cacheSave(key, merged);
  return entries.length;
}

// ── Self-chaining trigger ─────────────────────────────────────────────────────────

function triggerNextRun() {
  return new Promise((resolve) => {
    const base = process.env.URL;
    if (!base) { console.warn('[item-backfill] no process.env.URL — cannot self-chain'); return resolve(false); }
    try {
      const u = new URL(`${base}/.netlify/functions/pulse-item-backfill-background`);
      const req = https.request({
        hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
      }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(true)); });
      req.on('error', (e) => { console.warn(`[item-backfill] chain failed: ${e.message}`); resolve(false); });
      req.setTimeout(5000, () => { req.destroy(); resolve(false); });
      req.write('{}');
      req.end();
    } catch (e) { console.warn(`[item-backfill] chain error: ${e.message}`); resolve(false); }
  });
}

// A store still needs backfill if its history has fewer than (days − slack) entries.
// The slack tolerates a few dates Pulse can't return so a store isn't reprocessed forever.
const COVERAGE_SLACK = 3;

async function historyCount(pc) {
  const existing = await cacheLoad(`pcg_item_history_${pc}`);
  return Array.isArray(existing) ? existing.length : 0;
}

// ── Handler ───────────────────────────────────────────────────────────────────────
//
// Stateless & resumable: every invocation reads the ACTUAL history coverage to decide
// which stores still need work — no shared progress counter to corrupt. That makes it
// safe to trigger repeatedly and safe if two runs overlap (idempotent merge by date).
// Each run does up to STORES_PER_RUN stores, then self-chains while work remains; if the
// self-chain ever drops, just POST again and it resumes exactly where coverage left off.
export default async (request, context) => {
  const body = await request.json().catch(() => ({}));
  const days = Math.min(Math.max(parseInt(body.days, 10) || 90, 1), MAX_HISTORY_DAYS);
  const force = body.reset === true || body.force === true; // reprocess even complete stores

  // Ground-truth coverage check across all stores.
  const counts = await Promise.all(STORES.map(s => historyCount(s.pc)));
  const needed = STORES.filter((s, i) => force || counts[i] < days - COVERAGE_SLACK);

  if (needed.length === 0) {
    console.log('[item-backfill] all stores complete');
    return new Response(JSON.stringify({ complete: true, stores: STORES.length }), { status: 200 });
  }

  const batch = needed.slice(0, STORES_PER_RUN);
  console.log(`[item-backfill] ${needed.length} stores need backfill; processing ${batch.map(s => s.pc).join(',')}`);

  const dates = backfillDates(days);                 // newest → oldest
  const start = dates[dates.length - 1], end = dates[0];
  const routeClass = {};
  for (const route of [...new Set(batch.map(s => apiRoute(s.pc)))]) {
    const rep = STORES.find(s => apiRoute(s.pc) === route);
    routeClass[route] = await buildBakeryClassMap(rep.pc);
  }
  const weatherRange = await fetchDistrictWeatherRange(start, end);

  const processed = [], errors = {};
  for (const store of batch) {
    const classMap = routeClass[apiRoute(store.pc)];
    if (!classMap || classMap.size === 0) { errors[store.pc] = 'class map empty (dimensions fetch failed)'; continue; }
    try {
      const n = await backfillStore(store, dates, classMap, weatherRange[String(store.district)]);
      console.log(`[item-backfill] ${store.name} (${store.pc}): ${n}/${dates.length} days`);
      processed.push(store.pc);
    } catch (e) {
      errors[store.pc] = e.message;
      console.warn(`[item-backfill] ${store.pc} failed: ${e.message}`);
    }
  }

  const remaining = needed.length - processed.length;
  if (remaining > 0) {
    console.log(`[item-backfill] ${processed.length} done this run; ~${remaining} remaining — chaining`);
    await triggerNextRun();
    return new Response(JSON.stringify({ processed, remaining, errors }), { status: 202 });
  }
  console.log(`[item-backfill] COMPLETE: all stores covered`);
  return new Response(JSON.stringify({ complete: true, processed, errors }), { status: 200 });
};
