// pulse-hourly-snapshot.mjs
// Scheduled daily at 2:30 AM UTC (10:30 PM ET)
// Captures yesterday's hourly sales per store + district weather from Open-Meteo archive.
// Builds the historical dataset used later for weather-correlated sales predictions.

import https from 'node:https';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.mjs';
import { classifyItem } from './food-cost.mjs';
import { loadNewProductRegistry, matchNewProducts } from './analyst-lib/new-products.mjs';

export const config = { schedule: '30 2 * * *' };

export const STORES = [
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
export const DISTRICT_COORDS = {
  1: { lat: 40.205, lon: -75.092 }, // Warminster / Willow Grove
  2: { lat: 40.200, lon: -75.070 }, // Bucks County
  3: { lat: 39.925, lon: -75.275 }, // Delaware County / SW Philly
  4: { lat: 40.000, lon: -75.150 }, // North Philadelphia
  5: { lat: 40.240, lon: -75.340 }, // Montgomery County
  6: { lat: 40.010, lon: -75.530 }, // Chester County
  7: { lat: 40.070, lon: -75.020 }, // Northeast Philadelphia
  8: { lat: 40.310, lon: -75.230 }, // Upper Montgomery / Bucks
};

export const APIS = {
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
export const MAX_HISTORY_DAYS = 90;

export function apiRoute(pc) { return pc === STORE_P227 ? 'p227' : 'p228'; }

// ── Date helpers ──────────────────────────────────────────────────────────────

function yesterdayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - 1);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export function postJSON(cfg, endpoint, body) {
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

export function getJSON(url) {
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
export function wmoToCondition(code) {
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

// Count REAL sellable menu items on a check (drives the upsell metric: 2+ items = upsell).
// Only TOP-LEVEL item lines count. In the Pulse/POS hierarchy, modifiers and build
// components (cream, sugar, swirls, paid extra shots, a sandwich's egg/cheese) are CHILD
// lines that carry a `parDtlId` pointing at their parent item — they must not count, or an
// add-on-heavy order (e.g. coffee + cream + sugar) looks like a 3-item "upsell". Tenders,
// tax, discounts, and rewards have no `menuItem` at all, so they're excluded too.
// (Counting child lines previously inflated the rate to ~95%; top-level-only ≈ 56%.)
function itemCountForCheck(check) {
  const lines = check.detailLines || [];
  return lines.filter(d =>
    d.menuItem &&
    !d.vdFlag &&
    !d.errCorFlag &&
    d.parDtlId == null &&        // top-level only — exclude modifier / build-component child lines
    (d.dspQty || 0) > 0
  ).length;
}

// ── Bakery par foundation (Par Level Optimizer 9.2) ─────────────────────────────
// Classify a menu-item name into a donut/munchkin sub-category + units-per-sale.
// Returns null for anything that isn't a donut or munchkin (par scope is bakery-only).
//
// Units-per-sale ("qty") is the whole point for par math: a single "Donut" is 1, but a
// box must expand to its real count. These stores name boxes several ways, in order of
// precedence below: an explicit "N ct/count/pk/pack", a LEADING count ("12 Donuts",
// "10 Munchkins" — the dominant convention here), "dozen"/"half dozen" words, or a
// munchkin "25/50" box/bucket. NOTE: this is deliberately more thorough than
// classifyItem() in food-cost.js, which misses the leading-count form and undercounts.
export function classifyBakery(name) {
  const lower = (name || '').toLowerCase();
  if (lower.includes('empty')) return null; // packaging/deposit items, not real bakery
  const isMunchkin = lower.includes('munchkin');
  const isDonut = !isMunchkin && (lower.includes('donut') || lower.includes('doughnut'));
  if (!isMunchkin && !isDonut) return null;
  const sub = isMunchkin ? 'munchkin' : 'donut';

  let qty = 1;
  const countMatch = lower.match(/(\d+)\s*(?:ct|count|pk|pack)\b/)   // "25 ct", "50 count", "6 pk"
    || lower.match(/^(\d+)\s+(?:donut|doughnut|munchkin)/);          // "12 Donuts", "10 Munchkins"
  if (countMatch) {
    qty = parseInt(countMatch[1], 10);
  } else if (lower.includes('half dozen') || lower.includes('1/2 dozen')) {
    qty = 6;
  } else if (lower.includes('dozen')) {
    qty = 12;
  } else if (isMunchkin && (lower.includes('box') || lower.includes('bucket'))) {
    if (lower.includes('50')) qty = 50;
    else if (lower.includes('25')) qty = 25;
  }
  return { sub, qty };
}

// Build a miNum → { sub, qty, name } map of donut/munchkin items for a Pulse route,
// using one representative store's menu-item dimensions. Returns an empty Map on failure
// (the snapshot still records sales; bakery data is just skipped for that run).
export async function buildBakeryClassMap(repPc) {
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

// Build a miNum → { group, name } map for a Pulse route (group ∈ hot_beverages /
// cold_beverages / frozen / sandwiches / wraps / bakery / snacks_sides / bottled / other,
// via classifyItem). Powers Sales-Mix Intelligence: per-store daily sales-by-category +
// daypart mix (group), and new-product launch matching (name, since getMenuItemDailyTotals
// returns only the item number).
export async function buildItemGroupMap(repPc) {
  const cfg = APIS[apiRoute(repPc)];
  const m = new Map();
  try {
    const dims = await postJSON(cfg, 'getMenuItemDimensions', { locRef: repPc });
    for (const mi of (dims?.menuItems || [])) {
      const g = classifyItem(mi.name)?.group;
      if (g) m.set(String(mi.num), { group: g, name: mi.name });
    }
  } catch (e) {
    console.warn(`[hourly-snapshot] item group map failed for ${repPc}: ${e.message}`);
  }
  return m;
}

// ── Dayparts (ET) for the daypart × day-of-week item matrix (roadmap 9.3) ──
export const DAYPARTS = ['Morning', 'Midday', 'Afternoon', 'Evening'];
export function daypartFor(hour) {
  if (hour == null) return null;
  if (hour < 11) return 'Morning';
  if (hour < 14) return 'Midday';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

// Category units by daypart from a day's guest checks (reuses the detailLines already in the
// getGuestChecks payload — no extra API call). Returns { [group]: { Morning, Midday, Afternoon,
// Evening } } of unit counts, skipping voids/modifiers, or null when the group map is empty.
export function extractCategoryDaypart(checks, groupMap) {
  if (!groupMap || groupMap.size === 0) return null;
  const out = {};
  for (const c of (checks || [])) {
    const dp = daypartFor(etHour(c.opnUTC));
    if (!dp) continue;
    for (const d of (c.detailLines || [])) {
      if (!d.menuItem || d.vdFlag || (d.dspQty || 0) <= 0) continue;
      const info = groupMap.get(String(d.menuItem.miNum));
      const group = info?.group;
      if (!group || group === 'modifier' || group === 'other') continue;
      if (!out[group]) out[group] = { Morning: 0, Midday: 0, Afternoon: 0, Evening: 0 };
      out[group][dp] += d.dspQty;
    }
  }
  // Round + drop empty groups.
  for (const g of Object.keys(out)) {
    let any = 0;
    for (const dp of DAYPARTS) { out[g][dp] = Math.round(out[g][dp] * 10) / 10; any += out[g][dp]; }
    if (any <= 0) delete out[g];
  }
  return Object.keys(out).length ? out : null;
}

// One store's daily menu-item totals, rolled up two ways in a SINGLE getMenuItemDailyTotals
// call: (1) sales by category { hot_beverages:{sales,count}, ... }, and (2) units/sales for any
// tracked new products (registry from new-products.mjs, matched by item name). groupMap is
// miNum → { group, name }. Returns { categories, newProducts } (each null when empty).
export async function fetchItemMix(pc, date, groupMap, registry = []) {
  if (!groupMap || groupMap.size === 0) return { categories: null, newProducts: null };
  const cfg = APIS[apiRoute(pc)];
  try {
    const json = await postJSON(cfg, 'getMenuItemDailyTotals', {
      locRef: pc, busDt: date,
      searchCriteria: 'where greaterThan(revenueCenters.menuItems.slsCnt, 0)',
      include: 'revenueCenters.menuItems.miNum,revenueCenters.menuItems.slsTtl,revenueCenters.menuItems.slsCnt',
    });
    const cats = {};
    const newProducts = {};
    const track = Array.isArray(registry) && registry.length > 0;
    for (const rc of (json?.revenueCenters || [])) {
      for (const mi of (rc.menuItems || [])) {
        const info = groupMap.get(String(mi.miNum));
        const group = info?.group || 'other';
        const sales = mi.slsTtl || 0, count = mi.slsCnt || 0;
        if (group !== 'modifier') {
          if (!cats[group]) cats[group] = { sales: 0, count: 0 };
          cats[group].sales += sales;
          cats[group].count += count;
        }
        // New-product matching by item name (case-insensitive substring).
        if (track && info?.name) {
          for (const id of matchNewProducts(registry, info.name)) {
            if (!newProducts[id]) newProducts[id] = { units: 0, sales: 0 };
            newProducts[id].units += count;
            newProducts[id].sales += sales;
          }
        }
      }
    }
    for (const g in cats) cats[g].sales = Math.round(cats[g].sales * 100) / 100;
    for (const id in newProducts) newProducts[id].sales = Math.round(newProducts[id].sales * 100) / 100;
    return {
      categories: Object.keys(cats).length ? cats : null,
      newProducts: Object.keys(newProducts).length ? newProducts : null,
    };
  } catch (e) {
    console.warn(`[hourly-snapshot] item mix failed for ${pc}: ${e.message}`);
    return { categories: null, newProducts: null };
  }
}

// ET hour (0–23) a guest check opened, from its UTC open timestamp. null if unparseable.
function etHour(opnUTC) {
  const raw = opnUTC || '';
  if (!raw) return null;
  const dt = new Date(raw.endsWith('Z') ? raw : raw + 'Z');
  if (isNaN(dt.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).formatToParts(dt);
  return parseInt(parts.find(p => p.type === 'hour').value, 10) % 24;
}

// Given a day's guest checks + a route's bakery class map, return donut/munchkin units
// shaped for storage: { bakery: { sub: { total, byHour:{h:units} } }, flavors: {name:units} }.
// Shared by the nightly snapshot and the one-time backfill so both produce identical data.
export function extractBakery(checks, bakeryClass) {
  const bakeryByHour = {}; // h → { donut, munchkin }
  const flavors = {};      // item name → units sold that day
  if (bakeryClass && bakeryClass.size > 0) {
    for (const c of checks) {
      const h = etHour(c.opnUTC);
      if (h === null) continue;
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
  const bakery = {};
  for (const sub of ['donut', 'munchkin']) {
    const byHour = {};
    let total = 0;
    for (const [h, v] of Object.entries(bakeryByHour)) {
      if (v[sub] > 0) { byHour[h] = Math.round(v[sub] * 10) / 10; total += v[sub]; }
    }
    bakery[sub] = { total: Math.round(total * 10) / 10, byHour };
  }
  return { bakery, flavors };
}

async function fetchHourlySales(pc, busDt, bakeryClass, groupMap = null) {
  const cfg = APIS[apiRoute(pc)];
  try {
    const json = await postJSON(cfg, 'getGuestChecks', {
      locRef: pc,
      busDt,
      include: 'guestChecks.opnUTC,guestChecks.subTtl,guestChecks.chkTtl,guestChecks.detailLines',
    });

    const checks = json.guestChecks || [];
    const byHour = {};
    let upsoldChecks = 0;
    let totalChecks = 0;

    for (const c of checks) {
      const h = etHour(c.opnUTC);
      if (h === null) continue;

      if (!byHour[h]) byHour[h] = { h, sales: 0, checks: 0 };
      byHour[h].sales  += c.chkTtl || c.subTtl || 0;
      byHour[h].checks += 1;

      totalChecks += 1;
      if (itemCountForCheck(c) >= 2) upsoldChecks += 1;
    }

    const hours = Object.values(byHour)
      .map(e => ({ ...e, sales: Math.round(e.sales * 100) / 100 }))
      .sort((a, b) => a.h - b.h);

    const upsellRate = totalChecks > 0 ? Math.round((upsoldChecks / totalChecks) * 1000) / 10 : null;

    // Donut/munchkin units + category-by-daypart mix (both from the detailLines already in the
    // payload — no extra API calls).
    const { bakery, flavors } = extractBakery(checks, bakeryClass);
    const catDaypart = extractCategoryDaypart(checks, groupMap);

    return { hours, upsoldChecks, totalChecks, upsellRate, bakery, flavors, catDaypart };

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
export function dowFor(date) {
  return new Date(`${date}T12:00:00`).getDay();
}

// Per-store donut/munchkin history → pcg_item_history_{pc} (separate blob from the
// hourly sales history so existing analyst consumers are untouched). Feeds the Par
// Level Optimizer: per-DOW unit baselines + hourly series for mid-day stockout detection.
export async function appendItemSnapshot(pc, date, weather, bakery, flavors, categories, catDaypart = null, newProducts = null) {
  const key = `pcg_item_history_${pc}`;
  const existing = (await cacheLoad(key)) || [];
  const entries = Array.isArray(existing) ? existing : [];
  const filtered = entries.filter(e => e.date !== date); // idempotent on re-run
  filtered.unshift({ date, dow: dowFor(date), weather, bakery, flavors, categories: categories || null, catDaypart: catDaypart || null, newProducts: newProducts || null });
  await cacheSave(key, filtered.slice(0, MAX_HISTORY_DAYS));
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async () => {
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
  const routeGroup = {};
  for (const route of [...new Set(STORES.map(s => apiRoute(s.pc)))]) {
    const rep = STORES.find(s => apiRoute(s.pc) === route);
    routeClass[route] = await buildBakeryClassMap(rep.pc);
    routeGroup[route] = await buildItemGroupMap(rep.pc);
  }
  console.log(`[hourly-snapshot] Bakery items mapped: ${Object.entries(routeClass).map(([r, m]) => `${r}:${m.size}`).join(' ')} · category items: ${Object.entries(routeGroup).map(([r, m]) => `${r}:${m.size}`).join(' ')}`);

  // Tracked new-product registry (loaded once, matched against each store's menu-item totals).
  const registry = await loadNewProductRegistry(cacheLoad);
  if (registry.length) console.log(`[hourly-snapshot] Tracking ${registry.length} new product(s): ${registry.map(p => p.name).join(', ')}`);

  // Process all stores in batches of 8
  let saved = 0, failed = 0;
  const BATCH = 8;

  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (store) => {
      const classMap = routeClass[apiRoute(store.pc)];
      const groupMap = routeGroup[apiRoute(store.pc)];
      const result = await fetchHourlySales(store.pc, date, classMap, groupMap);
      if (result === null) { failed++; return; }

      const { hours, bakery, flavors, catDaypart, ...upsell } = result;
      const weather = districtWeather[String(store.district)] || null;
      await appendSnapshot(store.pc, date, hours, weather, upsell);
      // Only record bakery/category history when the class map built — otherwise a transient
      // dimensions-fetch failure would persist false zeros that look like a real
      // zero-sales day and skew the Par Optimizer's per-DOW baselines.
      if (classMap && classMap.size > 0) {
        const { categories, newProducts } = await fetchItemMix(store.pc, date, groupMap, registry);
        await appendItemSnapshot(store.pc, date, weather, bakery, flavors, categories, catDaypart, newProducts);
      }
      saved++;
    }));
  }

  console.log(`[hourly-snapshot] Complete: ${saved} saved, ${failed} failed`);
  return new Response(JSON.stringify({ date, saved, failed, districtWeather }), { status: 200 });
};
