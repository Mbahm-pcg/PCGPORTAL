// analyst-data.js — Unified data access layer for the Analyst
// This is the ONLY module that reads raw data sources.
// TODO (Phase 2): Swap blob reads for Postgres/Supabase queries.

const { cacheLoad, cacheSave } = require('./analyst-cache');

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
  if (snapshot.error) return snapshot.error;

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

  return context;
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
      sections.push(`\nRecent daily labor:`);
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
};
