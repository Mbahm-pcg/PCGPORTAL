// pulse-hourly-snapshot.js
// Scheduled daily at 2:30 AM UTC (10:30 PM ET)
// Captures yesterday's hourly sales per store + district weather from Open-Meteo archive.
// Builds the historical dataset used later for weather-correlated sales predictions.

const https = require('https');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');

const STORES = [
  { pc:"339616", name:"Wadsworth",       district:1 },
  { pc:"340794", name:"Front",           district:1 },
  { pc:"351099", name:"Sonic",           district:2 },
  { pc:"351259", name:"Rosemore",        district:2 },
  { pc:"302642", name:"County Line",     district:2 },
  { pc:"352894", name:"Street Rd",       district:2 },
  { pc:"341350", name:"Yardley",         district:2 },
  { pc:"337839", name:"Warrington",      district:2 },
  { pc:"330338", name:"Drexel Hill",     district:3 },
  { pc:"337063", name:"Sharon Hill",     district:3 },
  { pc:"343832", name:"Lansdowne",       district:3 },
  { pc:"304669", name:"Collingdale",     district:3 },
  { pc:"355146", name:"Gallery",         district:3 },
  { pc:"300496", name:"Cobbs Creek",     district:3 },
  { pc:"304863", name:"18th St",         district:3 },
  { pc:"354561", name:"Carlisle",        district:3 },
  { pc:"332393", name:"Lindbergh",       district:3 },
  { pc:"341167", name:"5th Street",      district:4 },
  { pc:"340870", name:"Hunting Park",    district:4 },
  { pc:"335981", name:"Lehigh",          district:4 },
  { pc:"353150", name:"Bakers Square",   district:4 },
  { pc:"351050", name:"Allegheny",       district:4 },
  { pc:"345985", name:"Wissahickon",     district:4 },
  { pc:"356374", name:"Montgomeryville", district:5 },
  { pc:"353843", name:"Tollgate",        district:5 },
  { pc:"353047", name:"Silverdale",      district:5 },
  { pc:"340538", name:"Easton",          district:5 },
  { pc:"343079", name:"Downingtown",     district:6 },
  { pc:"342144", name:"Westchester",     district:6 },
  { pc:"364295", name:"Lionville",       district:6 },
  { pc:"365361", name:"Little Welsh",    district:7 },
  { pc:"310382", name:"Grant",           district:7 },
  { pc:"332941", name:"Bustleton",       district:7 },
  { pc:"343497", name:"Red Lion",        district:7 },
  { pc:"302446", name:"Little Red Lion", district:7 },
  { pc:"337079", name:"Holme Circle",    district:7 },
  { pc:"345986", name:"Willits",         district:7 },
  { pc:"364412", name:"8200",            district:7 },
  { pc:"345489", name:"Oxford",          district:7 },
  { pc:"336372", name:"Elkins Park",     district:7 },
  { pc:"358933", name:"Brace Rd",        district:8 },
  { pc:"354865", name:"Quakertown",      district:8 },
  { pc:"353689", name:"Fort Washington", district:8 },
  { pc:"342184", name:"Lansdale",        district:8 },
  { pc:"356316", name:"BJ's",            district:8 },
];

// One representative coordinate per district (Philadelphia region)
const DISTRICT_COORDS = {
  1: { lat: 40.205, lon: -75.092 }, // Warminster / Willow Grove
  2: { lat: 40.200, lon: -75.070 }, // Bucks County
  3: { lat: 39.925, lon: -75.275 }, // Delaware County / SW Philly
  4: { lat: 40.000, lon: -75.150 }, // North Philadelphia
  5: { lat: 40.240, lon: -75.340 }, // Montgomery County
  6: { lat: 40.010, lon: -75.530 }, // Chester County
  7: { lat: 40.070, lon: -75.020 }, // Northeast Philadelphia
  8: { lat: 40.310, lon: -75.230 }, // Upper Montgomery / Bucks
};

const APIS = {
  p227: {
    host: 'pos-ra.dunkindonuts.com', path: '/p227',
    xkey:   'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL',
    apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
  p228: {
    host: 'pos-ra.dunkindonuts.com', path: '/p228',
    xkey:   'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP',
    apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
};

const STORE_P227 = '345986';
const MAX_HISTORY_DAYS = 90;

function apiRoute(pc) { return pc === STORE_P227 ? 'p227' : 'p228'; }

// ── Date helpers ──────────────────────────────────────────────────────────────

function yesterdayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function postJSON(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: cfg.host,
      port: 443,
      path: `${cfg.path}/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.xkey,
        'Api-Key': cfg.apikey,
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
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
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Weather ───────────────────────────────────────────────────────────────────

// WMO weather interpretation code → simple condition label
function wmoToCondition(code) {
  if (code === 0)           return 'clear';
  if (code <= 3)            return 'cloudy';
  if (code <= 48)           return 'fog';
  if (code <= 67)           return 'rain';
  if (code <= 77)           return 'snow';
  if (code <= 82)           return 'rain';   // rain showers
  if (code <= 86)           return 'snow';   // snow showers
  return 'storm';                            // thunderstorm 95-99
}

async function fetchDistrictWeather(date) {
  const weather = {};
  await Promise.all(
    Object.entries(DISTRICT_COORDS).map(async ([district, { lat, lon }]) => {
      const url = `https://archive-api.open-meteo.com/v1/archive` +
        `?latitude=${lat}&longitude=${lon}` +
        `&start_date=${date}&end_date=${date}` +
        `&daily=precipitation_sum,temperature_2m_max,weathercode` +
        `&temperature_unit=fahrenheit` +
        `&timezone=America%2FNew_York`;
      try {
        const json = await getJSON(url);
        const d = json.daily || {};
        const code    = (d.weathercode         || [])[0] ?? 0;
        const precipMm = (d.precipitation_sum  || [])[0] ?? 0;
        const tempMaxF = (d.temperature_2m_max || [])[0] ?? null;
        weather[district] = {
          condition: wmoToCondition(code),
          wmoCode:   code,
          precipMm:  Math.round(precipMm * 10) / 10,
          tempMaxF:  tempMaxF !== null ? Math.round(tempMaxF) : null,
        };
      } catch (e) {
        console.warn(`[hourly-snapshot] Weather failed for district ${district}: ${e.message}`);
        weather[district] = null;
      }
    })
  );
  return weather;
}

// ── Hourly sales aggregation ──────────────────────────────────────────────────

// Modifier-only line items (e.g. "NO", "ADD") — don't count toward item count
const MODIFIER_MI_NUMS = new Set([906005, 906006]);

// Number of real menu items rung on a check (excludes modifier-only lines, voids, tenders)
function itemCountForCheck(check) {
  const lines = check.detailLines || [];
  return lines.filter(d =>
    d.menuItem &&
    !d.vdFlag &&
    (d.dspQty || 0) > 0 &&
    !MODIFIER_MI_NUMS.has(d.menuItem.miNum)
  ).length;
}

// ── Bakery par foundation (Par Level Optimizer 9.2) ─────────────────────────────
// Classify a menu-item name into a donut/munchkin sub-category + units-per-sale
// (e.g. "Donut Dozen" → 12). Slim port of classifyItem() in food-cost.js — keep
// the donut/munchkin branches here in sync with that source of truth. Returns null
// for anything that isn't a donut or munchkin (par scope is bakery-only for now).
function classifyBakery(name) {
  const lower = (name || '').toLowerCase();
  // Munchkins (check before donut: "munchkin" never contains "donut")
  if (lower.includes('munchkin')) {
    const ctMatch = lower.match(/(\d+)\s*ct/);
    if (ctMatch) return { sub: 'munchkin', qty: parseInt(ctMatch[1], 10) };
    if (lower.includes('box') || lower.includes('bucket')) {
      if (lower.includes('50')) return { sub: 'munchkin', qty: 50 };
      if (lower.includes('25')) return { sub: 'munchkin', qty: 25 };
    }
    return { sub: 'munchkin', qty: 1 };
  }
  // Donuts
  if (lower.includes('donut') || lower.includes('doughnut')) {
    const ctMatch = lower.match(/(\d+)\s*(?:ct|pk|pack)/);
    if (ctMatch) return { sub: 'donut', qty: parseInt(ctMatch[1], 10) };
    if (lower.includes('half dozen') || lower.includes('1/2 dozen') || lower.includes('6 pk')) return { sub: 'donut', qty: 6 };
    if (lower.includes('dozen')) return { sub: 'donut', qty: 12 };
    return { sub: 'donut', qty: 1 };
  }
  return null;
}

// Build a miNum → { sub, qty, name } map of donut/munchkin items for a Pulse route,
// using one representative store's menu-item dimensions. Returns an empty Map on failure
// (the snapshot still records sales; bakery data is just skipped for that run).
async function buildBakeryClassMap(repPc) {
  const cfg = APIS[apiRoute(repPc)];
  const m = new Map();
  try {
    const dims = await postJSON(cfg, 'getMenuItemDimensions', { locRef: repPc });
    for (const mi of (dims?.menuItems || [])) {
      const ci = classifyBakery(mi.name);
      // Key by String(num): getMenuItemDimensions and getGuestChecks may return the
      // item id as different JS types, and Map.get is type-sensitive (5012 !== "5012").
      if (ci) m.set(String(mi.num), { ...ci, name: mi.name });
    }
  } catch (e) {
    console.warn(`[hourly-snapshot] dimensions fetch failed for ${repPc}: ${e.message}`);
  }
  return m;
}

async function fetchHourlySales(pc, busDt, bakeryClass) {
  const cfg = APIS[apiRoute(pc)];
  try {
    const json = await postJSON(cfg, 'getGuestChecks', {
      locRef: pc,
      busDt,
      include: 'guestChecks.opnUTC,guestChecks.subTtl,guestChecks.chkTtl,guestChecks.detailLines',
    });

    const checks = json.guestChecks || [];
    const byHour = {};
    // Donut/munchkin units bucketed by ET hour (for par timing + mid-day stockout),
    // plus per-flavor daily totals (for future flavor-mix recommendations).
    const bakeryByHour = {}; // h → { donut, munchkin }
    const flavors = {};      // item name → units sold that day
    let upsoldChecks = 0;
    let totalChecks = 0;

    for (const c of checks) {
      const raw = c.opnUTC || '';
      if (!raw) continue;
      const dt = new Date(raw.endsWith('Z') ? raw : raw + 'Z');
      if (isNaN(dt.getTime())) continue;

      // Extract ET hour reliably using Intl
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        hour12: false,
      }).formatToParts(dt);
      const h = parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;

      if (!byHour[h]) byHour[h] = { h, sales: 0, checks: 0 };
      byHour[h].sales  += c.chkTtl || c.subTtl || 0;
      byHour[h].checks += 1;

      totalChecks += 1;
      if (itemCountForCheck(c) >= 2) upsoldChecks += 1;

      // Accumulate donut/munchkin units for this check's hour (no extra API call —
      // detailLines are already in the payload). Skipped when the class map is empty.
      if (bakeryClass && bakeryClass.size > 0) {
        for (const d of (c.detailLines || [])) {
          if (!d.menuItem || d.vdFlag || (d.dspQty || 0) <= 0) continue;
          const ci = bakeryClass.get(String(d.menuItem.miNum));
          if (!ci) continue;
          const units = d.dspQty * ci.qty;
          if (!bakeryByHour[h]) bakeryByHour[h] = { donut: 0, munchkin: 0 };
          bakeryByHour[h][ci.sub] += units;
          flavors[ci.name] = (flavors[ci.name] || 0) + units;
        }
      }
    }

    const hours = Object.values(byHour)
      .map(e => ({ ...e, sales: Math.round(e.sales * 100) / 100 }))
      .sort((a, b) => a.h - b.h);

    const upsellRate = totalChecks > 0 ? Math.round((upsoldChecks / totalChecks) * 1000) / 10 : null;

    // Reshape bakery into { sub: { total, byHour:{h:units} } } for compact storage.
    const bakery = {};
    for (const sub of ['donut', 'munchkin']) {
      const byHourSub = {};
      let total = 0;
      for (const [h, v] of Object.entries(bakeryByHour)) {
        if (v[sub] > 0) { byHourSub[h] = Math.round(v[sub] * 10) / 10; total += v[sub]; }
      }
      bakery[sub] = { total: Math.round(total * 10) / 10, byHour: byHourSub };
    }

    return { hours, upsoldChecks, totalChecks, upsellRate, bakery, flavors };

  } catch (e) {
    console.warn(`[hourly-snapshot] Guest checks failed for ${pc}: ${e.message}`);
    return null;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function appendSnapshot(pc, date, hours, weather, upsell) {
  const key = `pcg_hourly_history_${pc}`;
  const existing = (await cacheLoad(key)) || [];
  const entries = Array.isArray(existing) ? existing : [];

  // Remove any existing entry for this date (idempotent on re-run)
  const filtered = entries.filter(e => e.date !== date);

  // Newest first, capped at MAX_HISTORY_DAYS
  filtered.unshift({ date, weather, hours, ...upsell });
  const trimmed = filtered.slice(0, MAX_HISTORY_DAYS);

  await cacheSave(key, trimmed);
}

// Day-of-week (0=Sun … 6=Sat) for a YYYY-MM-DD date, anchored at local noon to
// dodge timezone/DST edges.
function dowFor(date) {
  return new Date(`${date}T12:00:00`).getDay();
}

// Per-store donut/munchkin history → pcg_item_history_{pc} (separate blob from the
// hourly sales history so existing analyst consumers are untouched). Feeds the Par
// Level Optimizer: per-DOW unit baselines + hourly series for mid-day stockout detection.
async function appendItemSnapshot(pc, date, weather, bakery, flavors) {
  const key = `pcg_item_history_${pc}`;
  const existing = (await cacheLoad(key)) || [];
  const entries = Array.isArray(existing) ? existing : [];
  const filtered = entries.filter(e => e.date !== date); // idempotent on re-run
  filtered.unshift({ date, dow: dowFor(date), weather, bakery, flavors });
  await cacheSave(key, filtered.slice(0, MAX_HISTORY_DAYS));
}

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async () => {
  const date = yesterdayET();
  console.log(`[hourly-snapshot] Starting snapshot for ${date}`);

  // Fetch weather for all 8 districts in parallel (free, no key needed)
  const districtWeather = await fetchDistrictWeather(date);
  const conditionSummary = Object.entries(districtWeather)
    .map(([d, w]) => `D${d}:${w ? w.condition : 'err'}`)
    .join(' ');
  console.log(`[hourly-snapshot] Weather: ${conditionSummary}`);

  // Build the donut/munchkin classification map once per Pulse route (menu-item
  // numbers are per-route), reused across all stores on that route.
  const routeClass = {};
  for (const route of [...new Set(STORES.map(s => apiRoute(s.pc)))]) {
    const rep = STORES.find(s => apiRoute(s.pc) === route);
    routeClass[route] = await buildBakeryClassMap(rep.pc);
  }
  console.log(`[hourly-snapshot] Bakery items mapped: ${Object.entries(routeClass).map(([r, m]) => `${r}:${m.size}`).join(' ')}`);

  // Process all stores in batches of 8
  let saved = 0, failed = 0;
  const BATCH = 8;

  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (store) => {
      const classMap = routeClass[apiRoute(store.pc)];
      const result = await fetchHourlySales(store.pc, date, classMap);
      if (result === null) { failed++; return; }

      const { hours, bakery, flavors, ...upsell } = result;
      const weather = districtWeather[String(store.district)] || null;
      await appendSnapshot(store.pc, date, hours, weather, upsell);
      // Only record bakery history when the class map built — otherwise a transient
      // dimensions-fetch failure would persist false zeros that look like a real
      // zero-sales day and skew the Par Optimizer's per-DOW baselines.
      if (classMap && classMap.size > 0) {
        await appendItemSnapshot(store.pc, date, weather, bakery, flavors);
      }
      saved++;
    }));
  }

  console.log(`[hourly-snapshot] Complete: ${saved} saved, ${failed} failed`);
  return { statusCode: 200, body: JSON.stringify({ date, saved, failed, districtWeather }) };
};
