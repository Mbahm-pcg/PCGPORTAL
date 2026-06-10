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

async function fetchHourlySales(pc, busDt) {
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
    }

    const hours = Object.values(byHour)
      .map(e => ({ ...e, sales: Math.round(e.sales * 100) / 100 }))
      .sort((a, b) => a.h - b.h);

    const upsellRate = totalChecks > 0 ? Math.round((upsoldChecks / totalChecks) * 1000) / 10 : null;

    return { hours, upsoldChecks, totalChecks, upsellRate };

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

  // Process all stores in batches of 8
  let saved = 0, failed = 0;
  const BATCH = 8;

  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (store) => {
      const result = await fetchHourlySales(store.pc, date);
      if (result === null) { failed++; return; }

      const { hours, ...upsell } = result;
      const weather = districtWeather[String(store.district)] || null;
      await appendSnapshot(store.pc, date, hours, weather, upsell);
      saved++;
    }));
  }

  console.log(`[hourly-snapshot] Complete: ${saved} saved, ${failed} failed`);
  return { statusCode: 200, body: JSON.stringify({ date, saved, failed, districtWeather }) };
};
