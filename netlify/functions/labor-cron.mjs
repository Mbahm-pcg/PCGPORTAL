// PCG Portal — Labor Cron (Scheduled Netlify Function)
// Runs every 4 hours. Fetches employee + punch + pay rate data from Paycor,
// cross-references with Pulse POS sales data, computes labor costs and
// percentages, and stores results in Netlify Blobs under 'pcg-labor'.

import https from 'node:https';
import { getStore } from '@netlify/blobs';
import { lookupUnitCost } from './analyst-lib/cost-lookup.mjs';
import { computeStorePnL, DEFAULT_COGS_PCT } from './analyst-lib/pnl-calc.mjs';
import { recordHealth } from './health-lib/record-health.mjs';
import { parsePaycorPunchMs } from '../../src/paycor-time.mjs';
import { managerMatches, namesCorrespond, detectManagerCandidate, advanceVacantStreak, suggestUsername, generatePassword, shouldAutoApplyReplace } from '../../src/manager-sync.mjs';
import { sql } from './_shared/db.mjs';
import { hashPassword } from './auth-lib/passwords.js';
import { sendEmail } from './_shared/channels.mjs';

export const config = { schedule: "0 9-23,0-3 * * *" };

// ── Store configs (pc = Dunkin store number, paycor = Paycor legal entity ID) ──
export const STORES = [
  { pc:"339616", paycor:"193919", name:"Wadsworth",       district:1 },
  { pc:"340794", paycor:"193904", name:"Front",           district:1 },
  { pc:"351099", paycor:"193900", name:"Sonic",           district:2 },
  { pc:"351259", paycor:"193892", name:"Rosemore",        district:2 },
  { pc:"302642", paycor:"193914", name:"County Line",     district:2 },
  { pc:"352894", paycor:"193890", name:"Street Rd",       district:2 },
  { pc:"341350", paycor:"193920", name:"Yardley",         district:2 },
  { pc:"337839", paycor:"193888", name:"Warrington",      district:2 },
  { pc:"365953", paycor:"200540", name:"Hatboro",         district:2 },
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

// ── Pulse POS API configs ─────────────────────────────────────────────────────
const APIS = {
  p227: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p227',
    xkey:   'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL',
    apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
  p228: {
    host:   'pos-ra.dunkindonuts.com',
    path:   '/p228',
    xkey:   'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP',
    apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
};

const STORE_P227 = '345986'; // Willits uses p227
function apiRoute(pc) { return pc === STORE_P227 ? 'p227' : 'p228'; }

// ── Paycor OAuth token cache (in-memory, persists across warm invocations) ────
let tokenCache = {
  accessToken: null,
  refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null,
  expiresAt: 0,
};
// Mutex to prevent concurrent token refreshes (race condition fix)
let refreshPromise = null;

const PAYCOR_API_HOST = 'apis.paycor.com';
const TOKEN_ENDPOINT  = '/sts/v1/common/token';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/** Generic HTTPS request returning { status, data }. */
function httpsRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body || null;
    const options = {
      hostname,
      port: 443,
      path,
      method,
      headers: {
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

/** POST JSON to Pulse POS. Returns parsed response body. */
function postPOS(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: cfg.host,
      port: 443,
      path: `${cfg.path}/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-api-key':      cfg.xkey,
        'Api-Key':        cfg.apikey,
        'Content-Length':  Buffer.byteLength(data),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => (raw += d));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(raw)); }
          catch { resolve(raw); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Pulse menu-mix + P&L helpers ─────────────────────────────────────────────

/**
 * Fetch per-item menu mix for a store/day from Pulse.
 * @returns {Promise<Array<{name:string, slsCnt:number, slsTtl:number}>>}
 */
async function getStoreMenuMix(pc, busDt) {
  const cfg = APIS[apiRoute(String(pc))];
  const [dims, daily] = await Promise.all([
    postPOS(cfg, 'getMenuItemDimensions', { locRef: String(pc) }),
    postPOS(cfg, 'getMenuItemDailyTotals', {
      locRef: String(pc), busDt,
      searchCriteria: 'where greaterThan(revenueCenters.menuItems.slsCnt, 0)',
      include: 'revenueCenters.menuItems.miNum,revenueCenters.menuItems.slsTtl,revenueCenters.menuItems.slsCnt',
    }),
  ]);
  const nameByNum = Object.fromEntries((dims?.menuItems || []).map(m => [m.num, m.name]));
  const agg = {}; // miNum -> { slsCnt, slsTtl }
  for (const rc of (daily?.revenueCenters || [])) {
    for (const mi of (rc.menuItems || [])) {
      if (!agg[mi.miNum]) agg[mi.miNum] = { slsCnt: 0, slsTtl: 0 };
      agg[mi.miNum].slsCnt += mi.slsCnt || 0;
      agg[mi.miNum].slsTtl += mi.slsTtl || 0;
    }
  }
  return Object.entries(agg).map(([miNum, v]) => ({
    name: nameByNum[miNum] || '', slsCnt: v.slsCnt, slsTtl: v.slsTtl,
  }));
}

// ── Paycor OAuth ──────────────────────────────────────────────────────────────

async function getAccessToken() {
  const clientId       = process.env.PAYCOR_CLIENT_ID;
  const clientSecret   = process.env.PAYCOR_CLIENT_SECRET;
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;

  if (!clientId || !clientSecret || !subscriptionKey) {
    throw new Error('Missing Paycor credentials in environment variables');
  }

  // Return cached token if still valid (with 60s buffer).
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) {
    return tokenCache.accessToken;
  }

  // Mutex: if a refresh is already in progress, wait for it instead of firing another
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    if (!tokenCache.refreshToken) {
      throw new Error('NO_TOKEN: No refresh token available. Run OAuth activation flow first.');
    }

    const formBody = [
      `grant_type=refresh_token`,
      `refresh_token=${encodeURIComponent(tokenCache.refreshToken)}`,
      `client_id=${encodeURIComponent(clientId)}`,
      `client_secret=${encodeURIComponent(clientSecret)}`,
    ].join('&');

    const tokenPath = `${TOKEN_ENDPOINT}?subscription-key=${subscriptionKey}`;

    const res = await httpsRequest(PAYCOR_API_HOST, tokenPath, 'POST', {
      'Content-Type': 'application/x-www-form-urlencoded',
    }, formBody);

  if (res.status === 200 && res.data.access_token) {
    tokenCache = {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token || tokenCache.refreshToken,
      expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000,
    };
    console.log('[labor-cron] Paycor token refreshed, expires in', res.data.expires_in, 's');
    return tokenCache.accessToken;
  }

  throw new Error(`Token refresh failed: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/** Call the Paycor REST API. Retries once on 401. */
export async function callPaycor(path, method = 'GET', _retried = false) {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;

  const makeCall = async (tok) => httpsRequest(PAYCOR_API_HOST, `/v1${path}`, method, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tok}`,
    'Ocp-Apim-Subscription-Key': subscriptionKey,
  });

  // Every caller of callPaycor (fetchPunches, fetchPrimaryPayRate, fetchSchedulingShifts,
  // etc.) swallows a failure here and falls back to empty/null — with no retry, one
  // transient Paycor timeout (httpsRequest's 30s timeout rejects) or 5xx zeroes real
  // hours/cost for that store's entire run. One retry absorbs most of that flakiness.
  let res;
  try {
    res = await makeCall(token);
  } catch (err) {
    if (_retried) throw err;
    return callPaycor(path, method, true);
  }
  if (res.status === 401) {
    tokenCache.accessToken = null;
    tokenCache.expiresAt = 0;
    const newToken = await getAccessToken();
    res = await makeCall(newToken);
  } else if (res.status >= 500 && !_retried) {
    return callPaycor(path, method, true);
  }
  return res;
}

/** Paginated fetch: collect all records from a Paycor list endpoint. */
async function fetchAllPages(basePath) {
  let records = [];
  let url = basePath;
  while (url) {
    const res = await callPaycor(url);
    if (res.status !== 200) break;
    const body = res.data;
    const page = body.records || body.data || (Array.isArray(body) ? body : []);
    records = records.concat(page);
    // Paycor uses continuationToken for pagination
    const nextToken = body.continuationToken || body.nextToken || null;
    if (nextToken && page.length > 0) {
      const sep = basePath.includes('?') ? '&' : '?';
      url = `${basePath}${sep}continuationToken=${encodeURIComponent(nextToken)}`;
    } else {
      url = null;
    }
  }
  return records;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export function todayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
}

/** Returns ISO string for the Monday of the current week (Paycor week starts Mon).
 *  Exported so other modules needing the same weekOf convention (e.g. competitor.mjs's
 *  guest-count weekly bucketing) can reuse this instead of re-deriving the same math. */
export function weekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // roll back to Monday
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  return `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
}

/** Returns dates from weekStart through today (inclusive), as ISO strings. */
function weekDatesThrough(todayStr) {
  const start = weekStart(todayStr);
  const dates = [];
  const cur = new Date(start + 'T12:00:00');
  const end = new Date(todayStr + 'T12:00:00');
  while (cur <= end) {
    dates.push(`${cur.getFullYear()}-${String(cur.getMonth()+1).padStart(2,'0')}-${String(cur.getDate()).padStart(2,'0')}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ── POS helpers ───────────────────────────────────────────────────────────────

export async function fetchLatestBusDt(pc) {
  try {
    const cfg = APIS[apiRoute(pc)];
    // 'getLatestBusDt' is not a real Pulse endpoint — it HARD-500s. The correct endpoint
    // is 'getLatestBusinessDate', and the date comes back under `latestBusDt` (not
    // busDt/businessDate). Because postPOS's error was silently swallowed by the outer
    // catch below, this returned null on every call — meaning the scoped single-store
    // "Refresh" button (manager/DM mobile) always fell back to `todayET()` in its own
    // .catch(), or (worse, as seen live) resolved to null and got passed straight into
    // processStore, making every manual refresh look like "zero data from Paycor".
    const j = await postPOS(cfg, 'getLatestBusinessDate', { locRef: pc });
    return j.latestBusDt || null;
  } catch { return null; }
}

async function fetchPOSSales(pc, busDt) {
  try {
    const cfg = APIS[apiRoute(pc)];
    const json = await postPOS(cfg, 'getOperationsDailyTotals', {
      locRef: pc, busDt, include: 'locRef,busDt,revenueCenters',
    });
    const netSales = (json.revenueCenters || []).reduce((sum, r) => sum + (r.netSlsTtl || 0), 0);
    return { ok: true, netSales };
  } catch (e) {
    return { ok: false, netSales: 0, error: e.message };
  }
}

// ── Paycor data helpers ───────────────────────────────────────────────────────

/** Fetch all active employees for a legal entity. */
async function fetchEmployees(legalEntityId) {
  return fetchAllPages(`/legalentities/${legalEntityId}/employees?include=All`);
}

/** Fetch pay rates for an employee. Returns the primary (most recent) rate object. */
async function fetchPrimaryPayRate(employeeId) {
  try {
    const res = await callPaycor(`/employees/${employeeId}/payrates`);
    if (res.status !== 200) return null;
    const rates = res.data?.records || res.data || [];
    // Sort by effectiveDate descending, pick first active
    const active = rates.filter(r => r.effectiveDate || r.startDate);
    active.sort((a, b) => {
      const da = new Date(a.effectiveDate || a.startDate || 0);
      const db = new Date(b.effectiveDate || b.startDate || 0);
      return db - da;
    });
    return active[0] || rates[0] || null;
  } catch { return null; }
}

/**
 * Fetch punch records for a legal entity for a date range.
 * Returns array of punch objects.
 */
async function fetchPunches(legalEntityId, startDate, endDate) {
  try {
    const res = await callPaycor(
      `/legalentities/${legalEntityId}/punches?startDate=${startDate}&endDate=${endDate}`
    );
    if (res.status !== 200) return [];
    return res.data?.records || res.data || [];
  } catch { return []; }
}

/**
 * Fetch scheduling shifts for a legal entity for a date range (Paycor Scheduling system).
 * Returns array of shift objects with employeeId, employeeName, startDateTime, endDateTime, etc.
 */
export async function fetchSchedulingShifts(legalEntityId, startDate, endDate) {
  try {
    let allShifts = [];
    let path = `/legalentities/${legalEntityId}/schedulingShifts?startDate=${startDate}&endDate=${endDate}`;
    while (path) {
      const res = await callPaycor(path);
      if (res.status !== 200) break;
      const records = res.data?.records || [];
      allShifts = allShifts.concat(records);
      const nextToken = res.data?.continuationToken;
      if (nextToken && records.length > 0) {
        path = `/legalentities/${legalEntityId}/schedulingShifts?startDate=${startDate}&endDate=${endDate}&continuationToken=${encodeURIComponent(nextToken)}`;
      } else {
        path = null;
      }
    }
    return allShifts;
  } catch { return []; }
}

/**
 * Fetch employeePunches for a single employee on a given date.
 * Returns the actual clock-in time if currently on clock (odd punch count), or null.
 */
export async function fetchLiveClockIn(employeeId, busDt) {
  try {
    const res = await callPaycor(`/employees/${employeeId}/employeePunches?startDate=${busDt}&endDate=${busDt}`);
    if (res.status !== 200) return null;
    const punches = res.data?.records || res.data || [];
    if (!Array.isArray(punches) || punches.length === 0) return null;
    const sorted = punches.sort((a, b) => new Date(a.punchDateTime || a.punchIn || 0) - new Date(b.punchDateTime || b.punchIn || 0));
    if (sorted.length % 2 === 1) {
      const lastPunch = sorted[sorted.length - 1];
      return lastPunch.punchDateTime || lastPunch.punchIn || null;
    }
    return null;
  } catch { return null; }
}

// ── Labor calculation helpers ─────────────────────────────────────────────────

/**
 * Compute hours worked from punch records.
 * Records: { employeeId, punchIn, punchOut, hourAmount, estimatedGrossPay, ... }
 * Also handles legacy timecard fields: inActualPunch, outActualPunch, hoursAmount
 */
function computeHoursFromPunches(punches) {
  // Group by employeeId
  const byEmp = {};
  for (const p of punches) {
    const id = p.employeeId;
    if (!id) continue;
    if (!byEmp[id]) byEmp[id] = [];
    byEmp[id].push(p);
  }
  const result = {};
  for (const [empId, empRecords] of Object.entries(byEmp)) {
    let totalHrs = 0;
    for (const tc of empRecords) {
      // Prefer /punches field names; fall back to legacy /timecard field names
      if (tc.hourAmount != null) {
        totalHrs += tc.hourAmount;
      } else if (tc.hoursAmount != null) {
        totalHrs += tc.hoursAmount;
      } else {
        // Compute from punch timestamps if no pre-computed hours field
        const inMs = new Date(tc.punchIn || tc.inActualPunch || 0).getTime();
        const outMs = new Date(tc.punchOut || tc.outActualPunch || 0).getTime();
        if (inMs && outMs && outMs > inMs) totalHrs += (outMs - inMs) / 3600000;
      }
    }
    result[empId] = totalHrs;
  }
  return result;
}

/**
 * Compute daily labor cost for a single employee.
 * - Hourly: hoursToday * payRate
 * - Salary: biweeklyPay / 12 (6 days/week * 2 weeks)
 */
function computeDailyCost(payType, payRate, annualPay, hoursToday, weeklyHoursBeforeToday) {
  const isSalary = payType === 'Salary' || payType === 'salary';
  if (isSalary) {
    // biweekly = annual / 26; daily = biweekly / 12
    const biweekly = (annualPay || (payRate * 2080)) / 26;
    return biweekly / 12;
  }
  // Hourly — check for overtime
  const rate = payRate || 0;
  if (rate === 0 || hoursToday === 0) return 0;

  const priorHours = weeklyHoursBeforeToday || 0;
  const totalAfter = priorHours + hoursToday;

  if (totalAfter <= 35) {
    // All regular
    return hoursToday * rate;
  } else if (priorHours >= 40) {
    // All OT today
    return hoursToday * rate * 1.5;
  } else if (priorHours >= 35 && priorHours < 40) {
    // Approaching OT or mixed
    const regularHours = Math.max(0, 40 - priorHours);
    const otHours = hoursToday - regularHours;
    return regularHours * rate + Math.max(0, otHours) * rate * 1.5;
  } else {
    // priorHours < 35, totalAfter > 35
    const regularHours = Math.max(0, 40 - priorHours);
    const otHours = Math.max(0, hoursToday - regularHours);
    return Math.min(hoursToday, regularHours) * rate + otHours * rate * 1.5;
  }
}

/** Overtime status: 'ot' if >= 40 weekly hours, 'approaching' if 35-39.99, else false */
function overtimeStatus(weeklyHours) {
  if (weeklyHours >= 40) return 'ot';
  if (weeklyHours >= 35) return 'approaching';
  return false;
}

// ── Process a single store ────────────────────────────────────────────────────

export async function processStore(store, busDt, { skipSchedules = false, pnlConfig = null } = {}) {
  const { pc, paycor: legalEntityId, name, district } = store;
  const weekDates = weekDatesThrough(busDt);
  const weekOfStr  = weekStart(busDt);
  const weekStart_ = weekDates[0];
  const priorDates_ = weekDates.filter(d => d < busDt);
  const payRateCacheKey = `pcg_payrates_${legalEntityId}`;
  const sevenDays = new Date(new Date(busDt + 'T12:00:00').getTime() + 7 * 86400000);
  const endStr = `${sevenDays.getFullYear()}-${String(sevenDays.getMonth()+1).padStart(2,'0')}-${String(sevenDays.getDate()).padStart(2,'0')}`;

  // Sales, the two cache-blob reads, employees, shifts, and punches used to
  // run one at a time (await, then await, then await...) even though none of
  // them needs another's result — the pay-rate cache's *validity* check is
  // the only thing here that actually depends on employees, and that's a
  // synchronous check done below, after this resolves, not another fetch.
  // Firing them together cuts this function's wall-clock time to roughly its
  // slowest single call instead of the sum of all of them. Each piece keeps
  // its exact original error handling: fetchPOSSales still throws on failure
  // (so this function still throws too, unchanged — nothing here catches
  // it), and everything else already had its own try/catch returning a safe
  // default, so combining them in one Promise.all doesn't change what
  // happens when any one of them fails.
  // Set (only) in the employees-fetch catch below. `employees` itself must stay an array
  // (other, unrelated payroll/labor-cost code in this function already depends on that
  // contract) — this separate flag lets Manager Sync specifically distinguish "Paycor
  // fetch failed, unknown state" from "confirmed zero managers" without changing it.
  let employeesFetchFailed = false;

  const [sales, existingBlob, employees, todayShifts, payRateCacheRaw, allPunches] = await Promise.all([
    // 1. POS sales for today from live API
    fetchPOSSales(pc, busDt),

    // For WTD sales: stored daily history from blob (avoids extra POS calls
    // per store). Skip on manual triggers (26s timeout) — scheduled cron
    // (15min) handles full WTD.
    (async () => {
      if (skipSchedules) return null;
      try {
        const blobStore = getLaborStore();
        const raw = await blobStore.get(`pcg_labor_store_${pc}`, { type: 'json' });
        return raw?.data || raw;
      } catch { return null; }
    })(),

    // 2. Employees
    (async () => {
      try {
        const raw = await fetchEmployees(legalEntityId);
        return raw.filter(e => {
          const status = e.statusData?.status || e.employeeStatus || e.status || '';
          return status === 'Active';
        });
      } catch (e) {
        console.warn(`[labor-cron] ${name}: fetchEmployees failed:`, e.message);
        employeesFetchFailed = true;
        return [];
      }
    })(),

    // 2b. 7-day scheduling shifts (skip on manual triggers to stay under timeout)
    (async () => {
      if (skipSchedules) return [];
      try {
        return await fetchSchedulingShifts(legalEntityId, busDt, endStr);
      } catch (e) {
        console.warn(`[labor-cron] ${name}: fetchSchedulingShifts failed:`, e.message);
        return [];
      }
    })(),

    // 3a. Pay-rate cache blob (raw read only — validity depends on employees,
    // checked synchronously below once both are in hand).
    (async () => {
      try {
        const blobStore = getLaborStore();
        const raw = await blobStore.get(payRateCacheKey, { type: 'json' });
        return raw?.data || raw;
      } catch { return null; }
    })(),

    // 4. Punches for the full week
    (async () => {
      try {
        return await fetchPunches(legalEntityId, weekStart_, busDt);
      } catch (e) {
        console.warn(`[labor-cron] ${name}: fetchPunches failed:`, e.message);
        return [];
      }
    })(),
  ]);

  const priorDaySales = {}; // date -> netSales
  if (existingBlob?.daily) {
    for (const d of priorDates_) {
      const dayEntry = existingBlob.daily.find(e => e.date === d);
      priorDaySales[d] = dayEntry?.sales || 0;
    }
  }

  // Count employees scheduled right now (shift overlaps current time)
  const nowUTC = new Date();
  const scheduledNow = new Set();
  const scheduledToday = new Set();
  for (const shift of todayShifts) {
    const start = new Date(shift.startDateTime);
    const end = new Date(shift.endDateTime);
    // Only count shifts that are actually today (filter out yesterday's that bled into query)
    const shiftDate = shift.startDateTime.slice(0, 10);
    if (shiftDate === busDt) {
      scheduledToday.add(shift.employeeId);
      if (nowUTC >= start && nowUTC <= end) {
        scheduledNow.add(shift.employeeId);
      }
    }
  }

  // 3b. Pay rates — use daily cache to avoid hundreds of API calls
  const payRateMap = {}; // employeeId -> { payType, payRate, annualPay }
  let cachedRates = null;
  // Use cache if it's from today AND actually covers every current employee —
  // a partial/empty cache (e.g. from a transient Paycor payrates failure on an
  // earlier run today) must NOT be trusted, or it silently zeroes labor cost
  // for the rest of the day (payRate 0 → computeDailyCost returns 0 even when
  // hoursToday is correctly nonzero).
  const cachedCoversAll = payRateCacheRaw?.rates && employees.every(emp => {
    const id = emp.id || emp.employeeId;
    return !id || payRateCacheRaw.rates[id] != null;
  });
  if (payRateCacheRaw?.date === busDt && cachedCoversAll) {
    cachedRates = payRateCacheRaw.rates;
  }

  if (cachedRates) {
    // Reuse cached rates
    Object.assign(payRateMap, cachedRates);
    console.log(`[labor-cron] ${name}: Using cached pay rates (${Object.keys(cachedRates).length} employees)`);
  } else {
    // Fetch fresh and cache
    let payRateFetchFailures = 0;
    for (let i = 0; i < employees.length; i += 5) {
      const batch = employees.slice(i, i + 5);
      await Promise.all(batch.map(async (emp) => {
        const id = emp.id || emp.employeeId;
        if (!id) return;
        const rate = await fetchPrimaryPayRate(id);
        if (rate) {
          payRateMap[id] = {
            payType:   rate.payType   || rate.type        || 'Hourly',
            payRate:   rate.payRate   || rate.rate        || 0,
            annualPay: rate.annualPayRate || rate.annualPay || 0,
          };
        } else {
          payRateFetchFailures++;
        }
      }));
    }
    // Only cache a complete result — if any employee's payrate fetch failed
    // (transient Paycor error), skip caching so the NEXT hourly run retries
    // instead of being stuck reusing a broken/incomplete cache all day.
    if (payRateFetchFailures === 0 && employees.length > 0) {
      try {
        const blobStore = getLaborStore();
        await blobStore.setJSON(payRateCacheKey, { savedAt: new Date().toISOString(), data: { date: busDt, rates: payRateMap } });
      } catch {}
    } else if (payRateFetchFailures > 0) {
      console.warn(`[labor-cron] ${name}: ${payRateFetchFailures} pay-rate fetch failure(s) — not caching, will retry next run`);
    }
  }

  // Group punches by date
  const punchMap = {}; // date -> { empId -> hoursWorked }
  const punchesByDate = {};
  for (const p of allPunches) {
    const pDate = (p.punchIn || p.clockIn || p.timeIn || '').slice(0, 10);
    if (!pDate) continue;
    if (!punchesByDate[pDate]) punchesByDate[pDate] = [];
    punchesByDate[pDate].push(p);
  }

  // Build per-date hours map
  for (const d of weekDates) {
    punchMap[d] = computeHoursFromPunches(punchesByDate[d] || []);
  }

  // 4b. Estimate in-progress hours for employees currently clocked in.
  // The /punches endpoint only returns COMPLETED shifts (punched out).
  // For employees mid-shift, fetch their actual clock-in time via
  // employeePunches and calculate real hours worked so far.
  //
  // liveClockInStatus captures each fetchLiveClockIn result here (previously
  // discarded once folded into the hours estimate below) so the caller
  // (labor-refresh.mjs) can reuse it instead of re-fetching the exact same
  // employee's live clock-in status a second time moments later — confirmed
  // live in production (2026-09-02): every one of these employees also shows
  // up in labor-refresh.mjs's own separate activeEmpIds check (since this
  // loop just gave them a nonzero hoursToday estimate), so without this,
  // fetchLiveClockIn is called twice per currently-clocked-in employee on
  // every single /labor-refresh request — confirmed as the dominant
  // remaining cost after the earlier Promise.all parallelization (still
  // 11-21s in production with this duplication, vs. the same store loading
  // in 2-4s when this was first tested without it).
  const liveClockInStatus = {}; // employeeId -> clockIn timestamp string | null
  if (!skipSchedules && todayShifts.length > 0) {
    const todayMap = punchMap[busDt] || {};
    const needsLiveCheck = [];
    for (const shift of todayShifts) {
      const empId = shift.employeeId;
      if (!empId) continue;
      const shiftDate = (shift.startDateTime || '').slice(0, 10);
      if (shiftDate !== busDt) continue;
      if ((todayMap[empId] || 0) > 0) continue;
      const shiftStart = new Date(shift.startDateTime);
      if (nowUTC < shiftStart) continue;
      if (!needsLiveCheck.some(e => e.empId === empId)) {
        needsLiveCheck.push({ empId, shiftStart, shiftEnd: new Date(shift.endDateTime) });
      }
    }

    if (needsLiveCheck.length > 0) {
      for (let i = 0; i < needsLiveCheck.length; i += 5) {
        const batch = needsLiveCheck.slice(i, i + 5);
        await Promise.all(batch.map(async ({ empId, shiftStart, shiftEnd }) => {
          const clockIn = await fetchLiveClockIn(empId, busDt);
          liveClockInStatus[empId] = clockIn || null;
          let hrs = 0;
          if (clockIn) {
            // clockIn is Paycor's raw punchDateTime — naive (no timezone) Eastern wall-clock
            // time, not UTC (see src/paycor-time.mjs). A plain `new Date(clockIn)` here would
            // misread it as ~4-5 hours earlier than it actually happened and overstate this
            // employee's hours-worked-so-far (and live labor cost) by that same amount for
            // every minute they're still clocked in.
            const actualStartMs = parsePaycorPunchMs(clockIn);
            if (Number.isFinite(actualStartMs)) {
              hrs = (nowUTC - actualStartMs) / 3600000;
            }
          } else {
            const effectiveEnd = nowUTC < shiftEnd ? nowUTC : shiftEnd;
            hrs = (effectiveEnd - shiftStart) / 3600000;
          }
          if (hrs > 0) {
            todayMap[empId] = Math.round(hrs * 100) / 100;
          }
        }));
      }
    }
    punchMap[busDt] = todayMap;
  }

  // 5. Compute weekly hours per employee (excluding today)
  const weeklyHoursExcludingToday = {}; // empId -> total hours Mon-yesterday
  const priorDates = weekDates.filter(d => d < busDt);
  for (const emp of employees) {
    const id = emp.id || emp.employeeId;
    if (!id) continue;
    weeklyHoursExcludingToday[id] = priorDates.reduce((sum, d) => sum + (punchMap[d]?.[id] || 0), 0);
  }

  // 6. Build today's employee details
  const todayPunchMap = punchMap[busDt] || {};
  const employeeDetails = [];
  let totalLaborDollarsToday = 0;
  let hoursWorkedToday = 0;
  let employeesOnClock = 0;
  let otCount = 0;

  for (const emp of employees) {
    const id   = emp.id || emp.employeeId;
    if (!id) continue;
    const firstName = emp.firstName || '';
    const lastName  = emp.lastName  || '';
    const role      = emp.jobTitle  || emp.department || '';
    const pr        = payRateMap[id] || { payType: 'Hourly', payRate: 0, annualPay: 0 };
    const hoursToday    = todayPunchMap[id] || 0;
    const priorHours    = weeklyHoursExcludingToday[id] || 0;
    const hoursThisWeek = priorHours + hoursToday;
    const costToday     = computeDailyCost(pr.payType, pr.payRate, pr.annualPay, hoursToday, priorHours);
    const otStatus      = overtimeStatus(hoursThisWeek);

    totalLaborDollarsToday += costToday;
    hoursWorkedToday       += hoursToday;
    if (hoursToday > 0) employeesOnClock++;
    if (otStatus === 'ot') otCount++;

    employeeDetails.push({
      employeeId:    id,
      name:          `${firstName} ${lastName}`.trim(),
      role,
      payType:       pr.payType,
      payRate:       pr.payRate,
      hoursToday:    Math.round(hoursToday * 100) / 100,
      hoursThisWeek: Math.round(hoursThisWeek * 100) / 100,
      costToday:     Math.round(costToday * 100) / 100,
      overtime:      otStatus,
    });
  }

  // 7. Compute WTD labor (sum prior days + today)
  let wtdLaborDollars = totalLaborDollarsToday;
  let wtdSales = sales.netSales;

  for (const d of priorDates) {
    const dayPunches = punchMap[d] || {};
    for (const emp of employees) {
      const id = emp.id || emp.employeeId;
      if (!id) continue;
      const h = dayPunches[id] || 0;
      const pr = payRateMap[id] || { payType: 'Hourly', payRate: 0, annualPay: 0 };
      const dayPrior = priorDates.filter(pd => pd < d).reduce((sum, pd) => sum + (punchMap[pd]?.[id] || 0), 0);
      wtdLaborDollars += computeDailyCost(pr.payType, pr.payRate, pr.annualPay, h, dayPrior);
    }
    wtdSales += priorDaySales[d] || 0;
  }

  const laborPctToday = sales.netSales > 0 ? (totalLaborDollarsToday / sales.netSales) * 100 : 0;
  const wtdLaborPct   = wtdSales > 0 ? (wtdLaborDollars / wtdSales) * 100 : 0;

  // ── Per-store P&L (menu-mix × unit cost → COGS → contribution) ──────────────
  let pnl = null;
  try {
    const menuMix = await getStoreMenuMix(store.pc, busDt);
    const cogsPct = cogsPctFor(pnlConfig || { defaultCogsPct: undefined, byStore: {}, byDistrict: {} }, store);
    pnl = computeStorePnL(
      { revenue: sales.netSales, labor: totalLaborDollarsToday, menuMix, cogsPct },
      lookupUnitCost,
    );
  } catch (e) {
    console.warn('[labor-cron] P&L compute failed for', store.pc, ':', e.message);
    pnl = null; // menu-mix unavailable → labor-only path still works
  }

  return {
    pc,
    name,
    district,
    paycorId: legalEntityId,
    today: {
      date: busDt,
      laborDollars:     Math.round(totalLaborDollarsToday * 100) / 100,
      sales:            Math.round(sales.netSales * 100) / 100,
      laborPct:         Math.round(laborPctToday * 10) / 10,
      hoursWorked:      Math.round(hoursWorkedToday * 100) / 100,
      employees:        employees.length,
      employeesOnClock,
      scheduledNow:     scheduledNow.size,
      scheduledToday:   scheduledToday.size,
      overtimeCount:    otCount,
    },
    wtd: {
      laborDollars: Math.round(wtdLaborDollars * 100) / 100,
      sales:        Math.round(wtdSales * 100) / 100,
      laborPct:     Math.round(wtdLaborPct * 10) / 10,
    },
    employeeDetails,
    // null (not []) when the employees fetch itself failed, so Manager Sync's aggregation
    // step (which already skips a store with a non-array managerCandidates, same as a
    // fully-errored processStore call) treats this as "unknown" rather than "confirmed
    // zero managers" — a transient Paycor failure must never look like a vacant store.
    managerCandidates: employeesFetchFailed ? null : managerMatches(employees),
    liveClockInStatus,
    scheduleShifts: todayShifts.map(s => ({
      employeeId:    s.employeeId   || s.EmployeeId   || null,
      employeeName:  s.employeeName || (s.firstName && s.lastName ? `${s.firstName} ${s.lastName}` : null) || s.EmployeeName || null,
      startDateTime: s.startDateTime || s.StartDateTime || null,
      endDateTime:   s.endDateTime   || s.EndDateTime   || null,
      date:          (s.startDateTime || s.StartDateTime || '').slice(0, 10),
      jobTitle:      s.schedulingJobName || s.jobTitle || s.JobTitle || null,
    })).filter(s => s.employeeId && s.startDateTime),
    pnl,
  };
}

// ── Batch-process all stores ──────────────────────────────────────────────────

async function processAllStores(busDt, batchSize = 8, opts = {}) {
  const results = [];
  for (let i = 0; i < STORES.length; i += batchSize) {
    const batch = STORES.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (store) => {
        try {
          return await processStore(store, busDt, opts);
        } catch (e) {
          console.error(`[labor-cron] ${store.name} (${store.pc}) error:`, e.message);
          return {
            pc: store.pc,
            name: store.name,
            district: store.district,
            paycorId: store.paycor,
            error: e.message,
            today: { date: busDt, laborDollars: 0, sales: 0, laborPct: 0, hoursWorked: 0, employees: 0, employeesOnClock: 0, overtimeCount: 0 },
            wtd:   { laborDollars: 0, sales: 0, laborPct: 0 },
            employeeDetails: [],
          };
        }
      })
    );
    results.push(...batchResults);
    // Small pause between batches to respect Paycor rate limits
    if (i + batchSize < STORES.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return results;
}

// ── Blob helpers ──────────────────────────────────────────────────────────────

export function getLaborStore() {
  return getStore({
    name: 'pcg-portal',
    consistency: 'strong',
    siteID: process.env.PCG_SITE_ID,
    token:  process.env.PCG_AUTH_TOKEN,
  });
}

/**
 * Merge today's daily entry into the per-store blob.
 * Keeps the last 30 daily records and last 13 weekly records.
 */
export function mergeStoreBlob(existing, todayEntry, weeklyEntry) {
  const MAX_DAILY  = 30;
  const MAX_WEEKLY = 13;

  // A single malformed historical entry (missing/null date, e.g. from a past bad write)
  // used to permanently brick this function: .sort() called .localeCompare() on a
  // non-string date and threw, the exception was swallowed by the caller's per-store
  // try/catch, and the blob was silently never written again — sometimes for weeks.
  // Drop anything that isn't a real date string BEFORE dedup/sort so one bad record
  // can never again freeze a whole store's labor history.
  const validDaily = (Array.isArray(existing?.daily) ? existing.daily : []).filter(d => typeof d?.date === 'string' && d.date);
  const daily = [...validDaily];
  // Replace or append today
  const todayIdx = daily.findIndex(d => d.date === todayEntry.date);
  if (todayIdx >= 0) {
    daily[todayIdx] = todayEntry;
  } else {
    daily.push(todayEntry);
  }
  // Keep most recent MAX_DAILY
  daily.sort((a, b) => b.date.localeCompare(a.date));
  const trimmedDaily = daily.slice(0, MAX_DAILY);

  const validWeekly = (Array.isArray(existing?.weekly) ? existing.weekly : []).filter(w => typeof w?.weekOf === 'string' && w.weekOf);
  const weekly = [...validWeekly];
  const weekIdx = weekly.findIndex(w => w.weekOf === weeklyEntry.weekOf);
  if (weekIdx >= 0) {
    weekly[weekIdx] = weeklyEntry;
  } else {
    weekly.push(weeklyEntry);
  }
  weekly.sort((a, b) => b.weekOf.localeCompare(a.weekOf));
  const trimmedWeekly = weekly.slice(0, MAX_WEEKLY);

  return {
    lastUpdated: new Date().toISOString(),
    daily: trimmedDaily,
    weekly: trimmedWeekly,
  };
}

// ── P&L config + COGS helpers ─────────────────────────────────────────────────

/**
 * Load the COGS-% fallback config once per run.
 * Blob shape: { defaultCogsPct, byStore: { [pc]: pct }, byDistrict: { [district]: pct } }
 * @param {object} blobStore  the @netlify/blobs store
 */
async function loadPnlConfig(blobStore) {
  try {
    const wrapped = await blobStore.get('pcg_pnl_config_v1', { type: 'json' });
    const cfg = wrapped?.data || {};
    return {
      defaultCogsPct: typeof cfg.defaultCogsPct === 'number' ? cfg.defaultCogsPct : DEFAULT_COGS_PCT,
      byStore:    cfg.byStore || {},
      byDistrict: cfg.byDistrict || {},
    };
  } catch {
    return { defaultCogsPct: DEFAULT_COGS_PCT, byStore: {}, byDistrict: {} };
  }
}

/** Resolve the COGS-% fallback for a store: per-store → per-district → network default. */
function cogsPctFor(cfg, store) {
  return cfg.byStore[String(store.pc)]
    ?? cfg.byDistrict[String(store.district)]
    ?? cfg.defaultCogsPct;
}

const MANAGER_PENDING_KEY = 'pcg_manager_pending_v1';

// Full automation for the clear-cut 'replace' case only (2026-09-24 decision — see
// docs/superpowers/specs/2026-09-22-manager-sync-design.md's 2026-09-24 addendum).
// needsReview (ambiguous — multiple candidates) and vacant (no candidate at all) are NOT
// eligible: there's either no safe single choice, or no data to create an account from.
// Called only after a candidate has been seen on 2 consecutive runs (the caller's job) —
// this function itself does the actual creation + deactivation, no further gating.
async function autoApplyManagerReplace({ pc, storeName, candidate, outgoingUserId, outgoingName }) {
  const db = sql();

  // Defense in depth: if an active account is somehow already linked to this exact Paycor
  // employee (e.g. a partial failure on an earlier run created it but a later step, like
  // the pending-blob save, failed — leaving this same candidate looking "new" again next
  // run), don't create a duplicate. Just make sure the outgoing account still gets
  // deactivated and stop.
  const existing = await db`SELECT id FROM users WHERE paycor_employee_id = ${candidate.employeeId} AND active = true LIMIT 1`;
  let createdNew = false;
  if (!existing.length) {
    const existingUsernameRows = await db`SELECT username FROM users`;
    const username = suggestUsername(candidate.name, existingUsernameRows.map(r => r.username));
    const password = generatePassword();
    const email = `${pc}@peoplecapitalgroup.com`; // always this domain for anything created
                                                    // going forward — @rgi.life is retired.
    const initials = candidate.name.trim().split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const passwordHash = hashPassword(password);
    const [row] = await db`
      INSERT INTO users (
        username, name, email, phone, role, user_type, district, store_pc,
        active, dark_mode, initials, is_admin, must_setup, region,
        password_hash, must_change, two_factor_required, audits_access,
        paycor_employee_id, created_at, updated_at
      ) VALUES (
        ${username}, ${candidate.name}, ${email}, null, ${candidate.jobTitle || null},
        'manager', null, ${pc},
        true, false, ${initials}, false, true, 'PA',
        ${passwordHash}, true, false, null,
        ${candidate.employeeId}, now(), now()
      )
      ON CONFLICT (username) DO NOTHING
      RETURNING id
    `;
    if (!row) throw new Error(`username collision on auto-create for ${username} (unexpected)`);
    createdNew = true;

    // Welcome email — best-effort, mirrors the manual Review-modal flow's email. Never
    // blocks account creation on a delivery failure; the account is real either way.
    try {
      const subject = 'Welcome to the PCG Company Portal!';
      const htmlBody = `
        <h2 style="color:#333;margin-bottom:8px;">Welcome, ${candidate.name}! 👋</h2>
        <p style="color:#555;font-size:15px;">Your account has been created on the <strong>PCG Company Portal</strong>.</p>
        <div style="background:#f8f8f8;border-radius:8px;padding:16px 20px;margin:16px 0;">
          <p style="margin:4px 0;font-size:14px;"><strong>Portal URL:</strong> <a href="https://pcg-ops.netlify.app/" style="color:#FF671F;">https://pcg-ops.netlify.app/</a></p>
          <p style="margin:4px 0;font-size:14px;"><strong>Username:</strong> ${username}</p>
          <p style="margin:4px 0;font-size:14px;"><strong>Password:</strong> ${password}</p>
        </div>
        <p style="color:#555;font-size:14px;">On your first login, you'll be asked to change your password and set up your profile.</p>
      `;
      await sendEmail([email], subject, htmlBody);
    } catch (e) { console.warn('[manager-sync] welcome email failed for', pc, ':', e.message); }
  }

  if (outgoingUserId) {
    await db`UPDATE users SET active = false, updated_at = now() WHERE id = ${outgoingUserId} AND active = true`;
  }

  return { createdNew };
}

// Runs once per labor-cron invocation, after all stores have been processed. Compares
// each store's managerCandidates (from Step 1, no new Paycor call) against the currently
// linked Portal manager, updates the pending-change blob, bootstrap-links an
// already-correct pre-existing manager silently, and appends a bell notification for any
// NEWLY-queued item. See docs/superpowers/specs/2026-09-22-manager-sync-design.md.
async function runManagerSync(storeResults, blobStore, nowMs) {
  // pc -> array of ALL active manager rows for that store (normally 0 or 1; can briefly be
  // >1 mid-transition — new account created+linked, old one not yet deactivated). Keeping
  // the full array (not collapsing to the last row) is what Finding 4 of the final review
  // fixed: a silent overwrite here used to lose track of whichever row didn't win, so it
  // could never be flagged for deactivation.
  let linkedByPc = {};
  try {
    const db = sql();
    const rows = await db`SELECT id, name, store_pc, paycor_employee_id FROM users WHERE user_type = 'manager' AND active = true`;
    for (const r of rows) {
      const key = String(r.store_pc);
      (linkedByPc[key] ||= []).push({ id: r.id, name: r.name, employeeId: r.paycor_employee_id });
    }
  } catch (e) {
    console.warn('[manager-sync] linked-manager lookup failed, skipping this run:', e.message);
    return;
  }

  let pending = {};
  try {
    const raw = await blobStore.get(MANAGER_PENDING_KEY, { type: 'json' });
    pending = (raw && raw.data) ? raw.data : {};
  } catch { pending = {}; }

  const newNotifs = [];

  for (const r of storeResults) {
    if (!r || !Array.isArray(r.managerCandidates)) continue;
    const pc = r.pc;
    const linkedRows = linkedByPc[pc] || [];
    const prevPending = pending[pc];

    // Normally 0 or 1 active manager row per store. When there's more than one, try to
    // cleanly resolve which row is "the" correctly-linked one (exactly one row's
    // paycor_employee_id matches today's single Paycor candidate) and keep every other
    // still-active row as a pending "still needs deactivation" outgoing account, rather
    // than silently picking one and losing track of the rest.
    let linked = linkedRows[0] || null;
    let extraOutgoing = null; // an additional still-active row that needs deactivating
    if (linkedRows.length > 1) {
      const singleCandidate = r.managerCandidates.length === 1 ? r.managerCandidates[0] : null;
      const matchingRows = singleCandidate ? linkedRows.filter((row) => row.employeeId && row.employeeId === singleCandidate.employeeId) : [];
      const nonMatchingRows = linkedRows.filter((row) => !matchingRows.includes(row));
      if (matchingRows.length === 1 && nonMatchingRows.length > 0) {
        linked = matchingRows[0];
        extraOutgoing = nonMatchingRows[0];
      }
      // else: ambiguous (no clean single match) — fall back to the first row, same as the
      // pre-fix behavior, rather than leaving the store unhandled.
    }

    // Bootstrap linking: linked manager exists but has never been linked to a Paycor id yet.
    if (linked && !linked.employeeId && r.managerCandidates.length === 1) {
      const only = r.managerCandidates[0];
      if (namesCorrespond(only.name, linked.name)) {
        try {
          const db = sql();
          await db`UPDATE users SET paycor_employee_id = ${only.employeeId}, updated_at = now() WHERE id = ${linked.id}`;
        } catch (e) { console.warn('[manager-sync] bootstrap link failed for', pc, ':', e.message); }
        delete pending[pc];
        continue; // silent — no notification, matches spec
      }
      // Names don't correspond → fall through to the normal replace detection below,
      // treating this store as having no confirmed link (linkedEmployeeId stays null).
    }

    const linkedEmployeeId = linked?.employeeId || null;
    const result = detectManagerCandidate({ matches: r.managerCandidates, linkedEmployeeId });

    if (result.status === 'ok') {
      if (extraOutgoing) {
        // Half-resolved multi-manager state: the current single Paycor candidate is
        // correctly linked (a new account already exists for it), but another active
        // manager row for the same store hasn't been deactivated yet. Keep a `replace`
        // pending entry alive — with outgoingUserId pointing at the still-active old
        // row — so the Admin Users banner keeps showing its Deactivate button instead
        // of the store silently looking fully resolved.
        // Same dismissal scoping as the normal `replace` path below — an admin who
        // dismissed this exact reminder must not have it reappear next run just because
        // the underlying DB state hasn't changed.
        if (prevPending?.kind === 'dismissed' && prevPending.dismissedCandidateEmployeeId === linkedEmployeeId) continue;
        const alreadyKnown = prevPending?.kind === 'replace'
          && prevPending.candidate?.employeeId === linkedEmployeeId
          && prevPending.outgoingUserId === extraOutgoing.id;
        pending[pc] = {
          kind: 'replace',
          candidate: { employeeId: linkedEmployeeId, name: linked.name, jobTitle: r.managerCandidates[0]?.jobTitle || '' },
          outgoingUserId: extraOutgoing.id,
          outgoingName: extraOutgoing.name,
          detectedAt: prevPending?.detectedAt || new Date(nowMs).toISOString(),
        };
        if (!alreadyKnown) newNotifs.push({ pc, storeName: r.name, kind: 'replace', text: `${r.name}: ${extraOutgoing.name} is still active and needs to be deactivated now that ${linked.name} is the linked manager` });
        continue;
      }
      delete pending[pc];
      continue;
    }

    if (result.status === 'replace') {
      const currentOutgoingId = linked?.id || null;
      const isNewCandidate = !shouldAutoApplyReplace({ prevPending, candidateEmployeeId: result.candidate.employeeId });

      // Admin explicitly dismissed this exact candidate before — Paycor's underlying data
      // hasn't changed, so don't re-queue, re-confirm, or auto-apply (a genuinely
      // different candidate, i.e. a different employeeId, is NOT suppressed by this).
      if (prevPending?.kind === 'dismissed' && prevPending.dismissedCandidateEmployeeId === result.candidate.employeeId) continue;

      if (!isNewCandidate) {
        // Seen this exact candidate on the previous run too — confirmed, not a one-off
        // Paycor read glitch. Full automation for this clear-cut single-candidate case
        // (2026-09-24 decision, replacing the old human-review-required flow): create the
        // new manager account and deactivate the outgoing one, no click needed. Uses
        // currentOutgoingId (freshly computed this run), not whatever prevPending had —
        // so it's still correct even if the outgoing account only just became known.
        try {
          await autoApplyManagerReplace({
            pc, storeName: r.name, candidate: result.candidate,
            outgoingUserId: currentOutgoingId, outgoingName: linked?.name || null,
          });
          delete pending[pc];
          newNotifs.push({
            pc, storeName: r.name, kind: 'auto-replaced',
            text: `${r.name}: ${result.candidate.name} is now the manager — account auto-created${linked?.name ? `, ${linked.name} deactivated` : ''}.`,
          });
        } catch (e) {
          console.warn('[manager-sync] auto-apply failed for', pc, ':', e.message);
          // Fall back to a visible pending entry — better than silently losing track of a
          // confirmed, actionable change if the automation itself hit a real error.
          pending[pc] = {
            kind: 'replace',
            candidate: { employeeId: result.candidate.employeeId, name: result.candidate.name, jobTitle: result.candidate.jobTitle },
            outgoingUserId: currentOutgoingId,
            outgoingName: linked?.name || null,
            detectedAt: prevPending?.detectedAt || new Date(nowMs).toISOString(),
            autoApplyFailed: true,
          };
          newNotifs.push({ pc, storeName: r.name, kind: 'replace', text: `${r.name}: auto-create failed for ${result.candidate.name} — needs manual review.` });
        }
        continue;
      }

      // First-ever detection of this exact candidate: queue it silently and wait for
      // confirmation on the next run before doing anything — one lone Paycor read
      // shouldn't be enough to create a real account. No notification here; the only
      // user-facing signal is the "auto-replaced" one once it's actually confirmed+applied
      // (or the failure notice above, if automation itself errors).
      pending[pc] = {
        kind: 'replace',
        candidate: { employeeId: result.candidate.employeeId, name: result.candidate.name, jobTitle: result.candidate.jobTitle },
        outgoingUserId: currentOutgoingId,
        outgoingName: linked?.name || null,
        detectedAt: new Date(nowMs).toISOString(),
      };
      continue;
    }

    if (result.status === 'needsReview') {
      const newIds = result.candidates.map((c) => c.employeeId).sort().join(',');
      const prevIds = (prevPending?.kind === 'needsReview' ? prevPending.candidates || [] : []).map((c) => c.employeeId).sort().join(',');
      if (prevPending?.kind === 'needsReview' && newIds === prevIds) continue; // same candidate set already queued, don't re-notify
      // Same dismissal scoping as `replace`, keyed off the sorted candidate-id set instead
      // of a single employeeId.
      if (prevPending?.kind === 'dismissed' && prevPending.dismissedCandidateEmployeeId === newIds) continue;
      pending[pc] = { kind: 'needsReview', candidates: result.candidates, detectedAt: new Date(nowMs).toISOString() };
      newNotifs.push({ pc, storeName: r.name, kind: 'needsReview', text: `${r.name}: multiple active employees hold a manager title — needs a human decision` });
      continue;
    }

    // zeroMatch — single persisted "streak started" timestamp (zeroSinceMs) + a
    // "already queued this streak" flag (vacantQueued), rather than an incrementing
    // week counter. Replaces the old {zeroMatchWeeks, lastCheckedAt} design, which
    // started the counter at week 1 with zero elapsed time and so crossed the
    // "3 weeks" threshold after only 14 real days. See advanceVacantStreak in
    // src/manager-sync.mjs for the (independently verified) math.
    const prevZeroSinceMs = prevPending?.kind === 'vacant' ? (prevPending.zeroSinceMs ?? null) : null;
    const prevAlreadyQueued = prevPending?.kind === 'vacant' ? !!prevPending.vacantQueued : false;
    const { zeroSinceMs, shouldQueue, queued } = advanceVacantStreak({
      zeroMatchThisRun: true, nowMs, zeroSinceMs: prevZeroSinceMs, alreadyQueued: prevAlreadyQueued,
    });
    pending[pc] = { kind: 'vacant', zeroSinceMs, vacantQueued: queued, detectedAt: new Date(zeroSinceMs).toISOString() };
    if (shouldQueue) newNotifs.push({ pc, storeName: r.name, kind: 'vacant', text: `${r.name}: no active employee has held a manager title for 3+ weeks` });
  }

  // Cleanup: drop pending entries for stores that are provably gone (no longer in the STORES
  // config at all) rather than ones that merely errored/were skipped this particular run —
  // those still appear in STORES and simply didn't reach the loop body above (managerCandidates
  // missing), so their pending entries are left untouched.
  const configuredPcs = new Set(STORES.map((s) => String(s.pc)));
  for (const pc of Object.keys(pending)) {
    if (!configuredPcs.has(String(pc))) delete pending[pc];
  }

  try { await blobStore.setJSON(MANAGER_PENDING_KEY, { savedAt: new Date().toISOString(), data: pending }); }
  catch (e) { console.warn('[manager-sync] pending-blob write failed:', e.message); }

  if (newNotifs.length) {
    try {
      const existing = await blobStore.get('pcg_notifications_v1', { type: 'json' });
      const list = Array.isArray(existing) ? existing : (existing?.data || []);
      const appended = newNotifs.map((n) => ({
        id: `mgrsync_${n.pc}_${Date.now()}`,
        type: 'manager_change_pending',
        storePC: n.pc,
        message: n.text,
        read: false, createdAt: new Date(nowMs).toISOString(),
      }));
      await blobStore.setJSON('pcg_notifications_v1', { savedAt: new Date().toISOString(), data: [...appended, ...list].slice(0, 500) });
    } catch (e) { console.warn('[manager-sync] notification write failed:', e.message); }
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async (request, context) => {
  const startMs = Date.now();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const body = await request.json().catch(() => ({}));
  const scheduled = request.headers.get('x-pcg-invocation') === 'scheduled' || !!body?.next_run;
  const isManual = request.method === 'POST' && !scheduled;
  const startedAt = new Date().toISOString();

  // ── TEMPORARY: one-off historical backfill for a single store's daily history ──
  // Added 2026-07-15 to repair Bustleton (332941) after a corrupt blob entry silently
  // froze its per-store daily history June 5 – July 14 (see mergeStoreBlob fix above).
  // POST { storePC, backfillDates: ["2026-06-05", ...] } — small batches only (26s cap).
  // REMOVE this branch once the backfill is done; it's not meant to ship long-term.
  if (isManual && Array.isArray(body?.backfillDates) && body.backfillDates.length) {
    const storeConfig = STORES.find(s => String(s.pc) === String(body.storePC));
    if (!storeConfig) return new Response(JSON.stringify({ error: `Store ${body.storePC} not found` }), { status: 404, headers });
    const blobStore = getLaborStore();
    const key = `pcg_labor_store_${body.storePC}`;
    const results = [];
    for (const busDt of body.backfillDates) {
      try {
        const result = await processStore(storeConfig, busDt, { skipSchedules: true });
        if (result.error) { results.push({ busDt, error: result.error }); continue; }
        let existing = null;
        try { const raw = await blobStore.get(key, { type: 'json' }); existing = raw?.data || raw; } catch {}
        const weekOfStr = weekStart(busDt);
        const dailyEntry = { date: busDt, laborDollars: result.today.laborDollars, sales: result.today.sales, laborPct: result.today.laborPct, hoursWorked: result.today.hoursWorked, employees: result.employeeDetails };
        const weeklyEntry = { weekOf: weekOfStr, laborDollars: result.wtd.laborDollars, sales: result.wtd.sales, laborPct: result.wtd.laborPct, avgDailyEmployees: result.today.employees };
        const merged = mergeStoreBlob(existing, dailyEntry, weeklyEntry);
        await blobStore.setJSON(key, { savedAt: new Date().toISOString(), data: merged });
        results.push({ busDt, laborPct: result.today.laborPct, sales: result.today.sales });
      } catch (e) {
        results.push({ busDt, error: e.message });
      }
    }
    return new Response(JSON.stringify({ ok: true, store: body.storePC, results }), { status: 200, headers });
  }

  // NOTE: the old scoped single-store refresh branch (POST { storePC }) lived
  // here. It's been moved to labor-refresh.mjs — this function has
  // `config.schedule` above, and Netlify's edge blocks ALL direct external
  // POSTs to any scheduled function, so that branch was silently unreachable
  // from the client the whole time. See labor-refresh.mjs for the live version.

  // ── Cron trigger → hand off to the 15-min background function ──────────────
  // The full 45-store aggregation (Paycor employees/punches/shifts per store) takes
  // minutes and cannot finish inside a synchronous scheduled function's time limit —
  // it gets killed before the pcg_labor_v1 write, leaving the UI stale ("updated Nh ago").
  // Netlify marks the real cron invocation with body.next_run; the background function
  // re-invokes this handler with x-pcg-invocation:scheduled but NO next_run, so it skips
  // this branch and runs the real aggregation below (no loop).
  if (body?.next_run) {
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://pcg-ops.netlify.app';
    try {
      const r = await fetch(`${base}/.netlify/functions/labor-cron-background`, { method: 'POST' });
      if (!r.ok) throw new Error(`background returned ${r.status}`);
      console.log('[labor-cron] cron trigger → dispatched labor-cron-background (15-min)');
      return new Response(JSON.stringify({ ok: true, dispatched: 'labor-cron-background' }), { status: 202, headers });
    } catch (e) {
      // Surface dispatch failures as a real error (not a false 202) so they're visible in
      // Netlify observability rather than silently leaving labor data stale.
      console.error('[labor-cron] failed to dispatch background:', e.message);
      return new Response(JSON.stringify({ ok: false, error: 'dispatch failed: ' + e.message }), { status: 500, headers });
    }
  }

  console.log('[labor-cron] triggered at', startedAt, isManual ? '(manual)' : '(scheduled)');

  try {
    // Determine business date
    let busDt = null;
    for (const s of STORES) {
      busDt = await fetchLatestBusDt(s.pc);
      if (busDt) break;
    }
    if (!busDt) {
      busDt = todayET();
      console.log('[labor-cron] getLatestBusDt unavailable, using today:', busDt);
    }
    console.log('[labor-cron] business date:', busDt);

    // Persist to Blobs
    const blobStore = getLaborStore();

    // Load P&L COGS config + process all stores in batches of 5
    const pnlConfig = await loadPnlConfig(blobStore);
    const storeResults = await processAllStores(busDt, 5, { skipSchedules: isManual, pnlConfig });

    // Build network summary
    const successStores = storeResults.filter(r => !r.error);
    const networkLaborDollars   = successStores.reduce((s, r) => s + r.today.laborDollars, 0);
    const networkSales          = successStores.reduce((s, r) => s + r.today.sales, 0);
    const networkLaborPct       = networkSales > 0 ? (networkLaborDollars / networkSales) * 100 : 0;
    const networkTotalEmployees = successStores.reduce((s, r) => s + r.today.employees, 0);
    const networkOnClock        = successStores.reduce((s, r) => s + r.today.employeesOnClock, 0);
    const networkScheduledNow   = successStores.reduce((s, r) => s + (r.today.scheduledNow || 0), 0);
    const networkScheduledToday = successStores.reduce((s, r) => s + (r.today.scheduledToday || 0), 0);
    const networkOTCount        = successStores.reduce((s, r) => s + r.today.overtimeCount, 0);

    // Build stores map for network blob
    const storesSummary = {};
    for (const r of storeResults) {
      storesSummary[r.pc] = {
        name:     r.name,
        district: r.district,
        paycorId: r.paycorId,
        today: {
          laborDollars:    r.today.laborDollars,
          sales:           r.today.sales,
          laborPct:        r.today.laborPct,
          employees:       r.today.employees,
          employeesOnClock: r.today.employeesOnClock,
          scheduledNow:    r.today.scheduledNow || 0,
          scheduledToday:  r.today.scheduledToday || 0,
          hoursWorked:     r.today.hoursWorked,
          overtimeCount:   r.today.overtimeCount,
        },
        wtd: {
          laborDollars: r.wtd.laborDollars,
          sales:        r.wtd.sales,
          laborPct:     r.wtd.laborPct,
        },
        ...(r.error ? { error: r.error } : {}),
      };
    }

    const networkBlob = {
      lastUpdated: new Date().toISOString(),
      busDt,
      network: {
        laborDollars:      Math.round(networkLaborDollars * 100) / 100,
        sales:             Math.round(networkSales * 100) / 100,
        laborPct:          Math.round(networkLaborPct * 10) / 10,
        totalEmployees:    networkTotalEmployees,
        employeesOnClock:  networkOnClock,
        scheduledNow:      networkScheduledNow,
        scheduledToday:    networkScheduledToday,
        overtimeCount:     networkOTCount,
      },
      stores: storesSummary,
    };

    // 1) Network summary blob
    await blobStore.setJSON('pcg_labor_v1', { savedAt: new Date().toISOString(), data: networkBlob });
    console.log('[labor-cron] Wrote pcg_labor_v1');

    // 2) Per-store blobs (in batches of 8)
    const weekOfStr = weekStart(busDt);
    for (let i = 0; i < storeResults.length; i += 8) {
      const batch = storeResults.slice(i, i + 8);
      await Promise.all(batch.map(async (r) => {
       try {
        if (!r || !r.today || !r.wtd) { console.warn('[labor-cron] skipping per-store blob — incomplete data for', r?.pc, r?.name); return; }
        const key = `pcg_labor_store_${r.pc}`;
        let existing = null;
        try {
          const raw = await blobStore.get(key, { type: 'json' });
          existing = raw?.data || raw;
        } catch {}

        const dailyEntry = {
          date:         busDt,
          laborDollars: r.today.laborDollars,
          sales:        r.today.sales,
          laborPct:     r.today.laborPct,
          hoursWorked:  r.today.hoursWorked,
          employees:    r.employeeDetails,
        };

        const weeklyEntry = {
          weekOf:              weekOfStr,
          laborDollars:        r.wtd.laborDollars,
          sales:               r.wtd.sales,
          laborPct:            r.wtd.laborPct,
          avgDailyEmployees:   r.today.employees,
        };

        const merged = mergeStoreBlob(existing, dailyEntry, weeklyEntry);
        await blobStore.setJSON(key, { savedAt: new Date().toISOString(), data: merged });

        // Save 7-day schedule blob (skip if no shifts fetched)
        if (r.scheduleShifts && r.scheduleShifts.length > 0) {
          const schedKey = `pcg_schedule_${r.pc}`;
          await blobStore.setJSON(schedKey, { savedAt: new Date().toISOString(), data: {
            busDt, updatedAt: new Date().toISOString(), shifts: r.scheduleShifts,
          }});
        }
       } catch (e) {
         console.warn('[labor-cron] per-store blob write failed for', r?.pc, ':', e.message);
       }
      }));
    }
    console.log('[labor-cron] Wrote per-store blobs for', storeResults.length, 'stores');

    // Manager Sync detection is not on the critical path (payroll/labor-cost data) — run
    // it after the network + per-store blob writes above, not before, so a scheduled
    // function's timeout budget always favors the critical work first.
    try { await runManagerSync(storeResults, blobStore, Date.now()); }
    catch (e) { console.warn('[manager-sync] aggregation failed, skipping this run:', e.message); }

    // ── P&L live snapshot + per-store history ────────────────────────────────
    try {
      const pnlStores = [];
      const pnlExcluded = [];
      for (const r of storeResults) {
        if (!r) continue;
        if (!r.pnl || !r.pnl.revenue) {
          pnlExcluded.push({ pc: r.pc, name: r.name, reason: r.pnl ? 'no revenue' : 'no labor/menu data' });
          continue;
        }
        pnlStores.push({ pc: r.pc, name: r.name, district: r.district, ...r.pnl });
      }

      const bomCount = pnlStores.filter(s => s.method === 'BOM').length;
      const estCount = pnlStores.length - bomCount;
      const avgCoverage = pnlStores.length
        ? Math.round(pnlStores.reduce((sum, s) => sum + (s.coverage || 0), 0) / pnlStores.length)
        : 0;
      console.log(`[labor-cron] P&L: ${pnlStores.length} stores (${bomCount} BOM / ${estCount} est, avg coverage ${avgCoverage}%), ${pnlExcluded.length} excluded`);

      const agg = pnlStores.reduce((a, s) => {
        a.revenue += s.revenue; a.labor += s.labor; a.cogs += s.cogs; a.contribution += s.contribution; return a;
      }, { revenue: 0, labor: 0, cogs: 0, contribution: 0 });
      const r2 = (n) => Math.round(n * 100) / 100;
      const p1 = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
      const pnlNetwork = {
        revenue: r2(agg.revenue), labor: r2(agg.labor), cogs: r2(agg.cogs), contribution: r2(agg.contribution),
        marginPct: p1(agg.contribution, agg.revenue), laborPct: p1(agg.labor, agg.revenue), cogsPct: p1(agg.cogs, agg.revenue),
      };

      await blobStore.setJSON('pcg_pnl_live_v1', {
        savedAt: new Date().toISOString(),
        data: { busDt, network: pnlNetwork, stores: pnlStores, excluded: pnlExcluded },
      });
      console.log('[labor-cron] Wrote pcg_pnl_live_v1 —', pnlStores.length, 'stores,', pnlExcluded.length, 'excluded');

      for (const s of pnlStores) {
        const key = `pcg_pnl_store_${s.pc}`;
        let history = { daily: [] };
        try {
          const existing = await blobStore.get(key, { type: 'json' });
          if (existing?.data?.daily) history = existing.data;
        } catch {}
        const point = {
          date: busDt, revenue: s.revenue, labor: s.labor, cogs: s.cogs,
          contribution: s.contribution, marginPct: s.marginPct, laborPct: s.laborPct,
          cogsPct: s.cogsPct, method: s.method,
        };
        history.daily = [...history.daily.filter(d => d.date !== busDt), point]
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(-400);
        await blobStore.setJSON(key, { savedAt: new Date().toISOString(), data: history });
      }
      console.log('[labor-cron] Wrote pcg_pnl_store_{pc} history for', pnlStores.length, 'stores');
    } catch (e) {
      console.warn('[labor-cron] P&L snapshot write skipped:', e.message);
    }

    // ── Close out pending schedule alerts with actual labor data ─────────────
    // For any alert whose date has already passed, look up the actual labor %
    // from the store's daily history and mark it improved / no_change / worsened.
    try {
      const alertsRaw = await blobStore.get('pcg_schedule_alerts_v1', { type: 'json' });
      const alertBlob = alertsRaw?.data ?? alertsRaw;
      const allAlerts = alertBlob?.alerts;
      if (Array.isArray(allAlerts)) {
        // Only process alerts that are pending AND whose date is strictly before today
        const pendingPast = allAlerts.filter(a => a.status === 'pending' && a.date < busDt);
        if (pendingPast.length > 0) {
          // Group by store pc to minimise blob reads
          const byPc = {};
          for (const a of pendingPast) {
            if (!byPc[a.pc]) byPc[a.pc] = [];
            byPc[a.pc].push(a);
          }
          for (const [pc, alerts] of Object.entries(byPc)) {
            try {
              const histRaw = await blobStore.get(`pcg_labor_store_${pc}`, { type: 'json' });
              const hist = histRaw?.data ?? histRaw;
              const daily = Array.isArray(hist?.daily) ? hist.daily : [];
              for (const alert of alerts) {
                const entry = daily.find(d => d.date === alert.date);
                if (!entry) { alert.status = 'no_data'; continue; }
                const actual = entry.laborPct;
                alert.actualPct = actual;
                const diff = actual - alert.projectedPct;
                alert.status = diff <= -2 ? 'improved' : diff >= 2 ? 'worsened' : 'no_change';
              }
            } catch (e) {
              console.warn('[labor-cron] alert resolution error for', pc, e.message);
            }
          }
          // Save updated alerts back
          await blobStore.setJSON('pcg_schedule_alerts_v1', {
            savedAt: new Date().toISOString(),
            data: { ...alertBlob, alerts: allAlerts },
          });
          console.log(`[labor-cron] Resolved ${pendingPast.length} schedule alerts`);
        }
      }
    } catch (e) {
      console.warn('[labor-cron] schedule alert resolution skipped:', e.message);
    }

    const summary = {
      ok: true,
      busDt,
      completedAt: new Date().toISOString(),
      storesProcessed: storeResults.length,
      storesOk: successStores.length,
      storesFailed: storeResults.length - successStores.length,
      network: networkBlob.network,
    };

    console.log('[labor-cron] complete:', JSON.stringify(summary));
    await recordHealth('labor', { ok: true, durationMs: Date.now() - startMs });
    return isManual
      ? new Response(JSON.stringify(summary), { status: 200, headers })
      : undefined;

  } catch (err) {
    console.error('[labor-cron] fatal error:', err);
    await recordHealth('labor', { ok: false, error: err });
    return isManual
      ? new Response(JSON.stringify({ error: err.message }), { status: 500, headers })
      : undefined;
  }
};
