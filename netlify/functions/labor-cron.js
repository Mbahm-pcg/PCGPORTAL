// PCG Portal — Labor Cron (Scheduled Netlify Function)
// Runs every 4 hours. Fetches employee + punch + pay rate data from Paycor,
// cross-references with Pulse POS sales data, computes labor costs and
// percentages, and stores results in Netlify Blobs under 'pcg-labor'.

const https = require('https');
const { getStore } = require('@netlify/blobs');

// ── Store configs (pc = Dunkin store number, paycor = Paycor legal entity ID) ──
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
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timeout')); });
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
}

/** Call the Paycor REST API. Retries once on 401. */
async function callPaycor(path, method = 'GET') {
  const token = await getAccessToken();
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;

  const makeCall = async (tok) => httpsRequest(PAYCOR_API_HOST, `/v1${path}`, method, {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${tok}`,
    'Ocp-Apim-Subscription-Key': subscriptionKey,
  });

  let res = await makeCall(token);
  if (res.status === 401) {
    tokenCache.accessToken = null;
    tokenCache.expiresAt = 0;
    const newToken = await getAccessToken();
    res = await makeCall(newToken);
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

function todayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
}

/** Returns ISO string for the Monday of the current week (Paycor week starts Mon). */
function weekStart(dateStr) {
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

async function fetchLatestBusDt(pc) {
  try {
    const cfg = APIS[apiRoute(pc)];
    const j = await postPOS(cfg, 'getLatestBusDt', { locRef: pc });
    return j.busDt || j.businessDate || null;
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

// ── Labor calculation helpers ─────────────────────────────────────────────────

/**
 * Compute hours worked from punch pairs.
 * Punches come in as { punchIn, punchOut, employeeId, ... }
 * punchIn/punchOut may be ISO strings.
 */
function computeHoursFromPunches(punches) {
  // Group by employeeId
  const byEmp = {};
  for (const p of punches) {
    const id = p.employeeId || p.EmployeeId;
    if (!id) continue;
    if (!byEmp[id]) byEmp[id] = [];
    byEmp[id].push(p);
  }
  const result = {};
  for (const [empId, empPunches] of Object.entries(byEmp)) {
    let totalMs = 0;
    for (const p of empPunches) {
      const inTime  = p.punchIn  || p.clockIn  || p.timeIn  || null;
      const outTime = p.punchOut || p.clockOut || p.timeOut || null;
      if (inTime && outTime) {
        const diff = new Date(outTime) - new Date(inTime);
        if (diff > 0) totalMs += diff;
      }
    }
    result[empId] = totalMs / 3600000; // hours
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

async function processStore(store, busDt) {
  const { pc, paycor: legalEntityId, name, district } = store;
  const weekDates = weekDatesThrough(busDt);
  const weekOfStr  = weekStart(busDt);

  // 1. Fetch POS sales for today
  const sales = await fetchPOSSales(pc, busDt);

  // 2. Fetch employees
  let employees = [];
  try {
    employees = await fetchEmployees(legalEntityId);
    employees = employees.filter(e => e.employeeStatus === 'Active' || e.status === 'Active' || !e.employeeStatus);
  } catch (e) {
    console.warn(`[labor-cron] ${name}: fetchEmployees failed:`, e.message);
  }

  // 3. Fetch pay rates for each employee (throttle to avoid rate limits)
  const payRateMap = {}; // employeeId -> { payType, payRate, annualPay }
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
      }
    }));
  }

  // 4. Fetch punches for the full week
  const punchMap = {}; // date -> { empId -> hoursWorked }
  const weekStart_ = weekDates[0];
  let allPunches = [];
  try {
    allPunches = await fetchPunches(legalEntityId, weekStart_, busDt);
  } catch (e) {
    console.warn(`[labor-cron] ${name}: fetchPunches failed:`, e.message);
  }

  // Group punches by date
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
      // For prior days, priorHours is just the days before that day
      // Approximation: use total prior minus this day's hours for a rough WTD cost
      const dayPrior = priorDates.filter(pd => pd < d).reduce((sum, pd) => sum + (punchMap[pd]?.[id] || 0), 0);
      wtdLaborDollars += computeDailyCost(pr.payType, pr.payRate, pr.annualPay, h, dayPrior);
    }
    // WTD sales: would need per-day POS — skip for now (caller can enrich if needed)
  }

  const laborPctToday = sales.netSales > 0 ? (totalLaborDollarsToday / sales.netSales) * 100 : 0;
  const wtdLaborPct   = wtdSales > 0 ? (wtdLaborDollars / wtdSales) * 100 : 0;

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
      overtimeCount:    otCount,
    },
    wtd: {
      laborDollars: Math.round(wtdLaborDollars * 100) / 100,
      sales:        Math.round(wtdSales * 100) / 100,
      laborPct:     Math.round(wtdLaborPct * 10) / 10,
    },
    employeeDetails,
  };
}

// ── Batch-process all stores ──────────────────────────────────────────────────

async function processAllStores(busDt, batchSize = 8) {
  const results = [];
  for (let i = 0; i < STORES.length; i += batchSize) {
    const batch = STORES.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (store) => {
        try {
          return await processStore(store, busDt);
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
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return results;
}

// ── Blob helpers ──────────────────────────────────────────────────────────────

function getLaborStore() {
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
function mergeStoreBlob(existing, todayEntry, weeklyEntry) {
  const MAX_DAILY  = 30;
  const MAX_WEEKLY = 13;

  const daily = Array.isArray(existing?.daily) ? [...existing.daily] : [];
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

  const weekly = Array.isArray(existing?.weekly) ? [...existing.weekly] : [];
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

// ── Main handler ──────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const isManual = event.httpMethod === 'POST';
  const startedAt = new Date().toISOString();
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

    // Process all stores in batches of 8
    const storeResults = await processAllStores(busDt, 8);

    // Build network summary
    const successStores = storeResults.filter(r => !r.error);
    const networkLaborDollars   = successStores.reduce((s, r) => s + r.today.laborDollars, 0);
    const networkSales          = successStores.reduce((s, r) => s + r.today.sales, 0);
    const networkLaborPct       = networkSales > 0 ? (networkLaborDollars / networkSales) * 100 : 0;
    const networkTotalEmployees = successStores.reduce((s, r) => s + r.today.employees, 0);
    const networkOnClock        = successStores.reduce((s, r) => s + r.today.employeesOnClock, 0);
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
        overtimeCount:     networkOTCount,
      },
      stores: storesSummary,
    };

    // Persist to Blobs
    const blobStore = getLaborStore();

    // 1) Network summary blob
    await blobStore.setJSON('pcg_labor_v1', { savedAt: new Date().toISOString(), data: networkBlob });
    console.log('[labor-cron] Wrote pcg_labor_v1');

    // 2) Per-store blobs (in batches of 8)
    const weekOfStr = weekStart(busDt);
    for (let i = 0; i < storeResults.length; i += 8) {
      const batch = storeResults.slice(i, i + 8);
      await Promise.all(batch.map(async (r) => {
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
      }));
    }
    console.log('[labor-cron] Wrote per-store blobs for', storeResults.length, 'stores');

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
    return isManual
      ? { statusCode: 200, headers, body: JSON.stringify(summary) }
      : undefined;

  } catch (err) {
    console.error('[labor-cron] fatal error:', err);
    return isManual
      ? { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) }
      : undefined;
  }
};
