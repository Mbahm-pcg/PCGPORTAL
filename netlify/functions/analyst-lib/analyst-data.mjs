// analyst-data.js — Unified data access layer for the Analyst
// This is the ONLY module that reads raw data sources.
// TODO (Phase 2): Swap blob reads for Postgres/Supabase queries.

import https from 'node:https';
import { cacheLoad, cacheSave } from './analyst-cache.mjs';
import { summarizeProjects, summarizeTickets, summarizeTasks, summarizeCash, summarizeFoodCost, compactComputed, summarizeUpsell, roundAvg, renderOpsContext } from './ops-summaries.mjs';
import { BEVERAGE_COSTS, FOOD_COSTS, ICE_CREAM_COSTS, INGREDIENT_COSTS } from './cost-lookup.mjs';
import { sql } from '../_shared/db.mjs';
import { SHIFT_WINDOWS as TASK_SHIFT_WINDOWS } from '../tasks-lib/catalog.js';
import { analyzeStoreMix } from './sales-attribution.mjs';
import { analyzeCrossStoreMix } from './sales-mix-compare.mjs';
import { analyzeNewProducts, loadNewProductRegistry } from './new-products.mjs';

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
      include: 'guestChecks.chkNum,guestChecks.opnUTC,guestChecks.chkTtl,guestChecks.vdTtl,guestChecks.mgrVdTtl,guestChecks.returnTtl',
    });
    const checks = json?.guestChecks || [];
    return checks
      .filter(c => Math.abs(c.vdTtl || 0) > 0 || Math.abs(c.mgrVdTtl || 0) > 0 || Math.abs(c.returnTtl || 0) > 0 || (c.chkTtl || 0) < 0)
      .map(c => {
        const raw = c.opnUTC || '';
        const dt = raw ? new Date(raw.endsWith('Z') ? raw : raw + 'Z') : null;
        const time = dt && !isNaN(dt.getTime())
          ? dt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })
          : 'unknown time';
        let type = 'void';
        if (Math.abs(c.returnTtl || 0) > 0 || (c.chkTtl || 0) < 0) type = 'refund';
        return { chkNum: c.chkNum, time, type, amount: c.vdTtl || c.mgrVdTtl || c.returnTtl || c.chkTtl || 0 };
      });
  } catch (e) {
    console.warn(`[analyst-data] getVoidsAndRefunds failed for ${pc}: ${e.message}`);
    return [];
  }
}

/** Net sales for a store on a date from Pulse (operations daily totals).
 *  Used to learn holiday factors from years of POS history. Returns null on
 *  miss/error so callers can skip a date cleanly. */
async function getDailyNetSales(pc, busDt) {
  try {
    const json = await pulsePostJSON(pc, 'getOperationsDailyTotals', { locRef: pc, busDt, include: 'locRef,busDt,revenueCenters' });
    const rcs = json?.revenueCenters || [];
    const net = rcs.reduce((s, rc) => s + (rc.netSlsTtl || 0), 0);
    return net > 0 ? net : null;
  } catch (e) {
    console.warn(`[analyst-data] getDailyNetSales failed for ${pc} ${busDt}: ${e.message}`);
    return null;
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
      pc: s.pc,
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
async function buildDataContext({ district, includeStoreDetail, includeVoids } = {}) {
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

  // Today's voids/refunds per district store (brief generation only — live POS calls)
  if (district && includeVoids) {
    try {
      const distStores = getStoresByDistrict(district);
      const busDt = snapshot.busDt || todayET();
      const all = await Promise.all(distStores.map(async s => ({ s, vr: await getVoidsAndRefunds(s.pc, busDt) })));
      context += `VOIDS/REFUNDS TODAY (${busDt}, District ${district}, per store):\n`;
      let any = false;
      for (const { s, vr } of all) {
        if (!vr.length) continue;
        any = true;
        const voids = vr.filter(v => v.type === 'void');
        const refunds = vr.filter(v => v.type === 'refund');
        const ttl = vr.reduce((sum, v) => sum + Math.abs(v.amount || 0), 0);
        const biggest = [...vr]
          .sort((a, b) => Math.abs(b.amount || 0) - Math.abs(a.amount || 0)).slice(0, 3)
          .map(v => `${v.time} ${v.type} receipt #${v.chkNum} $${Math.abs(v.amount || 0).toFixed(2)}`).join('; ');
        context += `  ${s.name}: ${voids.length} void(s), ${refunds.length} refund(s), $${ttl.toFixed(2)} total — largest: ${biggest}\n`;
      }
      if (!any) context += `  None recorded.\n`;
      context += `\n`;
    } catch (e) {
      console.warn(`[analyst-data] district voids/refunds failed: ${e.message}`);
    }
  }

  return context + opsContext;
}

// ── Store roster (metadata: status, Next-Gen, Baskin, asset, manager, address) ─
// Sourced from the pcg_stores_v1 cloud blob (the frontend's full store config) so
// Orion can answer roster questions ("who manages Bustleton", "address for PC#…",
// "which stores are Next-Gen / have drive-thru", "stores by manager"). Scoped to a
// district when given, so a DM only ever sees their own district's roster.
async function buildStoreRosterContext({ district = null, storePC = null } = {}) {
  let stores = null;
  try { stores = await cacheLoad('pcg_stores_v1'); } catch { stores = null; }
  if (!Array.isArray(stores) || !stores.length) return '';
  const ASSET = { DT: 'Drive-Thru', IL: 'In-Line', FS: 'Free Standing', GS: 'Gas Station', APOD: 'APOD' };
  let list = stores;
  if (district != null) list = list.filter(s => String(s.district) === String(district));
  if (storePC != null) list = list.filter(s => String(s.pc) === String(storePC));
  if (!list.length) return '';
  const lines = list
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .map(s => {
      const addr = [s.address, s.city, s.state, s.zip].filter(Boolean).join(', ');
      const tags = [s.isNextGen && 'Next-Gen', s.isBaskin && 'Baskin-Robbins', s.isBridge && 'Bridge'].filter(Boolean).join('/');
      return `• ${s.name || '—'} (PC ${s.pc}) — ${s.status || 'Open'}${tags ? ' · ' + tags : ''} · ${ASSET[s.baseAsset] || s.baseAsset || '—'} · Mgr: ${s.mgr || '—'}${s.mgrPhone ? ' ' + s.mgrPhone : ''} · ${addr || 'no address on file'} · District ${s.district || '—'}${s.dmName ? ` (DM ${s.dmName})` : ''}`;
    });
  const scopeLbl = district != null ? ` — District ${district}` : storePC != null ? '' : ' — network';
  return `\n\nSTORE ROSTER (${list.length} store${list.length !== 1 ? 's' : ''}${scopeLbl}). Use this for store metadata — status, Next-Gen/Baskin, asset type (Drive-Thru/In-Line/Free Standing/Gas Station), manager, address:\n${lines.join('\n')}`;
}

// ── Pulse comparison engine (DM intelligence) ───────────────────────────────
// Builds the time-comparison context a DM lives in: today-so-far vs yesterday at
// the SAME time of day, week-to-date vs last week, month-to-date vs last month —
// for sales, guest count (checks), average check, and labor %. "Today" is fetched
// LIVE from Pulse (getGuestChecks) so it's current to the hour; history comes from
// the cached pcg_hourly_history_{pc} blob (90 days, hour-by-hour) and the labor
// blob — so the only live calls are the district's own stores (~6), never 45.
// Sales here = sum of check totals (chkTtl||subTtl), matching how the hourly-history
// snapshot records sales, so today-vs-history is apples-to-apples. NOTE: Pulse weeks
// start SUNDAY (labor weeks start Monday — do not confuse them).

function etNowDate() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function currentETHour() { return etNowDate().getHours(); }
function ymdOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDaysYmd(ymd, n) { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return ymdOf(d); }
function weekdayOfYmd(ymd) { return new Date(ymd + 'T12:00:00').getDay(); } // 0=Sun
function etHourFromUTC(utc) {
  if (!utc) return null;
  // Force UTC interpretation even when the timestamp lacks a 'Z' (same guard as
  // getVoidsAndRefunds and pulse-hourly-snapshot's etHour) — otherwise a non-UTC
  // runtime would bucket today's checks into a different hour than the cached blob.
  const d = new Date(utc.endsWith('Z') ? utc : utc + 'Z');
  if (isNaN(d.getTime())) return null;
  const h = Number(d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  return Number.isFinite(h) ? (h === 24 ? 0 : h) : null;
}

// Today's checks so far, live from Pulse — ONE call yields sales, guest count,
// hourly buckets, and void/refund detail (so Wave-2 exceptions need no extra call).
// Sales = sum(chkTtl||subTtl) to match the hourly-history snapshot methodology.
async function getTodayLive(pc, busDt) {
  try {
    const json = await pulsePostJSON(pc, 'getGuestChecks', {
      locRef: pc, busDt,
      include: 'guestChecks.chkNum,guestChecks.opnUTC,guestChecks.subTtl,guestChecks.chkTtl,guestChecks.vdTtl,guestChecks.mgrVdTtl,guestChecks.returnTtl',
    });
    const checks = json?.guestChecks || [];
    let sales = 0, voidTtl = 0, voidCnt = 0, refundTtl = 0, refundCnt = 0;
    const byHour = {};
    const exceptions = [];
    for (const c of checks) {
      const amt = c.chkTtl || c.subTtl || 0;
      sales += amt;
      const h = etHourFromUTC(c.opnUTC);
      if (h != null) { if (!byHour[h]) byHour[h] = { h, sales: 0, checks: 0 }; byHour[h].sales += amt; byHour[h].checks += 1; }
      const v = Math.abs(c.vdTtl || 0) + Math.abs(c.mgrVdTtl || 0);
      const isRefund = Math.abs(c.returnTtl || 0) > 0 || (c.chkTtl || 0) < 0;
      if (v > 0) { voidTtl += v; voidCnt += 1; }
      if (isRefund) { refundTtl += Math.abs(c.returnTtl || c.chkTtl || 0); refundCnt += 1; }
      if (v > 0 || isRefund) {
        const raw = c.opnUTC || '';
        const dt = raw ? new Date(raw.endsWith('Z') ? raw : raw + 'Z') : null;
        const time = dt && !isNaN(dt.getTime()) ? dt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) : '?';
        exceptions.push({ type: isRefund ? 'refund' : 'void', amount: isRefund ? Math.abs(c.returnTtl || c.chkTtl || 0) : v, time, chkNum: c.chkNum });
      }
    }
    const hours = Object.values(byHour).map(e => ({ ...e, sales: Math.round(e.sales * 100) / 100 })).sort((a, b) => a.h - b.h);
    const r2 = n => Math.round(n * 100) / 100;
    return {
      sales: r2(sales), checks: checks.length, hours,
      voids: { count: voidCnt, total: r2(voidTtl) },
      refunds: { count: refundCnt, total: r2(refundTtl) },
      exceptions: exceptions.sort((a, b) => b.amount - a.amount).slice(0, 5),
    };
  } catch (e) {
    console.warn(`[analyst-data] getTodayLive failed for ${pc} ${busDt}: ${e.message}`);
    return null;
  }
}

// Today's daily operations totals — gross sales + discounts (not derivable from
// guest-check totals). One call per store; used for the exceptions/discount block.
async function getDailyOps(pc, busDt) {
  try {
    const json = await pulsePostJSON(pc, 'getOperationsDailyTotals', { locRef: pc, busDt, include: 'locRef,busDt,revenueCenters' });
    const rcs = json?.revenueCenters || [];
    const sum = f => rcs.reduce((s, rc) => s + (rc[f] || 0), 0);
    const disc = sum('dscntTtl') || (sum('itmDscTtl') + sum('subDscTtl'));
    return { net: sum('netSlsTtl'), gross: sum('grsSlsTtl'), guests: sum('chkCnt'), discounts: Math.round(disc * 100) / 100 };
  } catch (e) {
    console.warn(`[analyst-data] getDailyOps failed for ${pc} ${busDt}: ${e.message}`);
    return null;
  }
}

// One store's "today so far" — sales/checks/hourly/voids/refunds (getTodayLive) plus
// gross/discounts/net (getDailyOps), in two live Pulse calls. Used by pulse-compare-cron
// to pre-cache all stores into pcg_pulse_today_v1, and as the live fallback in
// buildPulseComparisonContext when that cache is cold/stale. Returns null if both fail.
async function getStoreToday(pc, busDt) {
  const day = busDt || todayET();
  const [live, ops] = await Promise.all([getTodayLive(pc, day), getDailyOps(pc, day)]);
  if (!live && !ops) return null;
  const base = live || { sales: 0, checks: 0, hours: [], voids: { count: 0, total: 0 }, refunds: { count: 0, total: 0 }, exceptions: [] };
  return { ...base, ops: ops || null };
}

// Sum cached hourly-history entries whose date falls in [fromYmd, toYmd] inclusive.
function sumHourlyEntries(entries, fromYmd, toYmd) {
  let sales = 0, checks = 0;
  for (const e of entries) {
    if (!e?.date || e.date < fromYmd || e.date > toYmd) continue;
    for (const h of (e.hours || [])) { sales += h.sales || 0; checks += h.checks || 0; }
  }
  return { sales: Math.round(sales * 100) / 100, checks };
}

// Cumulative sales/checks for a single day's entry through the given ET hour (inclusive).
function cumThroughHour(entry, hour) {
  let sales = 0, checks = 0;
  for (const h of (entry?.hours || [])) { if (h.h <= hour) { sales += h.sales || 0; checks += h.checks || 0; } }
  return { sales: Math.round(sales * 100) / 100, checks };
}

async function buildPulseComparisonContext({ district, storePC } = {}) {
  // Store scope (managers): same comparison engine over exactly one store, with
  // store-labelled rendering. District scope (DMs/execs) unchanged. Network (both
  // null) stays unsupported — 45 stores of text.
  const single = storePC != null ? STORES.find(s => s.pc === storePC) : null;
  if (storePC != null && !single) return '';
  if (single == null && district == null) return '';
  const stores = single ? [single] : getStoresByDistrict(district);
  if (!stores.length) return '';
  const scopeLabel = single ? `${single.name} (PC# ${single.pc})` : `District ${district}`;

  const today = todayET();
  const hour = currentETHour();

  // Today's live data comes from the pcg_pulse_today_v1 cache (written every ~30 min by
  // pulse-compare-cron) so the DM chat path makes ZERO live Pulse calls. If the cache is
  // missing or stale (>45 min, e.g. right after a deploy before the cron runs), fall back
  // to live per-store fetches for this district only (~6 stores).
  const todayBlob = await cacheLoad('pcg_pulse_today_v1').catch(() => null);
  const blobFresh = !!todayBlob && todayBlob.busDt === today && !!todayBlob.asOf &&
    (Date.now() - new Date(todayBlob.asOf).getTime() < 45 * 60 * 1000);
  const yesterday = addDaysYmd(today, -1);
  const thisSun = addDaysYmd(today, -weekdayOfYmd(today));
  const lastSun = addDaysYmd(thisSun, -7);
  const lastWkSameDay = addDaysYmd(lastSun, weekdayOfYmd(today));
  const t = new Date(today + 'T12:00:00');
  const dom = t.getDate();
  const thisMonthStart = ymdOf(new Date(t.getFullYear(), t.getMonth(), 1));
  const lastMonthStart = ymdOf(new Date(t.getFullYear(), t.getMonth() - 1, 1));
  const prevMonthDays = new Date(t.getFullYear(), t.getMonth(), 0).getDate();
  const lastMonthEnd = ymdOf(new Date(t.getFullYear(), t.getMonth() - 1, Math.min(dom, prevMonthDays)));

  const rows = await Promise.all(stores.map(async (s) => {
    const pc = s.pc;
    const [raw, hist, labor] = await Promise.all([
      (blobFresh && todayBlob.stores?.[pc]) ? Promise.resolve(todayBlob.stores[pc]) : getStoreToday(pc, today),
      cacheLoad(`pcg_hourly_history_${pc}`).catch(() => null),
      cacheLoad(`pcg_labor_store_${pc}`).catch(() => null),
    ]);
    const live = raw || null;
    const ops = live?.ops || null;
    const entries = Array.isArray(hist) ? hist : [];
    // Prefer the exact prior day; fall back to the most-recent entry only if it's within
    // ~3 days, so a cache gap can't make us label a 2-week-old day "yesterday same time".
    const minDate = addDaysYmd(today, -3);
    const yEntry = entries.find(e => e.date === yesterday) || (entries[0]?.date >= minDate ? entries[0] : null);
    const todayTot = live ? { sales: live.sales, checks: live.checks } : { sales: 0, checks: 0 };
    const yST = yEntry ? cumThroughHour(yEntry, hour) : { sales: 0, checks: 0 };
    const wtdCached = sumHourlyEntries(entries, thisSun, yesterday);
    const wtd = { sales: wtdCached.sales + todayTot.sales, checks: wtdCached.checks + todayTot.checks };
    const lastWtd = sumHourlyEntries(entries, lastSun, lastWkSameDay);
    const mtdCached = sumHourlyEntries(entries, thisMonthStart, yesterday);
    const mtd = { sales: mtdCached.sales + todayTot.sales, checks: mtdCached.checks + todayTot.checks };
    const lastMtd = sumHourlyEntries(entries, lastMonthStart, lastMonthEnd);
    const ld = labor?.daily?.[0] || {};
    return {
      name: s.name, live: !!live,
      today: todayTot, yST, wtd, lastWtd, mtd, lastMtd,
      hours: live?.hours || [],
      voids: live?.voids || { count: 0, total: 0 }, refunds: live?.refunds || { count: 0, total: 0 },
      exceptions: live?.exceptions || [],
      ops: ops || null,
      labor: { today: ld.laborPct ?? null },
    };
  }));

  // ── Render ──
  const ac = o => (o.checks > 0 ? o.sales / o.checks : 0);
  const money = n => '$' + Math.round(n).toLocaleString();
  const delta = (a, b) => (b > 0 ? `${a - b >= 0 ? '+' : ''}${Math.round(((a - b) / b) * 1000) / 10}%` : 'n/a');
  const pair = (cur, prev, label) =>
    `${label}: ${money(cur.sales)} (${delta(cur.sales, prev.sales)}) · ${cur.checks} guests (${delta(cur.checks, prev.checks)}) · avg chk ${money(ac(cur))} (${delta(ac(cur), ac(prev))})`;

  const sum = (sel) => rows.reduce((a, r) => ({ sales: a.sales + sel(r).sales, checks: a.checks + sel(r).checks }), { sales: 0, checks: 0 });
  const dTodaySoFar = sum(r => r.today), dYST = sum(r => r.yST);
  const dWtd = sum(r => r.wtd), dLastWtd = sum(r => r.lastWtd);
  const dMtd = sum(r => r.mtd), dLastMtd = sum(r => r.lastMtd);

  const tod = etNowDate();
  const clock = tod.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const dataAge = blobFresh ? Math.round((Date.now() - new Date(todayBlob.asOf).getTime()) / 60000) : 0;
  const freshNote = blobFresh ? ` (sales data ~${dataAge} min old)` : ' (live)';
  const netToday = rows.reduce((s, r) => s + (r.ops?.net || 0), 0);
  const lines = [];
  lines.push(`\n\nPULSE COMPARISON — ${scopeLabel}, as of ${clock} ET${freshNote}.`);
  lines.push(`Methodology: "today so far" = sales/guests through the current hour; "yesterday same time" = yesterday cumulative through the same hour. Avg check = sales ÷ guest checks. WTD = Sunday→today vs last Sun→same weekday. MTD = month 1st→today vs last month 1st→same day. SALES here are guest-check totals (include tax), so they run a few % above the NET sales shown in the main summary — that gap is expected, don't flag it as a discrepancy. Use this block for ALL today/yesterday/week/month comparison questions; do NOT invent figures beyond it.`);
  lines.push(single ? `\nSTORE TOTALS` : `\nDISTRICT TOTALS`);
  lines.push(`  ${pair(dTodaySoFar, dYST, 'Today so far vs yesterday same time')}`);
  if (netToday) lines.push(`  Today net sales (for reference, ties to main summary): ${money(netToday)}`);
  lines.push(`  ${pair(dWtd, dLastWtd, 'WTD vs last week')}`);
  lines.push(`  ${pair(dMtd, dLastMtd, 'MTD vs last month')}`);
  lines.push(single
    ? `\nSTORE DETAIL (today so far vs yesterday same time — sales, guests, avg check, labor%):`
    : `\nPER STORE (today so far vs yesterday same time — sales, guests, avg check, labor%):`);
  rows.sort((a, b) => b.today.sales - a.today.sales);
  for (const r of rows) {
    // Only today's labor% — labor WTD is a Monday-start week (Pulse sales WTD here is
    // Sunday-start), so showing them together as "WTD" would imply the same period.
    const labStr = r.labor.today != null ? `, labor ${r.labor.today}%` : '';
    const stale = r.live ? '' : ' [today live data unavailable]';
    lines.push(`  ${r.name}: ${money(r.today.sales)} sales (${delta(r.today.sales, r.yST.sales)}), ${r.today.checks} guests (${delta(r.today.checks, r.yST.checks)}), avg chk ${money(ac(r.today))} (${delta(ac(r.today), ac(r.yST))})${labStr}${stale}`);
  }

  // ── Today by hour (district) — supports "busiest/slowest hour", "morning rush" Qs ──
  const distByHour = {};
  for (const r of rows) for (const h of r.hours) { if (!distByHour[h.h]) distByHour[h.h] = { h: h.h, sales: 0, checks: 0 }; distByHour[h.h].sales += h.sales; distByHour[h.h].checks += h.checks; }
  const hourArr = Object.values(distByHour).sort((a, b) => a.h - b.h);
  if (hourArr.length) {
    const hr12 = h => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
    const peak = [...hourArr].sort((a, b) => b.sales - a.sales)[0];
    lines.push(`\nTODAY BY HOUR (${single ? 'store' : 'district'}, through ${hour}:00 ET) — busiest ${hr12(peak.h)} (${money(peak.sales)}):`);
    lines.push('  ' + hourArr.map(h => `${hr12(h.h)} ${money(h.sales)}`).join(', '));
  }

  // ── Exceptions: voids / refunds / discounts (today, live) ──
  const tV = rows.reduce((s, r) => s + r.voids.total, 0), tVc = rows.reduce((s, r) => s + r.voids.count, 0);
  const tR = rows.reduce((s, r) => s + r.refunds.total, 0), tRc = rows.reduce((s, r) => s + r.refunds.count, 0);
  const tD = rows.reduce((s, r) => s + (r.ops?.discounts || 0), 0);
  const tG = rows.reduce((s, r) => s + (r.ops?.gross || 0), 0);
  lines.push(`\nEXCEPTIONS TODAY (live; voids/refunds from checks, discounts from daily totals — these are TODAY only, not comparable to prior periods here):`);
  lines.push(`  ${single ? 'Store' : 'District'} totals: voids ${money(tV)} (${tVc}), refunds ${money(tR)} (${tRc}), discounts ${money(tD)}${tG ? `, gross ${money(tG)}` : ''}`);
  for (const r of rows) {
    if (r.voids.count || r.refunds.count || (r.ops?.discounts || 0) > 0) {
      const big = r.exceptions.length ? ` — largest: ${r.exceptions.slice(0, 2).map(e => `${e.type} ${money(e.amount)} @ ${e.time}`).join('; ')}` : '';
      lines.push(`  ${r.name}: voids ${money(r.voids.total)} (${r.voids.count}), refunds ${money(r.refunds.total)} (${r.refunds.count}), discounts ${money(r.ops?.discounts || 0)}${big}`);
    }
  }
  lines.push(`(Comps, no-sale drawer opens, order cancellations, and order-channel/mobile/delivery splits are NOT available from Pulse — say so if asked, do not estimate. For item-mix/upsell, use the GUEST SENTIMENT/upsell data if present.)`);

  return lines.join('\n');
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

  // Combined daily performance — Pulse sales + Paycor labor joined by date, so
  // the model reasons about labor efficiency against actual traffic together
  // (rather than two disconnected tables). Adds sales-per-labor-$ efficiency.
  const storeHistory = await cacheLoad(`pcg_labor_store_${storePC}`);
  const hourlyHistory = await cacheLoad(`pcg_hourly_history_${storePC}`).catch(() => null);
  const salesDaily = (Array.isArray(hourlyHistory) ? hourlyHistory : []).slice(0, 7);
  const byDate = {};
  (storeHistory?.daily?.slice(0, 7) || []).forEach(d => {
    byDate[d.date] = { ...(byDate[d.date] || {}), laborCost: d.laborCost, laborPct: d.laborPct, laborSales: d.sales };
  });
  salesDaily.forEach(d => {
    const sales = (d.hours || []).reduce((s, h) => s + (h.sales || 0), 0);
    const checks = (d.hours || []).reduce((s, h) => s + (h.checks || 0), 0);
    byDate[d.date] = { ...(byDate[d.date] || {}), sales, checks, avgCheck: checks > 0 ? sales / checks : 0, upsellRate: typeof d.upsellRate === 'number' ? d.upsellRate : null };
  });
  const perfDates = Object.keys(byDate).sort().reverse().slice(0, 7);
  if (perfDates.length) {
    sections.push(`\nRecent daily performance — sales (Pulse) + labor (Paycor), last ${perfDates.length} days:`);
    perfDates.forEach(date => {
      const r = byDate[date];
      const sales = r.sales != null ? r.sales : (r.laborSales || 0);
      const parts = [`$${Math.round(sales).toLocaleString()} sales`];
      if (r.checks) parts.push(`${r.checks} checks`);
      if (r.avgCheck) parts.push(`$${r.avgCheck.toFixed(2)} avg check`);
      if (r.upsellRate != null) parts.push(`${r.upsellRate}% multi-item`);
      if (r.laborCost != null) parts.push(`labor $${Math.round(r.laborCost).toLocaleString()}`);
      if (r.laborPct != null) parts.push(`${r.laborPct.toFixed(1)}% labor`);
      if (r.laborCost > 0 && sales > 0) parts.push(`$${(sales / r.laborCost).toFixed(2)} sales per labor $`);
      sections.push(`  ${date}: ${parts.join(', ')}`);
    });
  }
  // Recent weekly labor
  const weekly = storeHistory?.weekly?.slice(0, 4) || [];
  if (weekly.length) {
    sections.push(`\nRecent weekly labor:`);
    weekly.forEach(w => {
      sections.push(`  Week of ${w.weekStart}: Labor $${(w.laborCost || 0).toFixed(0)}, Sales $${(w.sales || 0).toFixed(0)}, Labor% ${(w.laborPct || 0).toFixed(1)}%`);
    });
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

  // Load open tickets for this store from Neon (maint_tickets). Falls back to the
  // legacy blob if the DB query fails, so the brief degrades gracefully.
  let openTickets = [];
  try {
    const db = sql(); // db.mjs exports a factory — must invoke to get the tagged-template fn
    const rows = await db`
      SELECT title, category, priority, description, created_at
      FROM maint_tickets
      WHERE status <> 'Closed' AND store_pc = ${String(storePC)}
      ORDER BY created_at DESC`;
    openTickets = rows.map(r => ({
      title: r.title, category: r.category, priority: r.priority,
      description: r.description, createdAt: r.created_at,
    }));
  } catch {
    const ticketsRaw = await cacheLoad('pcg_tickets_v1').catch(() => null);
    openTickets = Array.isArray(ticketsRaw)
      ? ticketsRaw.filter(t => t.status !== 'Closed' && String(t.storePC) === String(storePC))
      : [];
  }
  if (openTickets.length > 0) {
    sections.push(`\nOpen tickets (${openTickets.length}):`);
    openTickets.slice(0, 10).forEach(t => {
      const days = Math.floor((Date.now() - new Date(t.createdAt || 0).getTime()) / 86400000);
      sections.push(`  [${t.priority || 'Normal'}] ${t.title} — ${t.category || 'General'} — open ${days}d${t.description ? ' — ' + t.description.slice(0, 80) : ''}`);
    });
  } else {
    sections.push(`\nOpen tickets: none`);
  }

  // Ops tasks & checklists for THIS store (so the manager brief / "what's open at my store?"
  // answers from the per-store path). Uses the shared loadStoreTasks loader, then formats compactly.
  try {
    const t = await loadStoreTasks([storePC]);
    if (t && (t.instances.length || t.correctiveActions.length)) {
      const tally = { open: 0, overdue: 0, missed: 0, completed: 0 };
      const incomplete = [];
      for (const i of t.instances) {
        tally[i.status] = (tally[i.status] || 0) + 1;
        if (i.status === 'overdue' || i.status === 'missed') incomplete.push(`${i.name}${i.shiftTime ? ` (${i.shiftTime})` : ''} — ${i.status}`);
      }
      const when = t.isToday ? 'today' : `as of ${t.bizDate} (latest with data)`;
      sections.push(`\nOps tasks ${when}: ${tally.completed}/${t.instances.length} complete — ${tally.open} open, ${tally.overdue} overdue, ${tally.missed} missed`);
      if (incomplete.length) sections.push(`  Overdue/missed: ${incomplete.slice(0, 12).join('; ')}`);
      if (t.correctiveActions.length) {
        sections.push(`  Open corrective actions (${t.correctiveActions.length}):`);
        t.correctiveActions.slice(0, 8).forEach(c => {
          const meas = c.measuredValue != null ? ` measured ${c.measuredValue}${c.unit || ''}${c.target != null ? ` vs target ${c.target}${c.unit || ''}` : ''}` : '';
          sections.push(`    ${c.title}${c.station ? ` [${c.station}]` : ''}${meas}${c.dueDate ? ` due ${c.dueDate}` : ''}`);
        });
      }
    } else {
      sections.push(`\nOps tasks: none scheduled / no data yet`);
    }
  } catch (e) {
    // Non-fatal — tasks DB unavailable; brief degrades gracefully
    console.warn(`[analyst-data] store tasks failed: ${e.message}`);
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

async function buildSentimentContext({ district, storePC } = {}) {
  const network = await getNetworkReviews();
  if (!network) return '';

  // Store scope (managers): ONLY their own rating + their own action items —
  // never other stores' names/ratings, and the network average only as a benchmark.
  if (storePC != null) {
    const lines = [];
    const rating = network.storeRatings?.[storePC];
    if (rating > 0) lines.push(`Your store's Google rating: ★${rating} (network avg ★${network.networkAvgRating})`);
    const mine = (network.actionItems || []).filter(a => String(a.pc) === String(storePC));
    if (mine.length > 0) {
      lines.push('Action items from your store\'s recent reviews:');
      for (const item of mine) lines.push(`  - ${item.action} (${item.reviewCount} review${item.reviewCount > 1 ? 's' : ''})`);
    }
    return lines.length ? '\n\nGUEST SENTIMENT (your store):\n' + lines.join('\n') : '';
  }

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

// Load all maintenance tickets from Neon (maint_tickets) in the client-ish shape
// the summarizers/crons expect. Falls back to the legacy blob if the query fails.
async function loadAllTickets() {
  try {
    const db = sql(); // db.mjs exports a factory — must invoke to get the tagged-template fn
    const rows = await db`
      SELECT id, number, title, status, priority, category, store_pc, store_name,
             ticket_owner, due_date, description, created_at, updated_at
      FROM maint_tickets ORDER BY created_at DESC`;
    return rows.map(r => ({
      id: Number(r.id), number: r.number, title: r.title, status: r.status,
      priority: r.priority, category: r.category, storePC: r.store_pc, storeName: r.store_name,
      ticketOwner: r.ticket_owner, dueDate: r.due_date, description: r.description,
      createdAt: r.created_at, updatedAt: r.updated_at,
    }));
  } catch {
    const blob = await cacheLoad('pcg_tickets_v1').catch(() => null);
    return Array.isArray(blob) ? blob : [];
  }
}

async function buildTicketsContext({ district } = {}) {
  return summarizeTickets(await loadAllTickets(), district || null, new Date(), STORES);
}

// Sales Mix Intelligence (roadmap 9.3): for each in-scope store, detect per-category
// sales drops vs its day-of-week baseline and attribute them to open maintenance tickets.
// Loads pcg_item_history_{pc} (populated nightly by pulse-hourly-snapshot + the one-time
// backfill) and the store's open tickets, then runs the pure attribution engine.
// opts: { district, storePC, dropThreshold }. Returns stores that have at least one drop.
async function buildSalesMixContext({ district = null, storePC = null, dropThreshold } = {}) {
  let stores = STORES;
  if (storePC) stores = STORES.filter(s => String(s.pc) === String(storePC));
  else if (district) stores = STORES.filter(s => String(s.district) === String(district));

  const opts = (typeof dropThreshold === 'number') ? { dropThreshold } : {};
  // Load the tickets (one DB query) and every in-scope store's item history CONCURRENTLY —
  // a network-scope (exec) call touches all 45 history blobs, so overlapping them with the
  // ticket query (instead of awaiting it first) keeps the Orion ask path off the critical path.
  const [allTickets, rawHistories] = await Promise.all([
    loadAllTickets(),
    Promise.all(stores.map(async (store) => ({
      store,
      history: await cacheLoad(`pcg_item_history_${store.pc}`).catch(() => null),
    }))),
  ]);

  // Group open tickets by store once (avoids N lookups).
  const openByStore = new Map();
  for (const t of allTickets) {
    if (!t || t.status === 'Closed') continue;
    const pc = String(t.storePC || '');
    if (!openByStore.has(pc)) openByStore.set(pc, []);
    openByStore.get(pc).push(t);
  }

  const results = rawHistories.map(({ store, history }) => {
    if (!Array.isArray(history) || !history.length) return null;
    const drops = analyzeStoreMix(history, openByStore.get(String(store.pc)) || [], opts);
    return drops.length ? { pc: store.pc, name: store.name, district: store.district, drops } : null;
  }).filter(Boolean);
  results.sort((a, b) => b.drops.reduce((s, d) => s + d.lostSales, 0) - a.drops.reduce((s, d) => s + d.lostSales, 0));
  return { storesAnalyzed: stores.length, storesWithDrops: results.length, stores: results };
}

// Sales Mix Intelligence (9.3): cross-store item comparison. Loads the item-category history
// for a PEER SET, profiles each store's share-of-mix, and flags stores whose category share is
// far from their district-peer average ("Store 220 sells 40% fewer espresso than district avg").
// Scope note: a single store can only be judged against its peers, so a manager/store request
// loads the whole DISTRICT to build the average, then returns only that store's outliers.
// opts: { district, storePC }. Returns { storesAnalyzed, storesWithOutliers, stores: [...] }.
async function buildMixComparisonContext({ district = null, storePC = null } = {}) {
  let peerStores = STORES;
  let focusPC = null;
  if (storePC) {
    focusPC = String(storePC);
    const self = STORES.find(s => String(s.pc) === focusPC);
    peerStores = self ? STORES.filter(s => String(s.district) === String(self.district)) : [];
  } else if (district != null) {
    peerStores = STORES.filter(s => String(s.district) === String(district));
  }

  const storeHistories = await Promise.all(peerStores.map(async (store) => ({
    store,
    history: await cacheLoad(`pcg_item_history_${store.pc}`).catch(() => null),
  })));

  let results = analyzeCrossStoreMix(storeHistories);
  if (focusPC) results = results.filter(r => String(r.pc) === focusPC);
  return { storesAnalyzed: peerStores.length, storesWithOutliers: results.length, stores: results };
}

// Sales Mix Intelligence (9.3): new product launch tracking. Loads the tracked-product registry
// (pcg_new_products_v1) + every in-scope store's item history and computes network adoption,
// ramp curve, and top/lagging stores per launch. opts: { district, storePC }.
async function buildNewProductsContext({ district = null, storePC = null } = {}) {
  const registry = await loadNewProductRegistry(cacheLoad);
  if (!Array.isArray(registry) || registry.length === 0) return { products: [], registered: 0 };
  let stores = STORES;
  if (storePC) stores = STORES.filter(s => String(s.pc) === String(storePC));
  else if (district != null) stores = STORES.filter(s => String(s.district) === String(district));
  const storeHistories = await Promise.all(stores.map(async (store) => ({
    store,
    history: await cacheLoad(`pcg_item_history_${store.pc}`).catch(() => null),
  })));
  const products = analyzeNewProducts(registry, storeHistories);
  return { registered: registry.length, storesAnalyzed: stores.length, products };
}

async function buildCashContext({ district } = {}) {
  return summarizeCash(await cacheLoad('pcg_cash_deposits_v1'), district || null, new Date(), STORES);
}

// Ops Task & Checklist system (Neon: task_instances/task_templates/corrective_actions).
// Status logic mirrors tasks.mjs/computeStatus so Orion's view matches the Tasks tab exactly:
// completed stays completed; a past business date is "missed"; today's task past its
// shift-window end is "overdue"; otherwise "open". SHIFT_WINDOWS is imported from the same
// catalog tasks.mjs uses — do NOT re-declare a copy here (it silently drifts and, worse,
// would omit the 'AM'/'Noon'/'PM' windows, leaving those tasks stuck at "open").
function etNowParts() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {}; for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, minute: +p.minute };
}
function computeTaskStatus(row, nowP) {
  if (row.status === 'completed') return 'completed';
  if (row.business_date < nowP.date) return 'missed';
  if (row.business_date === nowP.date && row.shift_time) {
    const w = TASK_SHIFT_WINDOWS[row.shift_time];
    if (w && (nowP.hour > w.endHour || (nowP.hour === w.endHour && nowP.minute > w.endMin))) return 'overdue';
  }
  return 'open';
}

// Shared task loader (single source of truth for the query + status computation, used by both
// the network/district summary and the per-store manager brief). Reports the most recent business
// date with instances in the last 7d, so Orion never blanks out just because today's daily
// instances haven't been generated yet. Returns null when there are no stores to query.
async function loadStoreTasks(storePcs) {
  const pcs = (storePcs || []).map(String);
  if (pcs.length === 0) return null;
  const nowP = etNowParts();
  const db = sql(); // db.mjs exports a factory — must invoke to get the tagged-template fn
  const weekAgo = new Date(Date.parse(`${nowP.date}T12:00:00`) - 7 * 86400000).toISOString().slice(0, 10);
  const latest = await db`
    SELECT max(business_date)::text AS d FROM task_instances
    WHERE store_pc = ANY(${pcs}) AND business_date <= ${nowP.date} AND business_date >= ${weekAgo}`;
  const bizDate = latest?.[0]?.d || nowP.date;
  // Instances for the target date + open corrective actions are independent → run in parallel.
  const [rows, caRows] = await Promise.all([
    db`
      SELECT i.store_pc, i.business_date::text AS business_date, i.shift_time, i.status,
             i.completed_by, t.category, COALESCE(t.label, t.name) AS name
      FROM task_instances i
      JOIN task_templates t ON t.id = i.template_id
      WHERE i.business_date = ${bizDate} AND i.store_pc = ANY(${pcs})`,
    db`
      SELECT store_pc, title, station, assignee, due_date::text AS due_date,
             measured_value, target, unit, created_at
      FROM corrective_actions
      WHERE status = 'open' AND store_pc = ANY(${pcs})
      ORDER BY created_at ASC`,
  ]);
  const instances = rows.map(r => ({
    storePC: String(r.store_pc), status: computeTaskStatus(r, nowP),
    category: r.category, name: r.name, shiftTime: r.shift_time, completedBy: r.completed_by,
  }));
  const correctiveActions = caRows.map(c => ({
    storePC: String(c.store_pc), title: c.title, station: c.station, assignee: c.assignee,
    dueDate: c.due_date, measuredValue: c.measured_value != null ? Number(c.measured_value) : null,
    target: c.target != null ? Number(c.target) : null, unit: c.unit,
  }));
  return { bizDate, isToday: bizDate === nowP.date, instances, correctiveActions };
}

async function buildTasksContext({ district } = {}) {
  try {
    const stores = district ? getStoresByDistrict(district) : STORES;
    const data = await loadStoreTasks(stores.map(s => s.pc));
    if (!data) return { available: false };
    return summarizeTasks(
      { instances: data.instances, correctiveActions: data.correctiveActions, date: data.bizDate, isToday: data.isToday },
      district || null, STORES,
    );
  } catch (e) {
    console.warn(`[analyst-data] tasks context failed: ${e.message}`);
    return { available: false };
  }
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
  // Always network-wide so the avg and top/bottom 5 are true network stats;
  // district stores get their own comparison block on top of that.
  const entries = (await Promise.all(STORES.map(async (s) => {
    const history = await cacheLoad(`pcg_hourly_history_${s.pc}`);
    const recent = (Array.isArray(history) ? history : [])
      .filter(e => typeof e.upsellRate === 'number')
      .slice(0, 7);
    if (recent.length === 0) return null;
    const avgOf = (k) => roundAvg(recent.map(e => e[k]));
    let sales = 0, checks = 0;
    for (const e of recent) for (const h of (e.hours || [])) { sales += h.sales || 0; checks += h.checks || 0; }
    const avgCheck = checks > 0 ? Math.round((sales / checks) * 100) / 100 : null;
    return {
      pc: s.pc, name: s.name, district: s.district, upsellRate: avgOf('upsellRate'),
      foodAttachRate: avgOf('foodAttachRate'), drinkAttachRate: avgOf('drinkAttachRate'),
      avgCheck, days: recent.length,
    };
  }))).filter(Boolean);

  const summary = summarizeUpsell(entries);
  if (!summary.available) return summary;

  if (district) {
    summary.district = {
      num: district,
      stores: entries.filter(e => e.district === district).sort((a, b) => b.upsellRate - a.upsellRate),
    };
  }

  try {
    summary.itemDiff = await buildUpsellItemDiff(summary.top, summary.bottom);
  } catch (e) {
    console.warn(`[analyst-data] upsell item diff failed: ${e.message}`);
  }
  return summary;
}

/**
 * Item-mix comparison between the network's top-5 and bottom-5 upsell stores:
 * "what are the top stores selling more of, per 100 checks?"
 * Hits Pulse POS for ~10 stores, so the result is cached once per day.
 */
async function buildUpsellItemDiff(top, bottom) {
  if (!top?.length || !bottom?.length) return null;
  const cacheKey = `analyst/upsell-item-diff-v2_${todayET()}`; // v2: modifiers excluded
  const cached = await cacheLoad(cacheKey);
  if (cached) return cached;

  // Items that ring as modifier CHILD lines (cream & sugar, flavor swirls, extra shots) —
  // getMenuItemDailyTotals counts them like sold items, so without this exclusion they
  // dominate the gap list and read as fake "upsell" items. The set is learned nightly by
  // pulse-hourly-snapshot from guest-check parent/child (parDtlId) structure.
  const modifierItems = (await cacheLoad('pcg_modifier_items_v1')) || {};

  const group = [
    ...top.map(s => ({ ...s, grp: 'top' })),
    ...bottom.map(s => ({ ...s, grp: 'bottom' })),
  ];

  const routes = [...new Set(group.map(s => pulseRoute(s.pc)))];

  // Fail closed: until the nightly snapshot has learned a modifier set for every route in
  // play, skip the diff entirely — computing (and day-caching) it with an empty exclusion
  // set would re-serve the modifier-polluted list under a "modifiers excluded" label.
  if (routes.some(r => !(Array.isArray(modifierItems[r]) && modifierItems[r].length))) {
    console.warn('[analyst-data] upsell item diff skipped: modifier set not yet learned for all routes');
    return null;
  }

  // Menu item num → name map (dimensions fetched once per Pulse route)
  const nameMap = {};
  await Promise.all(routes.map(async (r) => {
    const rep = group.find(s => pulseRoute(s.pc) === r);
    try {
      const dims = await pulsePostJSON(rep.pc, 'getMenuItemDimensions', { locRef: rep.pc });
      (dims?.menuItems || []).forEach(m => { nameMap[m.num] = m.name; });
    } catch {}
  }));

  const perStore = (await Promise.all(group.map(async (s) => {
    try {
      const hist = await cacheLoad(`pcg_hourly_history_${s.pc}`);
      const latest = (Array.isArray(hist) ? hist : []).find(e => e.date && (e.totalChecks || 0) > 0);
      if (!latest) return null;
      const menu = await pulsePostJSON(s.pc, 'getMenuItemDailyTotals', {
        locRef: s.pc, busDt: latest.date,
        searchCriteria: 'where greaterThan(revenueCenters.menuItems.slsCnt, 0)',
        include: 'revenueCenters.menuItems.miNum,revenueCenters.menuItems.slsCnt',
      });
      const mods = new Set(modifierItems[pulseRoute(s.pc)] || []);
      const counts = {};
      for (const rc of (menu?.revenueCenters || [])) {
        for (const mi of (rc.menuItems || [])) {
          if (mods.has(String(mi.miNum))) continue; // modifier, not a sellable attach item
          const nm = nameMap[mi.miNum] || `Item ${mi.miNum}`;
          counts[nm] = (counts[nm] || 0) + (mi.slsCnt || 0);
        }
      }
      return { grp: s.grp, name: s.name, date: latest.date, checks: latest.totalChecks, counts };
    } catch (e) {
      console.warn(`[analyst-data] item mix fetch failed for ${s.pc}: ${e.message}`);
      return null;
    }
  }))).filter(Boolean);

  const tops = perStore.filter(s => s.grp === 'top');
  const bots = perStore.filter(s => s.grp === 'bottom');
  if (!tops.length || !bots.length) return null;

  // Average units per 100 checks across each group, per item
  const per100 = (list, item) => list.reduce((sum, s) => sum + ((s.counts[item] || 0) / s.checks) * 100, 0) / list.length;
  const itemNames = new Set();
  perStore.forEach(s => Object.keys(s.counts).forEach(i => itemNames.add(i)));
  const items = [...itemNames]
    .map(item => {
      const t = per100(tops, item), b = per100(bots, item);
      return { item, topPer100: Math.round(t * 10) / 10, bottomPer100: Math.round(b * 10) / 10, gap: t - b };
    })
    .filter(r => Math.max(r.topPer100, r.bottomPer100) >= 5) // skip rarely-sold items (noise)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 8)
    .map(({ gap, ...r }) => r);

  if (!items.length) return null;
  const result = {
    asOf: todayET(),
    topStores: tops.map(s => s.name),
    bottomStores: bots.map(s => s.name),
    items,
  };
  await cacheSave(cacheKey, result);
  return result;
}

/** Render all four ops summaries as a text block for the prompt data section. */
async function buildOpsContext({ district } = {}) {
  try {
    const [projects, tickets, tasks, cash, foodCost, upsell] = await Promise.all([
      buildProjectsContext({ district }),
      buildTicketsContext({ district }),
      buildTasksContext({ district }),
      buildCashContext({ district }),
      buildFoodCostContext(),
      buildUpsellContext({ district }),
    ]);
    return renderOpsContext({ projects, tickets, tasks, cash, foodCost, upsell });
  } catch (err) {
    // One malformed blob record must never take down chat/briefs/reports —
    // degrade to "no ops data" rather than throwing out of buildDataContext.
    console.error('buildOpsContext failed:', err.message);
    return '';
  }
}

// ── Maintenance ticket board (network-wide, full detail for the crew's Orion) ─
// Read-only context: active tickets triage-sorted with full detail, overdue /
// due-today / due-this-week buckets, per-store repeat-issue history, recently
// closed tickets with their closing note, and a month-to-date expense rollup.
async function buildMaintenanceContext({ now = new Date() } = {}) {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const norm = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? String(s).slice(0, 10) : ymd(d); };
  const today = ymd(now);
  const weekEnd = new Date(now.getTime()); weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = ymd(weekEnd);
  const monthStart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
  const daysBetween = (a, b) => Math.floor((new Date(a) - new Date(b)) / 86400000);

  let rows = [];
  const commentCounts = {}, expTotals = {};
  let expMonth = { total: 0, n: 0 };
  const db = sql(); // db.mjs exports a factory — must invoke to get the tagged-template fn
  try {
    rows = await db`
      SELECT id, number, title, status, priority, category,
             store_pc, store_name, address, due_date, ticket_owner, created_by,
             started_by, closed_by, closed_at,
             COALESCE(jsonb_array_length(attachments), 0) AS attach_n, created_at
      FROM maint_tickets ORDER BY created_at DESC`;
    const cc = await db`SELECT ticket_id, count(*)::int AS n FROM maint_ticket_comments GROUP BY ticket_id`;
    cc.forEach((r) => { commentCounts[String(r.ticket_id)] = r.n; });
    const et = await db`SELECT ticket_id, COALESCE(sum(amount),0)::float AS total FROM maint_ticket_expenses WHERE no_expense IS NOT TRUE AND amount IS NOT NULL GROUP BY ticket_id`;
    et.forEach((r) => { expTotals[String(r.ticket_id)] = r.total; });
    const em = await db`SELECT COALESCE(sum(amount),0)::float AS total, count(*)::int AS n FROM maint_ticket_expenses WHERE no_expense IS NOT TRUE AND amount IS NOT NULL AND added_at >= ${monthStart}::date`;
    expMonth = { total: em[0]?.total || 0, n: em[0]?.n || 0 };
  } catch (e) {
    return `MAINTENANCE TICKET BOARD: unavailable (${e.message}).`;
  }
  if (!rows.length) return `MAINTENANCE TICKET BOARD (as of ${today}): no tickets on record.`;

  const prank = (p) => ({ High: 0, Medium: 1, Low: 2 }[p] ?? 3);
  const t = rows.map((r) => {
    const due = norm(r.due_date);
    const closed = r.status === 'Closed';
    const age = r.created_at ? Math.max(0, daysBetween(now, r.created_at)) : null;
    return {
      id: String(r.id), number: r.number || `#${r.id}`, title: r.title || '(untitled)',
      status: r.status || 'Open', priority: r.priority || 'Medium', category: r.category || 'Uncategorized',
      pc: r.store_pc || '', store: r.store_name || r.store_pc || 'Unknown store', address: r.address || '',
      due, owner: r.ticket_owner || r.started_by || '', closedBy: r.closed_by || '',
      closedAt: r.closed_at ? norm(r.closed_at) : null,
      attach: Number(r.attach_n) || 0, comments: commentCounts[String(r.id)] || 0, spent: expTotals[String(r.id)] || 0,
      closed, age,
      overdue: !!(due && !closed && due < today),
      dueToday: !!(due && !closed && due === today),
      dueWeek: !!(due && !closed && due >= today && due <= weekEndStr),
    };
  });

  const active = t.filter((x) => !x.closed);
  const closedAll = t.filter((x) => x.closed);
  const inProg = active.filter((x) => x.status === 'In Progress').length;
  const overdue = active.filter((x) => x.overdue);
  const dueToday = active.filter((x) => x.dueToday);
  const dueWeek = active.filter((x) => x.dueWeek);
  const byP = { High: 0, Medium: 0, Low: 0 };
  active.forEach((x) => { if (byP[x.priority] != null) byP[x.priority]++; });
  const byCat = {};
  active.forEach((x) => { byCat[x.category] = (byCat[x.category] || 0) + 1; });

  const sortActive = (arr) => arr.slice().sort((a, b) =>
    (Number(b.overdue) - Number(a.overdue)) ||
    (prank(a.priority) - prank(b.priority)) ||
    ((a.due || '9999-99-99') < (b.due || '9999-99-99') ? -1 : (a.due || '9999-99-99') > (b.due || '9999-99-99') ? 1 : 0) ||
    ((b.age || 0) - (a.age || 0))
  );
  const fmtRow = (x) => `• ${x.number} | ${x.title} | ${x.store}${x.pc ? ` (PC ${x.pc})` : ''}${x.address ? ` ${x.address}` : ''} | ${x.category} | ${x.priority} | ${x.status} | due ${x.due || 'none'}${x.overdue && x.due ? ` (${daysBetween(today, x.due)}d overdue)` : ''} | age ${x.age != null ? x.age + 'd' : '?'}${x.owner ? ` | owner ${x.owner}` : ''}${x.comments ? ` | ${x.comments} comment(s)` : ''}${x.attach ? ` | ${x.attach} photo(s)` : ''}${x.spent ? ` | $${x.spent.toFixed(2)} spent` : ''}`;

  const sec = [];
  sec.push(`MAINTENANCE TICKET BOARD — network-wide, as of ${today}`);
  sec.push(`SUMMARY: ${active.length} active (${inProg} in progress) · ${overdue.length} overdue · ${dueToday.length} due today · ${dueWeek.length} due within 7 days · ${closedAll.length} closed all-time`);
  sec.push(`Active by priority: High ${byP.High} · Medium ${byP.Medium} · Low ${byP.Low}`);
  sec.push(`Active by category: ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(' · ') || 'none'}`);
  sec.push(`Maintenance spend month-to-date: $${expMonth.total.toFixed(2)} across ${expMonth.n} expense line(s)`);

  if (overdue.length) {
    sec.push(`\nOVERDUE — handle first (${overdue.length}):`);
    sortActive(overdue).slice(0, 25).forEach((x) => sec.push(fmtRow(x)));
  }
  sec.push(`\nACTIVE TICKETS, triage-sorted (showing ${Math.min(active.length, 40)} of ${active.length}):`);
  sortActive(active).slice(0, 40).forEach((x) => sec.push(fmtRow(x)));

  const byStore = {};
  t.forEach((x) => {
    const k = x.pc || x.store;
    if (!byStore[k]) byStore[k] = { store: x.store, pc: x.pc, total: 0, open: 0, cats: {} };
    byStore[k].total++; if (!x.closed) byStore[k].open++;
    byStore[k].cats[x.category] = (byStore[k].cats[x.category] || 0) + 1;
  });
  const repeatStores = Object.values(byStore).filter((s) => s.total >= 2).sort((a, b) => b.open - a.open || b.total - a.total).slice(0, 20);
  if (repeatStores.length) {
    sec.push(`\nPER-STORE HISTORY (stores with 2+ tickets):`);
    repeatStores.forEach((s) => {
      const repeats = Object.entries(s.cats).filter(([, n]) => n >= 2).map(([c, n]) => `${c} ×${n}`).join(', ');
      sec.push(`• ${s.store}${s.pc ? ` (PC ${s.pc})` : ''}: ${s.total} tickets · ${s.open} open${repeats ? ` · repeat: ${repeats}` : ''}`);
    });
  }

  const recentClosed = closedAll.slice().sort((a, b) => ((b.closedAt || '') < (a.closedAt || '') ? -1 : 1)).slice(0, 15);
  if (recentClosed.length) {
    const lastNotes = {};
    try {
      const ids = recentClosed.map((x) => x.id);
      const notes = await db`
        SELECT DISTINCT ON (ticket_id) ticket_id, text
        FROM maint_ticket_comments WHERE ticket_id = ANY(${ids}::bigint[])
        ORDER BY ticket_id, created_at DESC`;
      notes.forEach((r) => { lastNotes[String(r.ticket_id)] = r.text; });
    } catch { /* notes are best-effort */ }
    sec.push(`\nRECENTLY CLOSED (resolution reference, last ${recentClosed.length}):`);
    recentClosed.forEach((x) => {
      const note = (lastNotes[x.id] || '').replace(/\s+/g, ' ').slice(0, 100);
      sec.push(`• ${x.number} | ${x.title} | ${x.store} | ${x.category} | closed ${x.closedAt || '?'}${x.closedBy ? ` by ${x.closedBy}` : ''}${note ? ` | note: "${note}"` : ''}`);
    });
  }

  return sec.join('\n');
}

export {
  STORES,
  getAllStores,
  getStoresByDistrict,
  getDailyNetSales,
  getNetworkLabor,
  getStoreLabor,
  buildKPISnapshot,
  buildDataContext,
  buildStoreContext,
  buildStoreRosterContext,
  buildPulseComparisonContext,
  getStoreToday,
  todayET,
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
  buildSalesMixContext,
  buildMixComparisonContext,
  buildNewProductsContext,
  buildMaintenanceContext,
  loadAllTickets,
  buildCashContext,
  buildFoodCostContext,
  buildOpsContext,
};
