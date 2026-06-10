// analyst-data.js — Unified data access layer for the Analyst
// This is the ONLY module that reads raw data sources.
// TODO (Phase 2): Swap blob reads for Postgres/Supabase queries.

const https = require('https');
const { cacheLoad, cacheSave } = require('./analyst-cache');
const { summarizeProjects, summarizeTickets, summarizeCash, summarizeFoodCost, compactComputed, summarizeUpsell, renderOpsContext } = require('./ops-summaries');
const { BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, INGREDIENT_COSTS } = require('./cost-lookup');
const { sql } = require('../db');

// ── Pulse POS direct fetcher (same API as pulse-hourly-snapshot.js) ─────────
const POS_APIS = {
  p227: { host: 'pos-ra.dunkindonuts.com', path: '/p227', xkey: 'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL', apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
  p228: { host: 'pos-ra.dunkindonuts.com', path: '/p228', xkey: 'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP', apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
};
function pulseRoute(pc) { return String(pc) === '345986' ? 'p227' : 'p228'; }

function pulsePostJSON(pc, endpoint, body) {
  const cfg = POS_APIS[pulseRoute(pc)];
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: cfg.host, port: 443, path: `${cfg.path}/${endpoint}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.xkey, 'Api-Key': cfg.apikey, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); } catch { resolve(null); }
        } else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function todayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

/** Fetch today's voided/refunded checks for a store from Pulse POS */
async function getVoidsAndRefunds(pc, busDt) {
  try {
    const json = await pulsePostJSON(pc, 'getGuestChecks', {
      locRef: pc,
      busDt: busDt || todayET(),
      include: 'guestChecks.chkNum,guestChecks.opnUTC,guestChecks.chkTtl,guestChecks.vdTtl,guestChecks.rtrnCnt',
    });
    const checks = json?.guestChecks || [];
    return checks
      .filter(c => (c.vdTtl && Math.abs(c.vdTtl) > 0) || (c.rtrnCnt || 0) > 0 || (c.chkTtl || 0) < 0)
      .map(c => {
        const raw = c.opnUTC || '';
        const dt = raw ? new Date(raw.endsWith('Z') ? raw : raw + 'Z') : null;
        const time = dt && !isNaN(dt.getTime())
          ? dt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
          : 'unknown time';
        let type = 'void';
        if ((c.rtrnCnt || 0) > 0 || (c.chkTtl || 0) < 0) type = 'refund';
        return { chkNum: c.chkNum, time, type, amount: c.vdTtl || c.chkTtl || 0 };
      });
  } catch (e) {
    console.warn(`[analyst-data] getVoidsAndRefunds failed for ${pc}: ${e.message}`);
    return [];
  }
}

// ── Store config (mirrors index.html STORES_SEED) ───────────────────────────
const STORES = [
  { pc:"339616", paycor:"193919", name:"Wadsworth",       district:1 },
  { pc:"340794", paycor:"193904", name:"Front",           district:1 },
  { pc:"351099", paycor:"193900", name:"Sonic",           district:2 },
  { pc:"351259", paycor:"193892", name:"Rosemore",        district:2 },
  { pc:"302642", paycor:"193914", name:"County Line",     district:2 },
  { pc:"352894", paycor:"193890", name:"Street Rd",       district:2 },
  { pc:"341350", paycor:"193920", name:"Yardley",         district:2 },
  { pc:"337839", paycor:"193888", name:"Warrington",      district:2 },
  { pc:"330338", paycor:"193887", name:"Drexel Hill",     district:3 },
  { pc:"337063", paycor:"193902", name:"Sharon Hill",     district:3 },
  { pc:"343832", paycor:"193876", name:"Lansdowne",       district:3 },
  { pc:"304669", paycor:"193894", name:"Collingdale",     district:3 },
  { pc:"355146", paycor:"193895", name:"Gallery",         district:3 },
  { pc:"300496", paycor:"193906", name:"Cobbs Creek",     district:3 },
  { pc:"304863", paycor:"193885", name:"18th St",         district:3 },
  { pc:"354561", paycor:"193910", name:"Carlisle",        district:3 },
  { pc:"332393", paycor:"193907", name:"Lindbergh",       district:3 },
  { pc:"341167", paycor:"193893", name:"5th Street",      district:4 },
  { pc:"340870", paycor:"193912", name:"Hunting Park",    district:4 },
  { pc:"335981", paycor:"193873", name:"Lehigh",          district:4 },
  { pc:"353150", paycor:"193903", name:"Bakers Square",   district:4 },
  { pc:"351050", paycor:"193877", name:"Allegheny",       district:4 },
  { pc:"345985", paycor:"193916", name:"Wissahickon",     district:4 },
  { pc:"356374", paycor:"193898", name:"Montgomeryville", district:5 },
  { pc:"353843", paycor:"193891", name:"Tollgate",        district:5 },
  { pc:"353047", paycor:"193875", name:"Silverdale",      district:5 },
  { pc:"340538", paycor:"193879", name:"Easton",          district:5 },
  { pc:"343079", paycor:"193901", name:"Downingtown",     district:6 },
  { pc:"342144", paycor:"193908", name:"Westchester",     district:6 },
  { pc:"364295", paycor:"193881", name:"Lionville",       district:6 },
  { pc:"365361", paycor:"194373", name:"Little Welsh",    district:7 },
  { pc:"310382", paycor:"193899", name:"Grant",           district:7 },
  { pc:"332941", paycor:"193884", name:"Bustleton",       district:7 },
  { pc:"343497", paycor:"193874", name:"Red Lion",        district:7 },
  { pc:"302446", paycor:"193878", name:"Little Red Lion", district:7 },
  { pc:"337079", paycor:"193911", name:"Holme Circle",    district:7 },
  { pc:"345986", paycor:"193896", name:"Willits",         district:7 },
  { pc:"364412", paycor:"193905", name:"8200",            district:7 },
  { pc:"345489", paycor:"193880", name:"Oxford",          district:7 },
  { pc:"336372", paycor:"193897", name:"Elkins Park",     district:7 },
  { pc:"358933", paycor:"193886", name:"Brace Rd",        district:8 },
  { pc:"354865", paycor:"193915", name:"Quakertown",      district:8 },
  { pc:"353689", paycor:"193883", name:"Fort Washington", district:8 },
  { pc:"342184", paycor:"193917", name:"Lansdale",        district:8 },
  { pc:"356316", paycor:"193889", name:"BJ's",            district:8 },
];

// ── Data accessors ──────────────────────────────────────────────────────────

/** Get the network labor summary (from labor-cron blob) */
async function getNetworkLabor() {
  return cacheLoad('pcg_labor_v1');
}

/** Get per-store labor history (daily + weekly arrays) */
async function getStoreLabor(pc) {
  return cacheLoad(`pcg_labor_store_${pc}`);
}

/** Get all stores config */
function getAllStores() {
  return STORES;
}

/** Get stores filtered by district */
function getStoresByDistrict(districtNum) {
  return STORES.filter(s => s.district === districtNum);
}

/**
 * Build a KPI snapshot for the Analyst.
 * Combines network labor data with per-store summaries.
 * Optionally filtered by district.
 */
async function buildKPISnapshot({ district } = {}) {
  const labor = await getNetworkLabor();
  if (!labor) return { error: 'No labor data available. Cron may not have run yet.' };

  const stores = district ? getStoresByDistrict(district) : STORES;
  const storePCs = new Set(stores.map(s => s.pc));

  // Build per-store summaries from the network blob
  const storeData = labor.stores || {};
  const filteredStores = [];
  let totalLaborDollars = 0, totalSales = 0, totalScheduledNow = 0, totalOT = 0;

  for (const s of stores) {
    const sd = storeData[s.pc];
    if (!sd) continue;
    const today = sd.today || {};
    const wtd = sd.wtd || {};
    filteredStores.push({
      name: s.name,
      district: s.district,
      today: {
        laborDollars: today.laborDollars || 0,
        sales: today.sales || 0,
        laborPct: today.laborPct || 0,
        scheduledNow: today.scheduledNow || 0,
        employeesWorked: today.employeesOnClock || 0,
        overtimeCount: today.overtimeCount || 0,
      },
      wtd: {
        laborDollars: wtd.laborDollars || 0,
        sales: wtd.sales || 0,
        laborPct: wtd.laborPct || 0,
      },
      error: sd.error || null,
    });
    totalLaborDollars += today.laborDollars || 0;
    totalSales += today.sales || 0;
    totalScheduledNow += today.scheduledNow || 0;
    totalOT += today.overtimeCount || 0;
  }

  const networkLaborPct = totalSales > 0 ? (totalLaborDollars / totalSales) * 100 : 0;

  return {
    asOf: labor.lastUpdated,
    busDt: labor.busDt,
    scope: district ? `District ${district}` : 'Network',
    network: {
      laborDollars: Math.round(totalLaborDollars * 100) / 100,
      sales: Math.round(totalSales * 100) / 100,
      laborPct: Math.round(networkLaborPct * 10) / 10,
      scheduledNow: totalScheduledNow,
      overtimeCount: totalOT,
      storeCount: filteredStores.length,
    },
    stores: filteredStores,
  };
}

/**
 * Build a compact data context string for LLM prompts.
 * Keeps token count low by summarizing.
 */
async function buildDataContext({ district, includeStoreDetail } = {}) {
  const snapshot = await buildKPISnapshot({ district });
  const opsContext = await buildOpsContext({ district: district || null });
  if (snapshot.error) return snapshot.error + opsContext;

  let context = `Data as of: ${snapshot.asOf}\nBusiness date: ${snapshot.busDt}\nScope: ${snapshot.scope}\n\n`;
  context += `NETWORK SUMMARY:\n`;
  context += `  Total Sales Today: $${snapshot.network.sales.toLocaleString()}\n`;
  context += `  Total Labor Today: $${snapshot.network.laborDollars.toLocaleString()}\n`;
  context += `  Labor %: ${snapshot.network.laborPct}%\n`;
  context += `  Scheduled Now: ${snapshot.network.scheduledNow}\n`;
  context += `  Overtime Count: ${snapshot.network.overtimeCount}\n`;
  context += `  Stores: ${snapshot.network.storeCount}\n\n`;

  if (includeStoreDetail !== false) {
    // Group stores by district so the LLM never confuses district assignments
    const byDistrict = {};
    for (const s of snapshot.stores) {
      const d = s.district || 0;
      if (!byDistrict[d]) byDistrict[d] = [];
      byDistrict[d].push(s);
    }

    context += `STORE BREAKDOWN BY DISTRICT:\n`;
    context += `IMPORTANT: Each store belongs ONLY to the district listed below. Do NOT group stores across districts.\n\n`;
    for (const d of Object.keys(byDistrict).sort((a, b) => a - b)) {
      const stores = byDistrict[d];
      const distSales = stores.reduce((sum, s) => sum + (s.today.sales || 0), 0);
      const distLabor = stores.reduce((sum, s) => sum + (s.today.laborDollars || 0), 0);
      const distLaborPct = distSales > 0 ? (distLabor / distSales) * 100 : 0;
      context += `── District ${d} (${stores.length} stores, Sales $${Math.round(distSales).toLocaleString()}, Labor ${distLaborPct.toFixed(1)}%) ──\n`;
      // Sort within district by labor % descending
      stores.sort((a, b) => (b.today.laborPct || 0) - (a.today.laborPct || 0));
      for (const s of stores) {
        if (s.error) {
          context += `  ${s.name}: ERROR - ${s.error}\n`;
          continue;
        }
        context += `  ${s.name}: Sales $${s.today.sales.toLocaleString()}, Labor $${s.today.laborDollars.toLocaleString()} (${s.today.laborPct}%), OT: ${s.today.overtimeCount}`;
        if (s.wtd.sales > 0) context += ` | WTD Sales $${s.wtd.sales.toLocaleString()}, WTD Labor ${s.wtd.laborPct}%`;
        context += `\n`;
      }
      context += `\n`;
    }
  }

  return context + opsContext;
}

/**
 * Get recent daily history for a store (for trend analysis).
 */
async function getStoreDailyHistory(pc, days = 7) {
  const history = await getStoreLabor(pc);
  if (!history?.daily) return [];
  return history.daily.slice(0, days);
}

/**
 * Build a data context scoped to a single store (for manager-level Orion access).
 */
async function buildStoreContext({ storePC }) {
  if (!storePC) return "No store data available.";
  const store = STORES.find(s => s.pc === storePC);
  if (!store) return "Store not found.";

  const sections = [];
  sections.push(`Store: ${store.name} (PC# ${storePC}), District ${store.district}`);

  // Load labor data for this store from network blob
  const labor = await cacheLoad('pcg_labor_v1');
  if (labor && labor.stores && labor.stores[storePC]) {
    const sd = labor.stores[storePC];
    const today = sd.today || {};
    const wtd = sd.wtd || {};
    sections.push(`\nToday (${labor.busDt || 'current'}):`);
    sections.push(`  Sales: $${(today.sales || 0).toLocaleString()}`);
    sections.push(`  Labor: $${(today.laborDollars || 0).toLocaleString()}`);
    sections.push(`  Labor %: ${(today.laborPct || 0).toFixed(1)}%`);
    sections.push(`  Scheduled Now: ${today.scheduledNow || 0}`);
    sections.push(`  Overtime Count: ${today.overtimeCount || 0}`);
    sections.push(`\nWeek-to-Date:`);
    sections.push(`  WTD Sales: $${(wtd.sales || 0).toLocaleString()}`);
    sections.push(`  WTD Labor: $${(wtd.laborDollars || 0).toLocaleString()}`);
    sections.push(`  WTD Labor %: ${(wtd.laborPct || 0).toFixed(1)}%`);
  }

  // Load per-store labor history
  const storeHistory = await cacheLoad(`pcg_labor_store_${storePC}`);
  if (storeHistory) {
    const daily = storeHistory.daily?.slice(0, 7) || [];
    const weekly = storeHistory.weekly?.slice(0, 4) || [];
    if (daily.length) {
      sections.push(`\nRecent daily labor (last 7 days):`);
      daily.forEach(d => {
        sections.push(`  ${d.date}: Labor $${(d.laborCost || 0).toFixed(0)}, Sales $${(d.sales || 0).toFixed(0)}, Labor% ${(d.laborPct || 0).toFixed(1)}%`);
      });
    }
    if (weekly.length) {
      sections.push(`\nRecent weekly labor:`);
      weekly.forEach(w => {
        sections.push(`  Week of ${w.weekStart}: Labor $${(w.laborCost || 0).toFixed(0)}, Sales $${(w.sales || 0).toFixed(0)}, Labor% ${(w.laborPct || 0).toFixed(1)}%`);
      });
    }
  }

  // Load recent sales/upsell history (from pulse-hourly-snapshot)
  const hourlyHistory = await cacheLoad(`pcg_hourly_history_${storePC}`).catch(() => null);
  const recentDays = (Array.isArray(hourlyHistory) ? hourlyHistory : []).slice(0, 7);
  if (recentDays.length > 0) {
    sections.push(`\nRecent daily sales (last ${recentDays.length} days):`);
    recentDays.forEach(d => {
      const daySales = (d.hours || []).reduce((s, h) => s + (h.sales || 0), 0);
      const dayChecks = (d.hours || []).reduce((s, h) => s + (h.checks || 0), 0);
      const avgCheck = dayChecks > 0 ? daySales / dayChecks : 0;
      let line = `  ${d.date}: $${daySales.toFixed(0)} sales, ${dayChecks} checks, $${avgCheck.toFixed(2)} avg check`;
      if (typeof d.upsellRate === 'number') line += `, ${d.upsellRate}% upsell rate (${d.upsoldChecks}/${d.totalChecks} checks with 2+ items)`;
      sections.push(line);
    });
  }

  // Compare against same-district stores (proxy for "nearest" stores)
  const districtMates = STORES.filter(s => s.district === store.district && s.pc !== storePC);
  if (districtMates.length > 0 && recentDays.length > 0) {
    const latest = recentDays[0];
    const mySales = (latest.hours || []).reduce((s, h) => s + (h.sales || 0), 0);
    const myChecks = (latest.hours || []).reduce((s, h) => s + (h.checks || 0), 0);
    const myAvgCheck = myChecks > 0 ? mySales / myChecks : null;
    const myUpsell = typeof latest.upsellRate === 'number' ? latest.upsellRate : null;

    const mateStats = [];
    for (const mate of districtMates) {
      const mateHistory = await cacheLoad(`pcg_hourly_history_${mate.pc}`).catch(() => null);
      const mateLatest = Array.isArray(mateHistory) ? mateHistory[0] : null;
      if (!mateLatest) continue;
      const mateSales = (mateLatest.hours || []).reduce((s, h) => s + (h.sales || 0), 0);
      const mateChecks = (mateLatest.hours || []).reduce((s, h) => s + (h.checks || 0), 0);
      const mateAvgCheck = mateChecks > 0 ? mateSales / mateChecks : null;
      mateStats.push({
        name: mate.name,
        date: mateLatest.date,
        avgCheck: mateAvgCheck,
        upsellRate: typeof mateLatest.upsellRate === 'number' ? mateLatest.upsellRate : null,
      });
    }

    if (mateStats.length > 0) {
      sections.push(`\nNearby store comparison (District ${store.district}, ${latest.date}):`);
      sections.push(`  ${store.name}: $${(myAvgCheck ?? 0).toFixed(2)} avg check${myUpsell !== null ? `, ${myUpsell}% upsell rate` : ''}`);
      mateStats.forEach(m => {
        sections.push(`  ${m.name} (${m.date}): $${(m.avgCheck ?? 0).toFixed(2)} avg check${m.upsellRate !== null ? `, ${m.upsellRate}% upsell rate` : ''}`);
      });
    }
  }

  // Load today's voids/refunds from Pulse POS
  const busDtForVoids = labor?.busDt || todayET();
  const voidsRefunds = await getVoidsAndRefunds(storePC, busDtForVoids);
  if (voidsRefunds.length > 0) {
    sections.push(`\nVoids/refunds today (${busDtForVoids}):`);
    voidsRefunds.forEach(v => {
      sections.push(`  ${v.time} — ${v.type} — receipt #${v.chkNum} — $${Math.abs(v.amount).toFixed(2)}`);
    });
  } else {
    sections.push(`\nVoids/refunds today (${busDtForVoids}): none`);
  }

  // Load review sentiment for this store
  const reviews = await cacheLoad(`pcg_reviews_${storePC}`).catch(() => null);
  if (reviews) {
    sections.push(`\nGuest reviews: ★${reviews.googleRating ?? '?'} (${reviews.totalReviews ?? 0} total), trend: ${reviews.trendDirection || 'unknown'}`);
    const negWithActions = (reviews.reviews || []).filter(r => r.sentiment === 'negative' && r.actionItem).slice(0, 5);
    if (negWithActions.length > 0) {
      sections.push(`  Recent negative review themes/actions:`);
      negWithActions.forEach(r => sections.push(`    - ${r.actionItem}`));
    }
  }

  // Load open tickets for this store
  const ticketsRaw = await cacheLoad('pcg_tickets_v1').catch(() => null);
  const openTickets = Array.isArray(ticketsRaw)
    ? ticketsRaw.filter(t => t.status !== 'Closed' && String(t.storePC) === String(storePC))
    : [];
  if (openTickets.length > 0) {
    sections.push(`\nOpen tickets (${openTickets.length}):`);
    openTickets.slice(0, 10).forEach(t => {
      const days = Math.floor((Date.now() - new Date(t.createdAt || 0).getTime()) / 86400000);
      sections.push(`  [${t.priority || 'Normal'}] ${t.title} — ${t.category || 'General'} — open ${days}d${t.description ? ' — ' + t.description.slice(0, 80) : ''}`);
    });
  } else {
    sections.push(`\nOpen tickets: none`);
  }

  // Load this week's NDCP/DCP spend from Postgres
  try {
    const db = sql();
    const wkStart = new Date();
    wkStart.setDate(wkStart.getDate() - wkStart.getDay()); // Sunday
    wkStart.setHours(0, 0, 0, 0);
    const rows = await db`
      SELECT DISTINCT ON (order_number) total_order, email_date
      FROM ndcp_orders
      WHERE account = ${String(storePC)}
        AND order_number IS NOT NULL
        AND email_date >= ${wkStart.toISOString()}::timestamptz
      ORDER BY order_number, email_date DESC NULLS LAST`;
    const wtdNdcp = rows.reduce((sum, r) => sum + (Number(r.total_order) || 0), 0);
    sections.push(`\nDCP spend this week: $${wtdNdcp.toFixed(2)}`);
    if (labor?.stores?.[storePC]?.wtd?.sales > 0) {
      const dcpPct = (wtdNdcp / labor.stores[storePC].wtd.sales) * 100;
      sections.push(`  DCP % of WTD sales: ${dcpPct.toFixed(1)}% (target ≤20%)`);
    }
  } catch {
    // Non-fatal — NDCP DB unavailable
  }

  // Load today's schedule from the schedule blob
  const schedule = await cacheLoad(`pcg_schedule_${storePC}`).catch(() => null);
  if (schedule?.shifts) {
    const todayStr = new Date().toISOString().slice(0, 10);
    const todayShifts = schedule.shifts.filter(s => (s.date || s.startDateTime?.slice(0, 10)) === todayStr);
    if (todayShifts.length > 0) {
      sections.push(`\nToday's schedule (${todayShifts.length} shifts):`);
      todayShifts
        .sort((a, b) => (a.startDateTime || '').localeCompare(b.startDateTime || ''))
        .forEach(s => {
          const start = s.startDateTime ? new Date(s.startDateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '?';
          const end   = s.endDateTime   ? new Date(s.endDateTime).toLocaleTimeString('en-US',   { hour: 'numeric', minute: '2-digit', hour12: true }) : '?';
          sections.push(`  ${s.employeeName || 'Unknown'}: ${start} – ${end}${s.position ? ' (' + s.position + ')' : ''}`);
        });
    } else {
      sections.push(`\nToday's schedule: no shifts posted yet`);
    }
    // Also include tomorrow's shifts if available
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const tomorrowShifts = schedule.shifts.filter(s => (s.date || s.startDateTime?.slice(0, 10)) === tomorrowStr);
    if (tomorrowShifts.length > 0) {
      sections.push(`\nTomorrow's schedule (${tomorrowShifts.length} shifts):`);
      tomorrowShifts
        .sort((a, b) => (a.startDateTime || '').localeCompare(b.startDateTime || ''))
        .forEach(s => {
          const start = s.startDateTime ? new Date(s.startDateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '?';
          const end   = s.endDateTime   ? new Date(s.endDateTime).toLocaleTimeString('en-US',   { hour: 'numeric', minute: '2-digit', hour12: true }) : '?';
          sections.push(`  ${s.employeeName || 'Unknown'}: ${start} – ${end}`);
        });
    }
  }

  return sections.join("\n");
}

async function getWeatherForecast() {
  return cacheLoad('pcg_weather_forecast');
}

async function getWeatherCorrelations() {
  return cacheLoad('pcg_weather_correlations');
}

async function buildWeatherContext({ district } = {}) {
  const forecast = await getWeatherForecast();
  const correlations = await getWeatherCorrelations();
  if (!forecast) return '';

  const condIcon = { clear: 'Clear', cloudy: 'Cloudy', fog: 'Foggy', rain: 'Rain', snow: 'Snow', storm: 'Thunderstorm' };
  const districts = district ? [String(district)] : Object.keys(forecast);
  const lines = [];

  for (const d of districts) {
    const f = forecast[d];
    if (!f?.days?.length) continue;
    const corr = correlations?.[d] || {};
    const dayStrs = f.days.slice(0, 7).map(day => {
      const dow = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      const impact = corr[day.condition];
      const impactStr = impact && Math.abs(impact - 1) > 0.03
        ? ` (${impact > 1 ? '+' : ''}${Math.round((impact - 1) * 100)}% historical sales impact)`
        : '';
      return `${dow} ${condIcon[day.condition] || day.condition} ${day.tempHighF}°F${impactStr}`;
    });
    lines.push(`District ${d} forecast: ${dayStrs.join(', ')}`);
  }

  return lines.length > 0 ? '\n\nWEATHER FORECAST:\n' + lines.join('\n') : '';
}

async function getStoreReviews(pc) {
  return cacheLoad(`pcg_reviews_${pc}`);
}

async function getNetworkReviews() {
  return cacheLoad('pcg_reviews_network');
}

async function buildSentimentContext({ district } = {}) {
  const network = await getNetworkReviews();
  if (!network) return '';

  const lines = [];
  lines.push(`Network avg rating: ★${network.networkAvgRating}`);

  if (network.actionItems?.length > 0) {
    const filtered = district
      ? network.actionItems.filter(a => STORES.find(s => s.pc === a.pc)?.district === district)
      : network.actionItems.slice(0, 5);
    if (filtered.length > 0) {
      lines.push('Action items from recent reviews:');
      for (const item of filtered) {
        lines.push(`  - ${item.store}: ${item.action} (${item.reviewCount} review${item.reviewCount > 1 ? 's' : ''})`);
      }
    }
  }

  if (district && network.storeRatings) {
    const distStores = STORES.filter(s => s.district === district);
    const ratings = distStores.map(s => ({ name: s.name, rating: network.storeRatings[s.pc] })).filter(r => r.rating > 0);
    if (ratings.length > 0) {
      ratings.sort((a, b) => a.rating - b.rating);
      const worst = ratings[0];
      const best = ratings[ratings.length - 1];
      lines.push(`District ${district} ratings: best ${best.name} ★${best.rating}, lowest ${worst.name} ★${worst.rating}`);
    }
  }

  return lines.length > 1 ? '\n\nGUEST SENTIMENT:\n' + lines.join('\n') : '';
}

async function buildEmailContext() {
  const inbox = await cacheLoad('pcg_emails_inbox');
  if (!inbox?.emails?.length) return '';

  const unread = inbox.emails.filter(e => !e.isRead);
  if (unread.length === 0) return '';

  const lines = [`${unread.length} unread emails in shared inbox:`];
  const byCategory = {};
  for (const e of unread.slice(0, 10)) {
    const cat = e.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  }
  for (const [cat, emails] of Object.entries(byCategory)) {
    lines.push(`  ${cat}: ${emails.map(e => e.subject).join('; ')}`);
  }

  return '\n\nEMAIL INBOX:\n' + lines.join('\n');
}

// ── Operational datasets (projects, tickets, cash, food cost) ───────────────

async function buildProjectsContext({ district } = {}) {
  return summarizeProjects(await cacheLoad('pcg_projects_v1'), district || null, new Date(), STORES);
}

async function buildTicketsContext({ district } = {}) {
  return summarizeTickets(await cacheLoad('pcg_tickets_v1'), district || null, new Date(), STORES);
}

async function buildCashContext({ district } = {}) {
  return summarizeCash(await cacheLoad('pcg_cash_deposits_v1'), district || null, new Date(), STORES);
}

async function buildFoodCostContext() {
  const bev = await cacheLoad('pcg_food_cost_beverages_v1');
  const overlay = compactComputed(bev);
  return summarizeFoodCost(
    { beverages: BEVERAGE_COSTS, food: FOOD_COSTS, iceCream: ICE_CREAM_COSTS, ingredients: INGREDIENT_COSTS },
    overlay ? { beverages: overlay } : null
  );
}

async function buildUpsellContext({ district } = {}) {
  const stores = district ? STORES.filter(s => s.district === district) : STORES;
  const entries = await Promise.all(stores.map(async (s) => {
    const history = await cacheLoad(`pcg_hourly_history_${s.pc}`);
    const recent = (Array.isArray(history) ? history : [])
      .filter(e => typeof e.upsellRate === 'number')
      .slice(0, 7);
    if (recent.length === 0) return null;
    const avg = Math.round((recent.reduce((sum, e) => sum + e.upsellRate, 0) / recent.length) * 10) / 10;
    return { pc: s.pc, name: s.name, district: s.district, upsellRate: avg, days: recent.length };
  }));
  return summarizeUpsell(entries.filter(Boolean));
}

/** Render all four ops summaries as a text block for the prompt data section. */
async function buildOpsContext({ district } = {}) {
  try {
    const [projects, tickets, cash, foodCost, upsell] = await Promise.all([
      buildProjectsContext({ district }),
      buildTicketsContext({ district }),
      buildCashContext({ district }),
      buildFoodCostContext(),
      buildUpsellContext({ district }),
    ]);
    return renderOpsContext({ projects, tickets, cash, foodCost, upsell });
  } catch (err) {
    // One malformed blob record must never take down chat/briefs/reports —
    // degrade to "no ops data" rather than throwing out of buildDataContext.
    console.error('buildOpsContext failed:', err.message);
    return '';
  }
}

module.exports = {
  STORES,
  getAllStores,
  getStoresByDistrict,
  getNetworkLabor,
  getStoreLabor,
  buildKPISnapshot,
  buildDataContext,
  buildStoreContext,
  getStoreDailyHistory,
  getWeatherForecast,
  getWeatherCorrelations,
  buildWeatherContext,
  getStoreReviews,
  getNetworkReviews,
  buildSentimentContext,
  buildEmailContext,
  buildProjectsContext,
  buildTicketsContext,
  buildCashContext,
  buildFoodCostContext,
  buildOpsContext,
};
