# Labor Section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Labor tab in the PCG Portal that cross-references Paycor payroll/timecard data with Pulse POS sales to show labor $, labor %, and overtime alerts across all 45 stores.

**Architecture:** Hybrid cron + live. A scheduled `labor-cron.js` function pre-computes network-wide labor summaries every 4 hours (stored in Netlify Blobs). The UI reads cached data for the dashboard and fetches live from Paycor for single-store drill-downs. Two new actions (`punches`, `schedules`) are added to the existing `paycor.js` proxy.

**Tech Stack:** React 18 (CDN, no build step), Netlify Functions (Node.js), Netlify Blobs, Paycor Public API v1, Dunkin POS API (via existing Pulse proxy)

**Spec:** `docs/superpowers/specs/2026-04-12-labor-section-design.md`

**Version bump:** Increment version in sidebar footer (currently v4.61) after each task that modifies `index.html`.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `netlify/functions/paycor.js` | Modify | Add `punches` and `schedules` actions |
| `netlify/functions/labor-cron.js` | Create | Scheduled function: fetch Paycor + Pulse data, compute labor summaries, store in Blobs |
| `netlify.toml` | Modify | Add schedule for `labor-cron` |
| `index.html` | Modify | Add Labor tab to nav, `AdminLabor` component (dashboard + drill-down), role access |

---

### Task 1: Add `punches` and `schedules` actions to paycor.js

**Files:**
- Modify: `netlify/functions/paycor.js:275` (before the `raw` action)

- [ ] **Step 1: Add the `punches` action**

Insert before the `// ── Proxy: generic API call` comment block at line 275:

```javascript
    // ── Proxy: employee/location punches (time clock data) ──
    if (action === 'punches') {
      const { legalEntityId, employeeId, startDate, endDate } = payload;
      if (employeeId) {
        let path = `/employees/${employeeId}/punches`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      if (legalEntityId) {
        let path = `/legalentities/${legalEntityId}/punches`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId or legalEntityId' }) };
    }

    // ── Proxy: employee/location schedules ──
    if (action === 'schedules') {
      const { legalEntityId, employeeId, startDate, endDate } = payload;
      if (employeeId) {
        let path = `/employees/${employeeId}/schedules`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      if (legalEntityId) {
        let path = `/legalentities/${legalEntityId}/schedules`;
        const params = [];
        if (startDate) params.push(`startDate=${startDate}`);
        if (endDate) params.push(`endDate=${endDate}`);
        if (params.length) path += '?' + params.join('&');
        const res = await callPaycor(path);
        return { statusCode: res.status, headers, body: JSON.stringify(res.data) };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing employeeId or legalEntityId' }) };
    }
```

- [ ] **Step 2: Verify the function still parses correctly**

Run: `node -c "netlify/functions/paycor.js"`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/paycor.js
git commit -m "feat: add punches and schedules actions to paycor proxy"
```

---

### Task 2: Create labor-cron.js — Scheduled function

**Files:**
- Create: `netlify/functions/labor-cron.js`

This function runs every 4 hours. It fetches all 45 stores' employee data from Paycor and sales data from Pulse, computes labor summaries, and stores results in Netlify Blobs.

- [ ] **Step 1: Create the labor-cron function**

```javascript
// PCG Portal — Scheduled Labor Summary Cron
// Runs every 4 hours. Fetches Paycor employee + punch + pay rate data,
// cross-references with Pulse POS sales, computes labor $ / labor % / OT.
// Stores results in Netlify Blobs for instant dashboard loads.

const https = require('https');
const { getStore } = require('@netlify/blobs');

// ── Store configs (pc → paycor legal entity mapping) ─────────────────────────
const STORES = [
  { pc:"339616", paycor:"193919", name:"Wadsworth", district:1 },
  { pc:"340794", paycor:"193904", name:"Front", district:1 },
  { pc:"351099", paycor:"193900", name:"Sonic", district:2 },
  { pc:"351259", paycor:"193892", name:"Rosemore", district:2 },
  { pc:"302642", paycor:"193914", name:"County Line", district:2 },
  { pc:"352894", paycor:"193890", name:"Street Rd", district:2 },
  { pc:"341350", paycor:"193920", name:"Yardley", district:2 },
  { pc:"337839", paycor:"193888", name:"Warrington", district:2 },
  { pc:"330338", paycor:"193887", name:"Drexel Hill", district:3 },
  { pc:"337063", paycor:"193886", name:"Sharon Hill", district:3 },
  { pc:"343832", paycor:"193885", name:"Lansdowne", district:3 },
  { pc:"304669", paycor:"193884", name:"Collingdale", district:3 },
  { pc:"355146", paycor:"193883", name:"Gallery", district:3 },
  { pc:"300496", paycor:"193882", name:"Cobbs Creek", district:3 },
  { pc:"304863", paycor:"193881", name:"18th St", district:3 },
  { pc:"354561", paycor:"193880", name:"Carlisle", district:3 },
  { pc:"332393", paycor:"193879", name:"Lindbergh", district:3 },
  { pc:"341167", paycor:"193916", name:"5th Street", district:4 },
  { pc:"340870", paycor:"193915", name:"Hunting Park", district:4 },
  { pc:"335981", paycor:"193913", name:"Lehigh", district:4 },
  { pc:"353150", paycor:"193912", name:"Bakers Square", district:4 },
  { pc:"351050", paycor:"193911", name:"Allegheny", district:4 },
  { pc:"345985", paycor:"193910", name:"Wissahickon", district:4 },
  { pc:"356374", paycor:"193909", name:"Montgomeryville", district:5 },
  { pc:"353843", paycor:"193908", name:"Tollgate", district:5 },
  { pc:"353047", paycor:"193907", name:"Silverdale", district:5 },
  { pc:"340538", paycor:"193906", name:"Easton", district:5 },
  { pc:"343079", paycor:"193905", name:"Downingtown", district:6 },
  { pc:"342144", paycor:"193903", name:"Westchester", district:6 },
  { pc:"364295", paycor:"193902", name:"Lionville", district:6 },
  { pc:"365361", paycor:"193901", name:"Little Welsh", district:7 },
  { pc:"310382", paycor:"193899", name:"Grant", district:7 },
  { pc:"332941", paycor:"193898", name:"Bustleton", district:7 },
  { pc:"343497", paycor:"193897", name:"Red Lion", district:7 },
  { pc:"302446", paycor:"193896", name:"Little Red Lion", district:7 },
  { pc:"337079", paycor:"193895", name:"Holme Circle", district:7 },
  { pc:"345986", paycor:"193894", name:"Willits", district:7 },
  { pc:"364412", paycor:"193893", name:"8200", district:7 },
  { pc:"345489", paycor:"193891", name:"Oxford", district:7 },
  { pc:"336372", paycor:"193889", name:"Elkins Park", district:7 },
  { pc:"358933", paycor:"193918", name:"Brace Rd", district:8 },
  { pc:"354865", paycor:"193917", name:"Quakertown", district:8 },
  { pc:"353689", paycor:"193878", name:"Fort Washington", district:8 },
  { pc:"342184", paycor:"193877", name:"Lansdale", district:8 },
  { pc:"356316", paycor:"193876", name:"BJ's", district:8 },
];

// Pulse POS API config (same as pulse-notify.js)
const PULSE_APIS = {
  p227: { host:'pos-ra.dunkindonuts.com', path:'/p227', xkey:'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL', apikey:'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
  p228: { host:'pos-ra.dunkindonuts.com', path:'/p228', xkey:'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP', apikey:'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=' },
};
const STORE_P227 = '345986';
function pulseApiRoute(pc) { return pc === STORE_P227 ? 'p227' : 'p228'; }

// ── Paycor OAuth (same pattern as paycor.js) ─────────────────────────────────
const PAYCOR_HOST = 'apis.paycor.com';
let tokenCache = { accessToken: null, refreshToken: process.env.PAYCOR_REFRESH_TOKEN || null, expiresAt: 0 };

function httpsReq(hostname, path, method, hdrs, body) {
  return new Promise((resolve, reject) => {
    const data = body || null;
    const isForm = typeof data === 'string';
    const options = { hostname, port: 443, path, method, headers: { ...hdrs, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch { resolve({ status: res.statusCode, data: raw }); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Paycor request timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function getPaycorToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.accessToken;
  const clientId = process.env.PAYCOR_CLIENT_ID;
  const clientSecret = process.env.PAYCOR_CLIENT_SECRET;
  const subscriptionKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  if (!clientId || !clientSecret || !subscriptionKey || !tokenCache.refreshToken) throw new Error('Missing Paycor credentials');
  const formBody = `grant_type=refresh_token&refresh_token=${encodeURIComponent(tokenCache.refreshToken)}&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const res = await httpsReq(PAYCOR_HOST, `/sts/v1/common/token?subscription-key=${subscriptionKey}`, 'POST', { 'Content-Type': 'application/x-www-form-urlencoded' }, formBody);
  if (res.status === 200 && res.data.access_token) {
    tokenCache = { accessToken: res.data.access_token, refreshToken: res.data.refresh_token || tokenCache.refreshToken, expiresAt: Date.now() + (res.data.expires_in || 3600) * 1000 };
    return tokenCache.accessToken;
  }
  throw new Error(`Paycor token refresh failed: ${res.status}`);
}

async function callPaycor(path) {
  const token = await getPaycorToken();
  const subKey = process.env.PAYCOR_SUBSCRIPTION_KEY;
  const res = await httpsReq(PAYCOR_HOST, `/v1${path}`, 'GET', { Authorization: `Bearer ${token}`, 'Ocp-Apim-Subscription-Key': subKey, 'Content-Type': 'application/json' });
  if (res.status === 401) {
    tokenCache.accessToken = null; tokenCache.expiresAt = 0;
    const newToken = await getPaycorToken();
    return httpsReq(PAYCOR_HOST, `/v1${path}`, 'GET', { Authorization: `Bearer ${newToken}`, 'Ocp-Apim-Subscription-Key': subKey, 'Content-Type': 'application/json' });
  }
  return res;
}

// ── Pulse POS fetching ────────────────────────────────���──────────────────────
function postPulse(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = { hostname: cfg.host, port: 443, path: `${cfg.path}/${endpoint}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.xkey, 'Api-Key': cfg.apikey, 'Content-Length': Buffer.byteLength(data) } };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(15000, () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

function sumRVC(revenueCenters = []) {
  return revenueCenters.reduce((a, r) => ({ netSales: a.netSales + (r.netSlsTtl || 0), guests: a.guests + (r.chkCnt || 0) }), { netSales: 0, guests: 0 });
}

// ── Date helpers ─────────────────────────────────────────────────────────────
function todayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth()+1).padStart(2,'0')}-${String(et.getDate()).padStart(2,'0')}`;
}

function weekStartET(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - d.getDay()); // Sunday
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function getWeekDates(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
  const today = todayET();
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dd = new Date(sun); dd.setDate(sun.getDate() + i);
    const ds = `${dd.getFullYear()}-${String(dd.getMonth()+1).padStart(2,'0')}-${String(dd.getDate()).padStart(2,'0')}`;
    if (ds <= today) dates.push(ds);
  }
  return dates;
}

// ── Core: compute labor for one store ───────────────────────────────────��────
async function computeStoreLabor(store, today) {
  const { pc, paycor: legalEntityId, name, district } = store;

  // 1. Fetch employees from Paycor
  let employees = [];
  try {
    const empRes = await callPaycor(`/legalentities/${legalEntityId}/employees?include=All`);
    employees = empRes.data?.records || empRes.data || [];
  } catch (e) {
    console.warn(`[labor-cron] Failed to fetch employees for ${name} (${pc}):`, e.message);
    return null;
  }

  // 2. Fetch pay rates for each employee (batch to limit concurrency)
  const employeeDetails = [];
  for (let i = 0; i < employees.length; i += 10) {
    const batch = employees.slice(i, i + 10);
    const results = await Promise.all(batch.map(async (emp) => {
      try {
        const rateRes = await callPaycor(`/employees/${emp.id}/payrates`);
        const rates = rateRes.data?.records || rateRes.data || [];
        const primary = rates[0] || {};
        return {
          employeeId: emp.id,
          name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim(),
          role: emp.jobTitle || '',
          status: emp.status || '',
          payType: primary.payType || primary.type || 'Hourly',
          payRate: primary.payRate || primary.rate || 0,
          annualPay: primary.annualPayRate || 0,
        };
      } catch {
        return { employeeId: emp.id, name: `${emp.firstName || ''} ${emp.lastName || ''}`.trim(), role: emp.jobTitle || '', status: emp.status || '', payType: 'Hourly', payRate: 0, annualPay: 0 };
      }
    }));
    employeeDetails.push(...results);
  }

  // Filter to active employees only
  const active = employeeDetails.filter(e => !e.status || e.status === 'Active');

  // 3. Fetch today's punches from Paycor
  let punches = [];
  try {
    const punchRes = await callPaycor(`/legalentities/${legalEntityId}/punches?startDate=${today}&endDate=${today}`);
    punches = punchRes.data?.records || punchRes.data || [];
  } catch (e) {
    console.warn(`[labor-cron] Failed to fetch punches for ${name}:`, e.message);
  }

  // 4. Fetch week's punches for OT calculation
  const weekDates = getWeekDates(today);
  const weekStart = weekDates[0];
  let weekPunches = [];
  try {
    const wpRes = await callPaycor(`/legalentities/${legalEntityId}/punches?startDate=${weekStart}&endDate=${today}`);
    weekPunches = wpRes.data?.records || wpRes.data || [];
  } catch {
    weekPunches = punches; // fallback to today only
  }

  // 5. Compute hours per employee today and this week
  function punchHours(punchList, empId) {
    const empPunches = punchList.filter(p => (p.employeeId || p.EmployeeId) === empId);
    let total = 0;
    // Pair clock-in/clock-out punches
    const sorted = empPunches.sort((a, b) => new Date(a.punchDateTime || a.PunchDateTime) - new Date(b.punchDateTime || b.PunchDateTime));
    for (let i = 0; i < sorted.length - 1; i += 2) {
      const inTime = new Date(sorted[i].punchDateTime || sorted[i].PunchDateTime);
      const outTime = new Date(sorted[i+1].punchDateTime || sorted[i+1].PunchDateTime);
      if (outTime > inTime) total += (outTime - inTime) / 3600000;
    }
    return Math.round(total * 100) / 100;
  }

  // 6. Build per-employee labor data
  let totalLaborDollars = 0;
  let totalHours = 0;
  let employeesOnClock = 0;
  let overtimeCount = 0;
  const employeeLabor = active.map(emp => {
    const hoursToday = punchHours(punches, emp.employeeId);
    const hoursThisWeek = punchHours(weekPunches, emp.employeeId);
    let costToday = 0;
    let overtime = false;

    if (emp.payType === 'Salary' || emp.payType === 'salary') {
      // Salaried: bi-weekly pay / 12 days (6 days/week x 2 weeks)
      costToday = emp.payRate / 12;
    } else {
      // Hourly: regular hours at rate, OT hours at 1.5x
      const regularHoursWeek = Math.min(hoursThisWeek, 40);
      const otHoursWeek = Math.max(hoursThisWeek - 40, 0);
      // Determine how much of today's hours are OT
      const priorHours = hoursThisWeek - hoursToday;
      const regularToday = Math.max(Math.min(hoursToday, 40 - priorHours), 0);
      const otToday = Math.max(hoursToday - regularToday, 0);
      costToday = (regularToday * emp.payRate) + (otToday * emp.payRate * 1.5);
      overtime = hoursThisWeek >= 40;
    }

    if (overtime) overtimeCount++;

    // Check if currently on clock (has odd number of punches today = clocked in)
    const todayPunches = punches.filter(p => (p.employeeId || p.EmployeeId) === emp.employeeId);
    const isOnClock = todayPunches.length % 2 === 1;
    if (isOnClock) employeesOnClock++;

    totalLaborDollars += costToday;
    totalHours += hoursToday;

    return {
      employeeId: emp.employeeId,
      name: emp.name,
      role: emp.role,
      payType: emp.payType,
      payRate: emp.payRate,
      hoursToday: hoursToday,
      hoursThisWeek: hoursThisWeek,
      costToday: Math.round(costToday * 100) / 100,
      overtime,
      approachingOT: !overtime && hoursThisWeek >= 35,
      isOnClock,
    };
  });

  // 7. Fetch today's sales from Pulse POS
  let sales = 0;
  try {
    const cfg = PULSE_APIS[pulseApiRoute(pc)];
    const posData = await postPulse(cfg, 'getOperationsDailyTotals', { locRef: pc, busDt: today, include: 'locRef,busDt,revenueCenters' });
    if (posData && posData.revenueCenters) {
      const s = sumRVC(posData.revenueCenters);
      sales = s.netSales;
    }
  } catch {
    console.warn(`[labor-cron] Failed to fetch Pulse sales for ${name}`);
  }

  totalLaborDollars = Math.round(totalLaborDollars * 100) / 100;
  const laborPct = sales > 0 ? Math.round((totalLaborDollars / sales) * 1000) / 10 : 0;

  return {
    pc, name, district,
    today: {
      laborDollars: totalLaborDollars,
      sales: Math.round(sales * 100) / 100,
      laborPct,
      employees: active.length,
      employeesOnClock,
      hoursWorked: Math.round(totalHours * 100) / 100,
      overtimeCount,
    },
    employeeLabor,
  };
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // Support both scheduled invocation and manual trigger via POST
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };

  const today = todayET();
  const weekStart = weekStartET(today);
  console.log(`[labor-cron] Starting labor summary for ${today}`);

  const blob = getStore('pcg-labor');
  const BATCH_SIZE = 8;
  const storeResults = {};
  let networkLabor = 0, networkSales = 0, networkEmployees = 0, networkOnClock = 0, networkOT = 0;

  // Process stores in batches
  for (let i = 0; i < STORES.length; i += BATCH_SIZE) {
    const batch = STORES.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(store => computeStoreLabor(store, today)));
    for (const result of results) {
      if (!result) continue;
      storeResults[result.pc] = {
        name: result.name,
        district: result.district,
        today: result.today,
      };
      networkLabor += result.today.laborDollars;
      networkSales += result.today.sales;
      networkEmployees += result.today.employees;
      networkOnClock += result.today.employeesOnClock;
      networkOT += result.today.overtimeCount;

      // Save per-store detail blob with employee data
      try {
        const storeKey = `pcg_labor_store_${result.pc}`;
        let existing = {};
        try { existing = JSON.parse(await blob.get(storeKey) || '{}'); } catch {}
        // Append today's data to daily array (keep last 60 days)
        const daily = existing.daily || [];
        const todayIdx = daily.findIndex(d => d.date === today);
        const todayRecord = {
          date: today,
          laborDollars: result.today.laborDollars,
          sales: result.today.sales,
          laborPct: result.today.laborPct,
          hoursWorked: result.today.hoursWorked,
          employees: result.employeeLabor,
        };
        if (todayIdx >= 0) daily[todayIdx] = todayRecord;
        else daily.push(todayRecord);
        // Keep last 60 days
        while (daily.length > 60) daily.shift();

        // Compute weekly rollups
        const weeklyMap = {};
        for (const d of daily) {
          const ws = weekStartET(d.date);
          if (!weeklyMap[ws]) weeklyMap[ws] = { weekOf: ws, laborDollars: 0, sales: 0, hoursWorked: 0, days: 0, totalEmployees: 0 };
          weeklyMap[ws].laborDollars += d.laborDollars;
          weeklyMap[ws].sales += d.sales;
          weeklyMap[ws].hoursWorked += d.hoursWorked;
          weeklyMap[ws].days++;
          weeklyMap[ws].totalEmployees += (d.employees?.length || 0);
        }
        const weekly = Object.values(weeklyMap).sort((a, b) => b.weekOf.localeCompare(a.weekOf)).slice(0, 8).map(w => ({
          weekOf: w.weekOf,
          laborDollars: Math.round(w.laborDollars * 100) / 100,
          sales: Math.round(w.sales * 100) / 100,
          laborPct: w.sales > 0 ? Math.round((w.laborDollars / w.sales) * 1000) / 10 : 0,
          avgDailyEmployees: w.days > 0 ? Math.round(w.totalEmployees / w.days) : 0,
        }));

        await blob.set(storeKey, JSON.stringify({ lastUpdated: new Date().toISOString(), daily, weekly }));
      } catch (e) {
        console.warn(`[labor-cron] Failed to save store detail for ${result.pc}:`, e.message);
      }
    }
  }

  // Compute WTD rollups for the network summary
  // Pull WTD from each store's detail blob
  const storesWithWTD = {};
  for (const store of STORES) {
    try {
      const storeKey = `pcg_labor_store_${store.pc}`;
      const raw = await blob.get(storeKey);
      if (!raw) continue;
      const detail = JSON.parse(raw);
      const weekDates = getWeekDates(today);
      let wtdLabor = 0, wtdSales = 0;
      for (const d of (detail.daily || [])) {
        if (weekDates.includes(d.date)) {
          wtdLabor += d.laborDollars;
          wtdSales += d.sales;
        }
      }
      storesWithWTD[store.pc] = {
        ...storeResults[store.pc],
        wtd: {
          laborDollars: Math.round(wtdLabor * 100) / 100,
          sales: Math.round(wtdSales * 100) / 100,
          laborPct: wtdSales > 0 ? Math.round((wtdLabor / wtdSales) * 1000) / 10 : 0,
        },
      };
    } catch {
      storesWithWTD[store.pc] = storeResults[store.pc] || null;
    }
  }

  // Save network summary
  const summary = {
    lastUpdated: new Date().toISOString(),
    network: {
      laborDollars: Math.round(networkLabor * 100) / 100,
      sales: Math.round(networkSales * 100) / 100,
      laborPct: networkSales > 0 ? Math.round((networkLabor / networkSales) * 1000) / 10 : 0,
      totalEmployees: networkEmployees,
      employeesOnClock: networkOnClock,
      overtimeCount: networkOT,
    },
    stores: storesWithWTD,
  };

  await blob.set('pcg_labor_v1', JSON.stringify(summary));
  console.log(`[labor-cron] Done. ${Object.keys(storeResults).length} stores processed. Labor: $${summary.network.laborDollars}, Sales: $${summary.network.sales}, Pct: ${summary.network.laborPct}%`);

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, storesProcessed: Object.keys(storeResults).length, network: summary.network }) };
};
```

- [ ] **Step 2: Verify syntax**

Run: `node -c "netlify/functions/labor-cron.js"`
Expected: no syntax errors

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/labor-cron.js
git commit -m "feat: add labor-cron scheduled function for Paycor + Pulse labor summaries"
```

---

### Task 3: Add labor-cron schedule to netlify.toml

**Files:**
- Modify: `netlify.toml`

- [ ] **Step 1: Add the scheduled function config**

After the existing `[functions.pulse-cron]` block, add:

```toml
# Scheduled Labor summary — every 4 hours (6a, 10a, 2p, 6p, 10p, 2a ET)
[functions.labor-cron]
  schedule = "0 2,6,10,14,18,22 * * *"
```

Note: These are UTC hours. 2,6,10,14,18,22 UTC = 10p,2a,6a,10a,2p,6p ET (during EDT).

- [ ] **Step 2: Commit**

```bash
git add netlify.toml
git commit -m "feat: schedule labor-cron to run every 4 hours"
```

---

### Task 4: Add Labor tab to sidebar navigation

**Files:**
- Modify: `index.html:10218-10244` (getTabs function)
- Modify: `index.html:15212` (version bump)

- [ ] **Step 1: Add the "labor" icon to ICONS**

Find the ICONS object (line 142). After the existing `dollar` entry, add a `labor` icon. We'll use a clock+dollar combo. Actually, reuse the existing `dollar` icon for now since it's already defined and semantically fits.

- [ ] **Step 2: Add the Labor tab to Executive/IT role**

In the `getTabs` function at line 10218, add the labor tab after the pulse entry. The executive/IT block currently looks like:

```javascript
  if (ut === "executive" || ut === "it") return [
    ...BASE_TABS,
    { id: "locations", label: "Locations", icon: (c) => ICONS.locations(c) },
    { id: "analytics", label: "Analytics", icon: (c) => ICONS.analytics(c) },
    { id: "pulse",     label: "Pulse",     icon: (c) => ICONS.pulse(c), green: true },
    { id: "cash",      label: "Cash Management", icon: (c) => ICONS.dollar(c), cash: true },
    { id: "projects",  label: "Projects",  icon: (c) => ICONS.projects(c) },
    { id: "users",     label: "Users",     icon: (c) => ICONS.users(c) },
    { id: "settings",  label: "Settings",  icon: (c) => ICONS.settings(c) },
  ];
```

Change it to:

```javascript
  if (ut === "executive" || ut === "it") return [
    ...BASE_TABS,
    { id: "locations", label: "Locations", icon: (c) => ICONS.locations(c) },
    { id: "analytics", label: "Analytics", icon: (c) => ICONS.analytics(c) },
    { id: "pulse",     label: "Pulse",     icon: (c) => ICONS.pulse(c), green: true },
    { id: "labor",     label: "Labor",     icon: (c) => ICONS.dollar(c) },
    { id: "cash",      label: "Cash Management", icon: (c) => ICONS.dollar(c), cash: true },
    { id: "projects",  label: "Projects",  icon: (c) => ICONS.projects(c) },
    { id: "users",     label: "Users",     icon: (c) => ICONS.users(c) },
    { id: "settings",  label: "Settings",  icon: (c) => ICONS.settings(c) },
  ];
```

- [ ] **Step 3: Add the Labor tab to Office Staff role**

Same change at line 10229. Add `{ id: "labor", label: "Labor", icon: (c) => ICONS.dollar(c) },` after the pulse entry.

- [ ] **Step 4: Add the Labor tab to District Manager role**

At line 10239, add `{ id: "labor", label: "Labor", icon: (c) => ICONS.dollar(c) },` after the analytics entry.

- [ ] **Step 5: Add the routing line in PCGPortal**

At line 15508 (after the pulse routing line), add:

```javascript
          {tab === "labor" && (isFullAdmin(user) || isOfficeStaff || isDM) && <AdminLabor stores={stores} districts={districts} th={th} user={user} />}
```

- [ ] **Step 6: Bump version**

At line 15212, change `v4.61` to `v4.62`.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: add Labor tab to sidebar nav for exec/IT/office/DM roles"
```

---

### Task 5: Build AdminLabor component — Dashboard Landing

**Files:**
- Modify: `index.html` (insert new component before the PCGPortal component)

Insert the `AdminLabor` component before the `PCGPortal` function definition. This is the dashboard landing with summary bar + store grid.

- [ ] **Step 1: Add the AdminLabor component skeleton with data fetching**

Insert before the `function PCGPortal(` line (find it by searching for `function PCGPortal`). The component:

```javascript
// ── Labor Section ────────────────────────────────────────────────────────────
const LABOR_GREEN = 22.9, LABOR_YELLOW = 25.9;
function laborColor(pct) { return pct <= LABOR_GREEN ? '#4caf50' : pct <= LABOR_YELLOW ? '#ff9800' : '#f44336'; }
function laborLabel(pct) { return pct <= LABOR_GREEN ? 'On Target' : pct <= LABOR_YELLOW ? 'Watch' : 'Over Budget'; }
function fmtDollars(n) { return '$' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 }); }
function fmtPct(n) { return (n || 0).toFixed(1) + '%'; }
function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function AdminLabor({ stores, districts, th, user }) {
  const [laborData, setLaborData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedStore, setSelectedStore] = useState(null);
  const [timeFilter, setTimeFilter] = useState('today');
  const [districtFilter, setDistrictFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false);

  const isDM = user?.userType === 'dm';

  // Lock district filter for DMs
  useEffect(() => {
    if (isDM && user.district) setDistrictFilter(String(user.district));
  }, [isDM, user]);

  // Fetch cached labor data from Blobs
  const fetchLaborData = useCallback(async () => {
    try {
      const data = await cloudLoad('pcg_labor_v1');
      if (data) {
        setLaborData(typeof data === 'string' ? JSON.parse(data) : data);
        setError(null);
      } else {
        setError('No labor data available yet. The cron job may not have run.');
      }
    } catch (e) {
      setError('Failed to load labor data');
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchLaborData(); }, [fetchLaborData]);

  // Manual refresh — triggers the cron function on-demand
  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/.netlify/functions/labor-cron', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: true }),
      });
      if (res.ok) {
        await fetchLaborData();
      }
    } catch {}
    setRefreshing(false);
  };

  // If a store is selected, show drill-down
  if (selectedStore) {
    return <LaborDrillDown
      store={selectedStore}
      stores={stores}
      th={th}
      user={user}
      onBack={() => setSelectedStore(null)}
    />;
  }

  if (loading) return <div style={{ padding: '2rem', textAlign: 'center', color: th.muted }}>Loading labor data...</div>;

  // Filter stores by district
  const storeEntries = laborData?.stores ? Object.entries(laborData.stores) : [];
  const filtered = districtFilter === 'all'
    ? storeEntries
    : storeEntries.filter(([pc, s]) => s && String(s.district) === districtFilter);

  // Sort by labor % descending (worst first)
  filtered.sort((a, b) => (b[1]?.today?.laborPct || 0) - (a[1]?.today?.laborPct || 0));

  // Compute summary for filtered stores
  const summary = filtered.reduce((acc, [pc, s]) => {
    const t = timeFilter === 'today' ? s?.today : s?.wtd;
    if (!t) return acc;
    acc.laborDollars += t.laborDollars || 0;
    acc.sales += t.sales || 0;
    acc.employees += (t.employees || 0);
    acc.employeesOnClock += (t.employeesOnClock || 0);
    acc.overtimeCount += (t.overtimeCount || 0);
    return acc;
  }, { laborDollars: 0, sales: 0, employees: 0, employeesOnClock: 0, overtimeCount: 0 });
  summary.laborPct = summary.sales > 0 ? Math.round((summary.laborDollars / summary.sales) * 1000) / 10 : 0;

  const kpiCards = [
    { label: 'Total Labor', value: fmtDollars(summary.laborDollars), color: laborColor(summary.laborPct) },
    { label: 'Avg Labor %', value: fmtPct(summary.laborPct), color: laborColor(summary.laborPct) },
    { label: 'Total Sales', value: fmtDollars(summary.sales), color: '#FF671F' },
    { label: 'On Clock', value: String(summary.employeesOnClock || summary.employees), color: '#FF671F' },
  ];

  return (
    <div>
      {/* Error banner */}
      {error && <div style={{ background: '#ff980020', border: '1px solid #ff9800', borderRadius: '0.5rem', padding: '0.75rem 1rem', marginBottom: '1rem', color: '#ff9800', fontSize: '0.875rem' }}>
        {error}
      </div>}

      {/* Last updated + refresh */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
        <h2 style={{ margin: 0, fontFamily: "'Raleway'", fontWeight: 700, color: th.text }}>Labor</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <span style={{ fontSize: '0.75rem', color: th.muted }}>Updated {timeAgo(laborData?.lastUpdated)}</span>
          <button onClick={handleRefresh} disabled={refreshing} style={{ ...btn(th, { padding: '0.4rem 0.8rem', fontSize: '0.75rem', opacity: refreshing ? 0.5 : 1 }) }}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* KPI Summary Bar */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
        {kpiCards.map((k, i) => (
          <div key={i} style={{ ...card(th), padding: '1rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.6875rem', color: th.muted, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.5 }}>{k.label}</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 700, color: k.color, marginTop: '0.25rem', fontFamily: "'Source Sans 3'" }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filter Row */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'center' }}>
        {/* Time toggle */}
        <div style={{ display: 'flex', borderRadius: '0.5rem', overflow: 'hidden', border: `1px solid ${th.cardBorder}` }}>
          {['today', 'wtd'].map(t => (
            <button key={t} onClick={() => setTimeFilter(t)} style={{
              background: timeFilter === t ? '#FF671F' : th.card,
              color: timeFilter === t ? '#fff' : th.text,
              border: 'none', padding: '0.4rem 1rem', cursor: 'pointer',
              fontSize: '0.8125rem', fontWeight: 600, fontFamily: "'Source Sans 3'",
            }}>
              {t === 'today' ? 'Today' : 'This Week'}
            </button>
          ))}
        </div>
        {/* District filter (hidden/locked for DMs) */}
        {!isDM && (
          <select value={districtFilter} onChange={e => setDistrictFilter(e.target.value)} style={{ ...inp(th, { width: 'auto', padding: '0.4rem 0.75rem', fontSize: '0.8125rem' }) }}>
            <option value="all">All Districts</option>
            {[1,2,3,4,5,6,7,8].map(d => <option key={d} value={String(d)}>District {d}</option>)}
          </select>
        )}
        {summary.overtimeCount > 0 && (
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#f44336', padding: '0.3rem 0.6rem', background: '#f4433615', borderRadius: '0.4rem' }}>
            {summary.overtimeCount} OT
          </span>
        )}
      </div>

      {/* Store Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
        {filtered.map(([pc, s]) => {
          const t = timeFilter === 'today' ? s?.today : s?.wtd;
          if (!t) return null;
          const pct = t.laborPct || 0;
          const clr = laborColor(pct);
          return (
            <div key={pc} onClick={() => {
              const storeObj = stores.find(st => st.pc === pc);
              setSelectedStore({ ...s, pc, paycor: storeObj?.paycor });
            }} style={{
              ...card(th),
              padding: '1rem',
              borderLeft: `3px solid ${clr}`,
              cursor: 'pointer',
              transition: 'transform .15s, box-shadow .15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 4px 12px #0003'; }}
            onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span style={{ fontWeight: 700, fontSize: '0.875rem', color: th.text }}>{s.name}</span>
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  {(t.overtimeCount || 0) > 0 && <span style={{ fontSize: '0.625rem', fontWeight: 700, color: '#f44336', background: '#f4433615', padding: '0.15rem 0.4rem', borderRadius: '0.3rem' }}>{t.overtimeCount} OT</span>}
                  <span style={{ fontSize: '0.6875rem', color: th.muted }}>D{s.district}</span>
                </div>
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: th.text, marginBottom: '0.25rem' }}>{fmtDollars(t.laborDollars)}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
                <span style={{ color: clr, fontWeight: 600 }}>{fmtPct(pct)}</span>
                <span style={{ color: th.muted }}>{fmtDollars(t.sales)} sales</span>
              </div>
              {timeFilter === 'today' && t.employees !== undefined && (
                <div style={{ fontSize: '0.6875rem', color: th.muted, marginTop: '0.35rem' }}>
                  {t.employeesOnClock || 0} on clock / {t.employees} total
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Bump version to v4.63**

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add AdminLabor dashboard component with summary bar and store grid"
```

---

### Task 6: Build LaborDrillDown component — Store detail view

**Files:**
- Modify: `index.html` (insert LaborDrillDown component right before AdminLabor)

This component handles the hourly/daily/weekly drill-down for a single store, including the employee panel.

- [ ] **Step 1: Add the LaborDrillDown component**

Insert just before the `AdminLabor` function definition:

```javascript
function LaborDrillDown({ store, stores, th, user, onBack }) {
  const [tab, setTab] = useState('hourly');
  const [liveData, setLiveData] = useState(null);
  const [storeHistory, setStoreHistory] = useState(null);
  const [loading, setLoading] = useState(true);
  const [employeesExpanded, setEmployeesExpanded] = useState(false);

  const storeObj = stores.find(s => s.pc === store.pc);
  const paycorId = store.paycor || storeObj?.paycor;

  // Fetch live punch data + store history
  useEffect(() => {
    let cancelled = false;
    async function fetchLive() {
      setLoading(true);
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      const weekStart = (() => { const d = new Date(today + 'T12:00:00'); d.setDate(d.getDate() - d.getDay()); return d.toLocaleDateString('en-CA'); })();

      // Fetch live punches, employees + rates, and sales in parallel
      const [punchRes, empRes, historyRaw] = await Promise.all([
        fetch('/.netlify/functions/paycor', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'punches', legalEntityId: paycorId, startDate: weekStart, endDate: today }),
        }).then(r => r.json()).catch(() => null),
        fetch('/.netlify/functions/paycor', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'laborSummary', legalEntityId: paycorId }),
        }).then(r => r.json()).catch(() => null),
        cloudLoad(`pcg_labor_store_${store.pc}`),
      ]);

      if (cancelled) return;

      // Parse history
      let history = historyRaw;
      if (typeof history === 'string') try { history = JSON.parse(history); } catch { history = null; }
      setStoreHistory(history);

      // Merge punch data with employee data
      if (empRes && punchRes) {
        const punches = punchRes.records || punchRes || [];
        const employees = empRes.employees || [];

        // Compute per-employee hours today and this week
        function calcHours(pList, empId, dateFilter) {
          let empPunches = pList.filter(p => (p.employeeId || p.EmployeeId) === empId);
          if (dateFilter) empPunches = empPunches.filter(p => (p.punchDateTime || p.PunchDateTime || '').startsWith(dateFilter));
          empPunches.sort((a, b) => new Date(a.punchDateTime || a.PunchDateTime) - new Date(b.punchDateTime || b.PunchDateTime));
          let hrs = 0;
          for (let i = 0; i < empPunches.length - 1; i += 2) {
            const inT = new Date(empPunches[i].punchDateTime || empPunches[i].PunchDateTime);
            const outT = new Date(empPunches[i+1].punchDateTime || empPunches[i+1].PunchDateTime);
            if (outT > inT) hrs += (outT - inT) / 3600000;
          }
          // If odd punches (still clocked in), add time since last punch
          if (empPunches.length % 2 === 1) {
            const lastIn = new Date(empPunches[empPunches.length-1].punchDateTime || empPunches[empPunches.length-1].PunchDateTime);
            hrs += (Date.now() - lastIn.getTime()) / 3600000;
          }
          return Math.round(hrs * 100) / 100;
        }

        const enriched = employees.map(emp => {
          const hoursToday = calcHours(punches, emp.employeeId, today);
          const hoursThisWeek = calcHours(punches, emp.employeeId, null);
          const isSalaried = emp.payType === 'Salary' || emp.payType === 'salary';
          let costToday;
          if (isSalaried) {
            costToday = (emp.payRate || 0) / 12;
          } else {
            const priorHours = hoursThisWeek - hoursToday;
            const regularToday = Math.max(Math.min(hoursToday, 40 - priorHours), 0);
            const otToday = Math.max(hoursToday - regularToday, 0);
            costToday = (regularToday * (emp.payRate || 0)) + (otToday * (emp.payRate || 0) * 1.5);
          }
          const empPunchesToday = punches.filter(p => (p.employeeId || p.EmployeeId) === emp.employeeId && (p.punchDateTime || p.PunchDateTime || '').startsWith(today));
          const isOnClock = empPunchesToday.length % 2 === 1;
          const clockedInAt = isOnClock ? empPunchesToday[empPunchesToday.length - 1]?.punchDateTime || empPunchesToday[empPunchesToday.length - 1]?.PunchDateTime : null;
          return {
            ...emp,
            hoursToday,
            hoursThisWeek,
            costToday: Math.round(costToday * 100) / 100,
            overtime: hoursThisWeek >= 40,
            approachingOT: hoursThisWeek >= 35 && hoursThisWeek < 40,
            isOnClock,
            clockedInAt,
          };
        });

        // Compute hourly breakdown using punches
        const hourlyData = [];
        for (let h = 5; h <= 22; h++) {
          const hourLabel = h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h-12}pm`;
          let laborCost = 0;
          let empsInHour = 0;
          enriched.forEach(emp => {
            const empPunches = punches.filter(p => (p.employeeId || p.EmployeeId) === emp.employeeId && (p.punchDateTime || p.PunchDateTime || '').startsWith(today));
            empPunches.sort((a, b) => new Date(a.punchDateTime || a.PunchDateTime) - new Date(b.punchDateTime || b.PunchDateTime));
            // Check if employee was working during this hour
            for (let i = 0; i < empPunches.length; i += 2) {
              const inT = new Date(empPunches[i].punchDateTime || empPunches[i].PunchDateTime);
              const outT = i + 1 < empPunches.length ? new Date(empPunches[i+1].punchDateTime || empPunches[i+1].PunchDateTime) : new Date();
              const hourStart = new Date(today + 'T' + String(h).padStart(2, '0') + ':00:00');
              const hourEnd = new Date(today + 'T' + String(h + 1).padStart(2, '0') + ':00:00');
              if (inT < hourEnd && outT > hourStart) {
                const overlap = (Math.min(outT, hourEnd) - Math.max(inT, hourStart)) / 3600000;
                const isSal = emp.payType === 'Salary' || emp.payType === 'salary';
                laborCost += isSal ? ((emp.payRate || 0) / 12 / 17) : (overlap * (emp.payRate || 0));
                empsInHour++;
              }
            }
          });
          hourlyData.push({ hour: h, label: hourLabel, laborDollars: Math.round(laborCost * 100) / 100, employees: empsInHour });
        }

        setLiveData({ employees: enriched, hourly: hourlyData, punches });
      }
      setLoading(false);
    }
    if (paycorId) fetchLive();
    return () => { cancelled = true; };
  }, [store.pc, paycorId]);

  // Get today's sales from Pulse for hourly overlay
  const [hourlySales, setHourlySales] = useState([]);
  useEffect(() => {
    async function fetchHourlySales() {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      try {
        const res = await fetch('/.netlify/functions/pulse', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api: store.pc === '345986' ? 'p227' : 'p228', endpoint: 'getGuestChecks', locRef: store.pc, busDt: today, include: 'guestChecks.opnUTC,guestChecks.subTtl,guestChecks.chkTtl' }),
        });
        const data = await res.json();
        const checks = data.guestChecks || [];
        // Bucket by hour
        const byHour = {};
        checks.forEach(c => {
          const h = new Date(c.opnUTC).getHours();
          if (!byHour[h]) byHour[h] = 0;
          byHour[h] += c.chkTtl || c.subTtl || 0;
        });
        const arr = [];
        for (let h = 5; h <= 22; h++) arr.push({ hour: h, sales: Math.round((byHour[h] || 0) * 100) / 100 });
        setHourlySales(arr);
      } catch { setHourlySales([]); }
    }
    fetchHourlySales();
  }, [store.pc]);

  const todayData = store.today || {};
  const totalLaborToday = liveData ? liveData.employees.reduce((s, e) => s + e.costToday, 0) : todayData.laborDollars || 0;
  const totalSalesToday = todayData.sales || 0;
  const livePct = totalSalesToday > 0 ? Math.round((totalLaborToday / totalSalesToday) * 1000) / 10 : 0;
  const onClockCount = liveData ? liveData.employees.filter(e => e.isOnClock).length : (todayData.employeesOnClock || 0);

  // Max value for bar chart scaling
  const maxHourly = Math.max(
    ...(liveData?.hourly || []).map(h => h.laborDollars),
    ...hourlySales.map(h => h.sales),
    1
  );

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', color: th.muted, fontSize: '1.25rem', padding: '0.25rem' }}>←</button>
        <div>
          <h2 style={{ margin: 0, fontFamily: "'Raleway'", fontWeight: 700, color: th.text }}>{store.name}</h2>
          <span style={{ fontSize: '0.75rem', color: th.muted }}>District {store.district}{storeObj?.mgr ? ` · ${storeObj.mgr}` : ''}</span>
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
        <div style={{ ...card(th), padding: '0.75rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.625rem', color: th.muted, textTransform: 'uppercase', fontWeight: 600 }}>Labor $</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: laborColor(livePct) }}>{fmtDollars(totalLaborToday)}</div>
        </div>
        <div style={{ ...card(th), padding: '0.75rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.625rem', color: th.muted, textTransform: 'uppercase', fontWeight: 600 }}>Labor %</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: laborColor(livePct) }}>{fmtPct(livePct)}</div>
        </div>
        <div style={{ ...card(th), padding: '0.75rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.625rem', color: th.muted, textTransform: 'uppercase', fontWeight: 600 }}>Sales $</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#FF671F' }}>{fmtDollars(totalSalesToday)}</div>
        </div>
        <div style={{ ...card(th), padding: '0.75rem', textAlign: 'center' }}>
          <div style={{ fontSize: '0.625rem', color: th.muted, textTransform: 'uppercase', fontWeight: 600 }}>On Clock</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#FF671F' }}>{onClockCount}</div>
        </div>
      </div>

      {/* Time tabs */}
      <div style={{ display: 'flex', borderRadius: '0.5rem', overflow: 'hidden', border: `1px solid ${th.cardBorder}`, marginBottom: '1.25rem', width: 'fit-content' }}>
        {['hourly', 'daily', 'weekly'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            background: tab === t ? '#FF671F' : th.card,
            color: tab === t ? '#fff' : th.text,
            border: 'none', padding: '0.4rem 1rem', cursor: 'pointer',
            fontSize: '0.8125rem', fontWeight: 600, fontFamily: "'Source Sans 3'",
            textTransform: 'capitalize',
          }}>{t}</button>
        ))}
      </div>

      {loading && <div style={{ padding: '2rem', textAlign: 'center', color: th.muted }}>Loading live data...</div>}

      {/* Hourly View */}
      {!loading && tab === 'hourly' && (
        <div>
          {/* Bar chart */}
          <div style={{ ...card(th), padding: '1rem', marginBottom: '1rem', overflowX: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: 180, minWidth: 600 }}>
              {(liveData?.hourly || []).map((h, i) => {
                const salesH = hourlySales.find(s => s.hour === h.hour)?.sales || 0;
                const laborH = h.laborDollars;
                const pct = salesH > 0 ? (laborH / salesH) * 100 : 0;
                const laborBarH = maxHourly > 0 ? (laborH / maxHourly) * 160 : 0;
                const salesBarH = maxHourly > 0 ? (salesH / maxHourly) * 160 : 0;
                return (
                  <div key={h.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '1px', height: 160 }}>
                      <div style={{ width: 12, height: laborBarH, background: laborColor(pct), borderRadius: '2px 2px 0 0', transition: 'height .3s' }} title={`Labor: ${fmtDollars(laborH)}`} />
                      <div style={{ width: 12, height: salesBarH, background: '#FF671F40', borderRadius: '2px 2px 0 0', transition: 'height .3s' }} title={`Sales: ${fmtDollars(salesH)}`} />
                    </div>
                    <span style={{ fontSize: '0.5625rem', color: th.muted }}>{h.label}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.75rem', fontSize: '0.6875rem', color: th.muted }}>
              <span>■ Labor $</span>
              <span style={{ color: '#FF671F40' }}>■ Sales $</span>
            </div>
          </div>

          {/* Hourly table */}
          <div style={{ ...card(th), overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                  {['Hour', 'Labor $', 'Sales $', 'Labor %', 'Employees'].map(h => (
                    <th key={h} style={{ padding: '0.6rem 0.75rem', textAlign: h === 'Hour' ? 'left' : 'right', color: th.muted, fontWeight: 600, fontSize: '0.6875rem', textTransform: 'uppercase' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(liveData?.hourly || []).map(h => {
                  const salesH = hourlySales.find(s => s.hour === h.hour)?.sales || 0;
                  const pct = salesH > 0 ? Math.round((h.laborDollars / salesH) * 1000) / 10 : 0;
                  return (
                    <tr key={h.hour} style={{ borderBottom: `1px solid ${th.cardBorder}08` }}>
                      <td style={{ padding: '0.5rem 0.75rem', color: th.text }}>{h.label}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.text }}>{fmtDollars(h.laborDollars)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.text }}>{fmtDollars(salesH)}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: laborColor(pct), fontWeight: 600 }}>{salesH > 0 ? fmtPct(pct) : '—'}</td>
                      <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.muted }}>{h.employees}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Daily View */}
      {!loading && tab === 'daily' && (
        <div style={{ ...card(th), overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                {['Day', 'Labor $', 'Sales $', 'Labor %', 'Hours'].map(h => (
                  <th key={h} style={{ padding: '0.6rem 0.75rem', textAlign: h === 'Day' ? 'left' : 'right', color: th.muted, fontWeight: 600, fontSize: '0.6875rem', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(storeHistory?.daily || []).slice(-7).reverse().map(d => {
                const pct = d.laborPct || 0;
                const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                return (
                  <tr key={d.date} style={{ borderBottom: `1px solid ${th.cardBorder}08` }}>
                    <td style={{ padding: '0.5rem 0.75rem', color: th.text }}>{dayName}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.text }}>{fmtDollars(d.laborDollars)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.text }}>{fmtDollars(d.sales)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: laborColor(pct), fontWeight: 600 }}>{fmtPct(pct)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.muted }}>{d.hoursWorked || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Weekly View */}
      {!loading && tab === 'weekly' && (
        <div style={{ ...card(th), overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                {['Week Of', 'Labor $', 'Sales $', 'Labor %', 'Avg Employees'].map(h => (
                  <th key={h} style={{ padding: '0.6rem 0.75rem', textAlign: h === 'Week Of' ? 'left' : 'right', color: th.muted, fontWeight: 600, fontSize: '0.6875rem', textTransform: 'uppercase' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(storeHistory?.weekly || []).map(w => {
                const pct = w.laborPct || 0;
                const weekLabel = new Date(w.weekOf + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                return (
                  <tr key={w.weekOf} style={{ borderBottom: `1px solid ${th.cardBorder}08` }}>
                    <td style={{ padding: '0.5rem 0.75rem', color: th.text }}>{weekLabel}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.text }}>{fmtDollars(w.laborDollars)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.text }}>{fmtDollars(w.sales)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: laborColor(pct), fontWeight: 600 }}>{fmtPct(pct)}</td>
                    <td style={{ padding: '0.5rem 0.75rem', textAlign: 'right', color: th.muted }}>{w.avgDailyEmployees || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Employee Panel */}
      {!loading && liveData && (
        <div style={{ marginTop: '1.25rem' }}>
          <button onClick={() => setEmployeesExpanded(!employeesExpanded)} style={{
            ...card(th),
            width: '100%', padding: '0.75rem 1rem', cursor: 'pointer',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            border: `1px solid ${th.cardBorder}`, background: th.card,
          }}>
            <span style={{ fontWeight: 700, fontSize: '0.875rem', color: th.text }}>
              Employees ({liveData.employees.length})
              {liveData.employees.filter(e => e.overtime).length > 0 && (
                <span style={{ marginLeft: '0.5rem', fontSize: '0.6875rem', color: '#f44336', fontWeight: 700 }}>
                  {liveData.employees.filter(e => e.overtime).length} OT
                </span>
              )}
            </span>
            <span style={{ color: th.muted, transform: employeesExpanded ? 'rotate(180deg)' : '', transition: 'transform .2s' }}>▼</span>
          </button>
          {employeesExpanded && (
            <div style={{ ...card(th), marginTop: '0.25rem', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${th.cardBorder}` }}>
                    {['Name', 'Role', 'Status', 'Hours Today', 'Hours/Wk', 'Rate', 'Cost Today'].map(h => (
                      <th key={h} style={{ padding: '0.5rem 0.6rem', textAlign: h === 'Name' || h === 'Role' || h === 'Status' ? 'left' : 'right', color: th.muted, fontWeight: 600, fontSize: '0.625rem', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...liveData.employees]
                    .sort((a, b) => {
                      // OT first, then approaching OT, then by hours desc
                      if (a.overtime !== b.overtime) return b.overtime ? 1 : -1;
                      if (a.approachingOT !== b.approachingOT) return b.approachingOT ? 1 : -1;
                      return b.hoursToday - a.hoursToday;
                    })
                    .map(emp => (
                    <tr key={emp.employeeId} style={{ borderBottom: `1px solid ${th.cardBorder}08` }}>
                      <td style={{ padding: '0.5rem 0.6rem', color: th.text, fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {emp.name}
                        {emp.isOnClock && <span style={{ marginLeft: '0.4rem', width: 6, height: 6, borderRadius: '50%', background: '#22c55e', display: 'inline-block', boxShadow: '0 0 6px #22c55e' }} />}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', color: th.muted, fontSize: '0.75rem' }}>{emp.role}</td>
                      <td style={{ padding: '0.5rem 0.6rem' }}>
                        {emp.overtime && <span style={{ fontSize: '0.625rem', fontWeight: 700, color: '#f44336', background: '#f4433615', padding: '0.1rem 0.35rem', borderRadius: '0.25rem' }}>OT</span>}
                        {emp.approachingOT && <span style={{ fontSize: '0.625rem', fontWeight: 700, color: '#ff9800', background: '#ff980015', padding: '0.1rem 0.35rem', borderRadius: '0.25rem' }}>Near OT</span>}
                        {emp.payType === 'Salary' || emp.payType === 'salary' ? <span style={{ fontSize: '0.625rem', fontWeight: 600, color: th.muted, background: th.card3, padding: '0.1rem 0.35rem', borderRadius: '0.25rem' }}>Salary</span> : null}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: th.text }}>{emp.hoursToday}</td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: emp.overtime ? '#f44336' : emp.approachingOT ? '#ff9800' : th.text, fontWeight: emp.overtime || emp.approachingOT ? 700 : 400 }}>{emp.hoursThisWeek}</td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: th.muted }}>
                        {emp.payType === 'Salary' || emp.payType === 'salary' ? fmtDollars(emp.payRate) + '/2wk' : '$' + (emp.payRate || 0).toFixed(2) + '/hr'}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: th.text, fontWeight: 600 }}>{fmtDollars(emp.costToday)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Bump version to v4.64**

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add LaborDrillDown component with hourly/daily/weekly views and employee panel"
```

---

### Task 7: Verify paycor.js store mapping — populate correct Paycor IDs

**Files:**
- Modify: `netlify/functions/labor-cron.js` (STORES array)

The STORES array in labor-cron.js has placeholder Paycor IDs for stores beyond the first few. The actual IDs come from `STORES_SEED` in index.html.

- [ ] **Step 1: Cross-reference STORES_SEED paycor IDs with labor-cron.js**

Read `index.html` STORES_SEED (line 2272+) and verify every `paycor` field matches labor-cron.js. Update any mismatched IDs in `labor-cron.js`.

The known correct mappings from STORES_SEED:
- pc:339616 → paycor:193919 (Wadsworth)
- pc:340794 → paycor:193904 (Front)
- pc:351099 → paycor:193900 (Sonic)
- pc:351259 → paycor:193892 (Rosemore)
- pc:302642 → paycor:193914 (County Line)
- pc:352894 → paycor:193890 (Street Rd)
- pc:341350 → paycor:193920 (Yardley)
- pc:337839 → paycor:193888 (Warrington)
- pc:330338 → paycor:193887 (Drexel Hill)

Read the full STORES_SEED from index.html and update every entry in labor-cron.js to match.

- [ ] **Step 2: Verify syntax after updates**

Run: `node -c "netlify/functions/labor-cron.js"`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/labor-cron.js
git commit -m "fix: sync labor-cron store Paycor IDs with STORES_SEED"
```

---

### Task 8: End-to-end smoke test

- [ ] **Step 1: Start the Netlify dev server**

Run: `npx netlify dev`

Verify:
- No build errors
- All functions listed (paycor, labor-cron, pulse, etc.)

- [ ] **Step 2: Test the punches endpoint**

```bash
curl -X POST http://localhost:8888/.netlify/functions/paycor \
  -H 'Content-Type: application/json' \
  -d '{"action":"punches","legalEntityId":"193919","startDate":"2026-04-12","endDate":"2026-04-12"}'
```

Expected: 200 response with punch records (or empty array if no punches today). Verify no auth errors.

- [ ] **Step 3: Test the labor-cron function manually**

```bash
curl -X POST http://localhost:8888/.netlify/functions/labor-cron \
  -H 'Content-Type: application/json' \
  -d '{"manual":true}'
```

Expected: 200 response with `{ ok: true, storesProcessed: N, network: {...} }`. This may take 2-3 minutes since it hits all 45 stores.

- [ ] **Step 4: Test the Labor tab in the browser**

Open the portal in a browser. Log in as an executive user. Click the "Labor" tab.

Verify:
- Summary bar shows 4 KPI cards with data from the cron
- Store grid shows cards sorted by labor % descending
- Color coding: green ≤22.9%, yellow 23-25.9%, red ≥26%
- OT badges appear where applicable
- Click a store card → drill-down loads
- Hourly tab shows bar chart + table
- Daily tab shows last 7 days
- Weekly tab shows up to 8 weeks
- Employee panel expands with OT employees at top
- Salaried employees show "Salary" badge and correct daily cost
- Back button returns to dashboard

- [ ] **Step 5: Test DM view**

Log in as a district manager. Verify:
- Only their district's stores are visible
- District filter is locked
- Summary bar shows district totals
- Employee panel is visible with full detail for their stores
- Cannot see other districts' data

- [ ] **Step 6: Bump version to v4.65 and commit**

```bash
git add -A
git commit -m "feat: Labor section complete — dashboard + drill-down + cron integration"
```
