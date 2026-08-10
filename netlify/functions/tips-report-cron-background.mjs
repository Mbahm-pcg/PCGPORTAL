// tips-report-cron-background.mjs — Runs nightly, 12am ET, right after the
// prior business day fully closes. Always sends a DAILY tips report; on the
// Sunday each Sun–Sat pay week closes, also sends a WEEKLY rollup; every other
// Sunday (anchored to the real Aug 2–15, 2026 period, confirmed against
// Paycor's own "Bi-weekly" pay-group frequency) also sends a BIWEEKLY rollup
// meant for keying straight into Paycor payroll. All three share the exact
// same report shape (single "By Employee" sheet, see buildWorkbook) — weekly/
// biweekly just aggregate more days' worth of data.
//
// Kept as one function rather than three separate ones: this Netlify site's
// total env vars sit right at AWS Lambda's 4KB-per-function cap, so creating
// any brand-new function fails outright (hit this directly earlier). Folding
// weekly/biweekly into the already-existing nightly function sidesteps that.
//
// Each store's tip pool is divided by total hours worked in the period (crew
// only) to get a per-hour rate, then multiplied by each person's own hours —
// hours-weighted, not equal split. Hours come from real Paycor punches (summed
// per employee) — NOT Pulse's per-check employee ID, which was tested against
// live data and found to reflect whoever is logged into the register, not
// who's actually working; one store showed 191 checks all attributed to just
// 2 IDs, one of them a non-person "TransSvcs" system account. Punches are
// matched to Paycor's own employee list by GUID (employeeId), so no
// cross-system name-matching is needed. Only General Managers / Store
// Managers are excluded (jobTitle-based) — Asst Managers, Shift Leaders, and
// Crew Member all stay in the pool, per explicit instruction.
//
// Weekly/biweekly reuse each day's own nightly snapshot (pcg_tips_snapshot_*
// blobs) rather than re-fetching a week or two of Paycor data fresh — that
// would take way longer than the 15-min budget allows (46 stores sequential
// already takes minutes for ONE day). Known tradeoff: a punch a manager
// corrects AFTER that day's snapshot was taken won't retroactively show up in
// a later weekly/biweekly rollup unless that day's daily report is re-run
// (POST {"busDt":"YYYY-MM-DD"} regenerates and re-saves that day's snapshot).
// Known limitation (accepted): Paycor punch data has been sparse for some
// stores/days in this environment even after the labor-cron retry fix, so any
// of these reports may undercount crew until that's resolved — same
// underlying data gap, not a bug in this file.

import https from 'node:https';
import XLSX from 'xlsx';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '0 4 * * *' };

export const APIS = {
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

// Keep in sync with schedule-alerts.mjs / labor-cron.mjs / pos-negative-cron.mjs (CLAUDE.md gotcha #9).
export const STORES = [
  { pc:'339616', paycor:'193919', name:'Wadsworth',       district:1 },
  { pc:'340794', paycor:'193904', name:'Front',           district:1 },
  { pc:'351099', paycor:'193900', name:'Sonic',           district:2 },
  { pc:'351259', paycor:'193892', name:'Rosemore',        district:2 },
  { pc:'302642', paycor:'193914', name:'County Line',     district:2 },
  { pc:'352894', paycor:'193890', name:'Street Rd',       district:2 },
  { pc:'341350', paycor:'193920', name:'Yardley',         district:2 },
  { pc:'337839', paycor:'193888', name:'Warrington',      district:2 },
  { pc:'365953', paycor:'200540', name:'Hatboro',         district:2 },
  { pc:'330338', paycor:'193887', name:'Drexel Hill',     district:3 },
  { pc:'337063', paycor:'193902', name:'Sharon Hill',     district:3 },
  { pc:'343832', paycor:'193876', name:'Lansdowne',       district:3 },
  { pc:'304669', paycor:'193894', name:'Collingdale',     district:3 },
  { pc:'355146', paycor:'193895', name:'Gallery',         district:3 },
  { pc:'300496', paycor:'193906', name:'Cobbs Creek',     district:3 },
  { pc:'304863', paycor:'193885', name:'18th St',         district:3 },
  { pc:'354561', paycor:'193910', name:'Carlisle',        district:3 },
  { pc:'332393', paycor:'193907', name:'Lindbergh',       district:3 },
  { pc:'341167', paycor:'193893', name:'5th Street',      district:4 },
  { pc:'340870', paycor:'193912', name:'Hunting Park',    district:4 },
  { pc:'335981', paycor:'193873', name:'Lehigh',          district:4 },
  { pc:'353150', paycor:'193903', name:'Bakers Square',   district:4 },
  { pc:'351050', paycor:'193877', name:'Allegheny',       district:4 },
  { pc:'345985', paycor:'193916', name:'Wissahickon',     district:4 },
  { pc:'356374', paycor:'193898', name:'Montgomeryville', district:5 },
  { pc:'353843', paycor:'193891', name:'Tollgate',        district:5 },
  { pc:'353047', paycor:'193875', name:'Silverdale',      district:5 },
  { pc:'340538', paycor:'193879', name:'Easton',          district:5 },
  { pc:'343079', paycor:'193901', name:'Downingtown',     district:6 },
  { pc:'342144', paycor:'193908', name:'Westchester',     district:6 },
  { pc:'364295', paycor:'193881', name:'Lionville',       district:6 },
  { pc:'365361', paycor:'194373', name:'Little Welsh',    district:7 },
  { pc:'310382', paycor:'193899', name:'Grant',           district:7 },
  { pc:'332941', paycor:'193884', name:'Bustleton',       district:7 },
  { pc:'343497', paycor:'193874', name:'Red Lion',        district:7 },
  { pc:'302446', paycor:'193878', name:'Little Red Lion', district:7 },
  { pc:'337079', paycor:'193911', name:'Holme Circle',    district:7 },
  { pc:'345986', paycor:'193896', name:'Willits',         district:7 },
  { pc:'364412', paycor:'193905', name:'8200',            district:7 },
  { pc:'345489', paycor:'193880', name:'Oxford',          district:7 },
  { pc:'336372', paycor:'193897', name:'Elkins Park',     district:7 },
  { pc:'358933', paycor:'193886', name:'Brace Rd',        district:8 },
  { pc:'354865', paycor:'193915', name:'Quakertown',      district:8 },
  { pc:'353689', paycor:'193883', name:'Fort Washington', district:8 },
  { pc:'342184', paycor:'193917', name:'Lansdale',        district:8 },
  { pc:'356316', paycor:'193889', name:"BJ's",            district:8 },
];

export function callUpstream(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: cfg.host, port: 443, path: `${cfg.path}/${endpoint}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.xkey, 'Api-Key': cfg.apikey, 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve(raw));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('upstream request timed out')));
    req.write(data);
    req.end();
  });
}

// Calls our own deployed paycor.mjs proxy (handles OAuth/token refresh) rather
// than reimplementing that here — same site, internal HTTPS call. Retries once
// on failure/5xx — Paycor's own gateway genuinely returns transient 504s (seen
// directly: same store, same call, succeeded on one attempt and 504'd on the
// next), same real-world flakiness labor-cron.mjs already retries around.
// Timeout kept short (15s, was 45s) on purpose: confirmed via a real overnight
// run (2026-08-08/09) that when Paycor goes genuinely unresponsive, it hangs
// the FULL timeout on every call, not just a few — 85 consecutive calls each
// ate the old 45s before failing. With Phase 2's fixed wall-clock budget below,
// every extra second a hung store burns is a store later in the list that
// never gets attempted at all. A shorter timeout means more stores get a shot
// within the same budget when Paycor is having a bad night.
function callPaycorProxyOnce(action, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, ...payload });
    const req = https.request({
      hostname: 'pcg-ops.netlify.app', port: 443, path: '/.netlify/functions/paycor', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      const err = new Error('paycor proxy request timed out');
      err.isTimeout = true;
      req.destroy(err);
    });
    req.write(body);
    req.end();
  });
}
export async function callPaycorProxy(action, payload) {
  let result;
  try {
    result = await callPaycorProxyOnce(action, payload);
  } catch (err) {
    // A hang gets ONE fast attempt, not a retry — a store that's genuinely
    // unresponsive is very likely to hang again immediately, and retrying
    // just doubles the wasted time on that one store for nothing. A real
    // (non-hang) network error still gets retried once, since those tend to
    // clear up immediately (confirmed: same store/call succeeded on retry).
    if (err.isTimeout) throw err;
    result = await callPaycorProxyOnce(action, payload); // retry once on network error
    return result.raw;
  }
  if (result.status >= 500) {
    result = await callPaycorProxyOnce(action, payload); // retry once on 5xx
  }
  return result.raw;
}

// Paycor paginates /employees via continuationToken (same as labor-cron.mjs's
// fetchAllPages for this identical endpoint) — loop until it stops returning one.
export async function fetchAllEmployees(legalEntityId) {
  let records = [];
  let continuationToken;
  do {
    const raw = await callPaycorProxy('employees', continuationToken ? { legalEntityId, continuationToken } : { legalEntityId });
    const body = JSON.parse(raw || '{}');
    const page = Array.isArray(body.records) ? body.records : (Array.isArray(body) ? body : []);
    records = records.concat(page);
    continuationToken = body.continuationToken || body.nextToken || null;
    if (!page.length) continuationToken = null;
  } while (continuationToken);
  return records;
}

// Same fallback chain as labor-cron.mjs's computeHoursFromPunches — not every
// punch carries a pre-computed hours field.
export function punchHours(p) {
  if (p.hourAmount != null) return p.hourAmount;
  if (p.hoursAmount != null) return p.hoursAmount;
  const inMs = new Date(p.punchIn || p.inActualPunch || 0).getTime();
  const outMs = new Date(p.punchOut || p.outActualPunch || 0).getTime();
  return (inMs && outMs && outMs > inMs) ? (outMs - inMs) / 3600000 : 0;
}

function etDate(offsetDays) {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  et.setDate(et.getDate() - offsetDays);
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

export function toET(utc) {
  try { return new Date(utc.endsWith('Z') ? utc : utc + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }); }
  catch { return '--'; }
}

// ── Weekly / biweekly period helpers ─────────────────────────────────────────
// Pay weeks run Sunday–Saturday (not the Mon-start week the Labor page uses),
// so two weekly periods line up exactly with one biweekly pay period. Biweekly
// is anchored to the real period the user gave us: Sun Aug 2 – Sat Aug 15,
// 2026 (confirmed against Paycor's own pay-group frequency: "Bi-weekly").
const BIWEEKLY_ANCHOR_END = '2026-08-15'; // Saturday closing the first known period

function parseDateOnly(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function dayOfWeek(dateStr) { return parseDateOnly(dateStr).getDay(); } // 0=Sun..6=Sat
function isWeekBoundary(busDt) { return dayOfWeek(busDt) === 6; } // Saturday just closed
function isBiweekBoundary(busDt) {
  if (!isWeekBoundary(busDt)) return false;
  const diffDays = Math.round((parseDateOnly(busDt) - parseDateOnly(BIWEEKLY_ANCHOR_END)) / 86400000);
  return diffDays >= 0 && diffDays % 14 === 0;
}
// Inclusive date range of `days` dates ending at endDateStr, ascending.
export function dateRangeEndingAt(endDateStr, days) {
  const end = parseDateOnly(endDateStr);
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const dd = new Date(end);
    dd.setDate(end.getDate() - i);
    dates.push(`${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`);
  }
  return dates;
}

export async function saveDaySnapshot(busDt, storeResults) {
  try {
    await getBlobStore().setJSON(`pcg_tips_snapshot_${busDt}`, { savedAt: new Date().toISOString(), data: storeResults });
  } catch (e) { console.warn('[tips-report-cron] snapshot save failed:', e.message); }
}
// Memoized within a single invocation — on a biweekly-boundary Saturday, the
// weekly (7-day) and biweekly (14-day) rollups overlap on 7 of those days;
// without this they'd each re-fetch those same 7 snapshot blobs separately.
const snapshotCache = new Map();
async function loadDaySnapshot(busDt) {
  if (snapshotCache.has(busDt)) return snapshotCache.get(busDt);
  let result;
  try {
    const raw = await getBlobStore().get(`pcg_tips_snapshot_${busDt}`, { type: 'json' });
    result = raw?.data || null;
  } catch { result = null; }
  snapshotCache.set(busDt, result);
  return result;
}

// Combine N days of saved per-store snapshots into one period-long storeResults
// array — used for weekly/biweekly rollups. Re-fetching a full week or two of
// Paycor data fresh in a single run isn't feasible inside the 15-min budget
// (46 stores sequential already takes minutes for ONE day), so weekly/biweekly
// reuse each day's own nightly snapshot instead. Employees are matched across
// days by payrollId (falls back to name) so split/multi-day hours sum correctly.
async function buildPeriodStoreResults(endDateStr, days) {
  const dates = dateRangeEndingAt(endDateStr, days);
  const snapshots = await Promise.all(dates.map(loadDaySnapshot));
  const missingDates = dates.filter((d, i) => !snapshots[i]);

  const byStore = {};
  for (const dayResults of snapshots) {
    if (!dayResults) continue;
    for (const s of dayResults) {
      if (!byStore[s.pc]) {
        byStore[s.pc] = { pc: s.pc, name: s.name, district: s.district, rows: [], tipPool: 0, crewMap: {}, hadTips: false, hadCrew: false };
      }
      const agg = byStore[s.pc];
      if (s.status === 'ok') {
        agg.hadTips = true;
        agg.rows.push(...s.rows);
        agg.tipPool += s.tipPool || 0;
      }
      if (s.crewStatus === 'ok') {
        agg.hadCrew = true;
        (s.crew || []).forEach(c => {
          const key = c.payrollId || c.name;
          if (!agg.crewMap[key]) agg.crewMap[key] = { name: c.name, payrollId: c.payrollId, hours: 0 };
          agg.crewMap[key].hours += c.hours;
        });
      }
    }
  }

  const storeResults = STORES.map(s => {
    const agg = byStore[s.pc];
    if (!agg) return { pc: s.pc, name: s.name, district: s.district, status: 'error', crewStatus: 'error', rows: [], tipPool: 0, crew: [] };
    return {
      pc: s.pc, name: s.name, district: s.district,
      status: agg.hadTips ? 'ok' : 'error',
      crewStatus: agg.hadCrew ? 'ok' : 'error',
      rows: agg.rows, tipPool: agg.tipPool,
      crew: Object.values(agg.crewMap),
    };
  });
  return { storeResults, missingDates };
}

// ── Build the workbook (single sheet: per-employee distribution) ──
// periodLabel is display text for the title row (e.g. "2026-08-05" for daily,
// "Week of Aug 3–9, 2026" for weekly, "Pay Period Aug 2–15, 2026" for biweekly).
function buildWorkbook(periodLabel, storeResults) {
  let grandTotal = 0;
  let grandCount = 0;
  for (const s of storeResults) {
    grandTotal += s.rows.reduce((sum, r) => sum + r.tip, 0);
    grandCount += s.rows.length;
  }

  // Employee distribution: each store's tip pool is divided by the total hours
  // worked in the period (crew only, managers excluded) to get a per-hour tip
  // rate, then each person's share = that rate × their own hours worked —
  // hours feed the calculation but aren't shown as their own column, matching
  // the exact 5-column layout requested (District / Store(PC) / Employee /
  // Total Tips / Share), with District, Store(PC), and Total Tips merged down
  // each store's employee rows. Payroll ID is intentionally omitted per that
  // same request.
  const empAoa = [
    [`PCG Tips — Employee Distribution — ${periodLabel} (hours-weighted, GM/Store Managers excluded)`],
    [],
    ['District', 'Store Name (PC)', 'Employee', 'Total Tips for Store', 'Per-Employee Share'],
  ];
  const empMerges = [];
  for (const s of storeResults) {
    const pool = Number((s.tipPool || 0).toFixed(2));
    const storeLabel = `${s.name} (${s.pc})`;
    const startRow = empAoa.length;

    if (s.crewStatus === 'error') {
      empAoa.push([s.district, storeLabel, '(Paycor data unavailable)', pool, '']);
      continue;
    }
    if (s.crew.length === 0) {
      empAoa.push([s.district, storeLabel, '(no crew punches found)', pool, '']);
      continue;
    }

    const totalHours = s.crew.reduce((sum, c) => sum + c.hours, 0);
    const hourlyRate = totalHours > 0 ? pool / totalHours : 0;
    s.crew.forEach(c => {
      const share = Number((hourlyRate * c.hours).toFixed(2));
      empAoa.push([s.district, storeLabel, c.name, pool, share]);
    });

    // Merge District/Store/Total-Tips down across this store's rows (only when
    // it spans more than one row — a single-row block needs no merge).
    const endRow = empAoa.length - 1;
    if (endRow > startRow) {
      empMerges.push({ s: { r: startRow, c: 0 }, e: { r: endRow, c: 0 } }); // District
      empMerges.push({ s: { r: startRow, c: 1 }, e: { r: endRow, c: 1 } }); // Store Name (PC)
      empMerges.push({ s: { r: startRow, c: 3 }, e: { r: endRow, c: 3 } }); // Total Tips for Store
    }
  }
  const empWs = XLSX.utils.aoa_to_sheet(empAoa);
  empWs['!cols'] = [{ wch: 9 }, { wch: 24 }, { wch: 24 }, { wch: 18 }, { wch: 16 }];
  empWs['!merges'] = empMerges;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, empWs, 'By Employee');
  return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), grandTotal, grandCount };
}

// ── Email (attachment) ───────────────────────────────────────────────────────
async function sendReportEmail(to, subject, html, buffer, filename) {
  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; } catch {}

  if (nodemailer && process.env.GOOGLE_SMTP_USER) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.GOOGLE_SMTP_HOST || 'smtp-relay.gmail.com',
        port: parseInt(process.env.GOOGLE_SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.GOOGLE_SMTP_USER, pass: process.env.GOOGLE_SMTP_PASSWORD },
      });
      const FROM_DOMAIN = process.env.SMTP_FROM_DOMAIN || 'peoplecapitalgroup.com';
      await transporter.sendMail({
        from: `PCG Portal <ops@${FROM_DOMAIN}>`,
        to, subject, html,
        attachments: [{ filename, content: buffer }],
      });
      return { sent: true, method: 'smtp' };
    } catch (e) {
      console.warn('[tips-report-cron] SMTP failed:', e.message);
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const payload = JSON.stringify({
        from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>',
        to: Array.isArray(to) ? to : [to],
        subject, html,
        attachments: [{ filename, content: buffer.toString('base64') }],
      });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Length': Buffer.byteLength(payload) },
        }, (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => resolve(raw)); });
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
      return { sent: true, method: 'resend' };
    } catch (e) {
      console.warn('[tips-report-cron] Resend failed:', e.message);
    }
  }

  return { sent: false };
}

export function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

export default async (request) => {
  const invocationStart = Date.now();
  // Manual catch-up runs can target a specific date: POST {"busDt":"YYYY-MM-DD"}.
  // Scheduled invocations have no body, so this falls back to yesterday-ET.
  let busDt = etDate(1);
  try {
    const body = await request.json();
    if (body?.busDt) busDt = body.busDt;
  } catch {}
  console.log(`[tips-report-cron] Building tips report for ${busDt} across ${STORES.length} stores`);

  const storeResults = new Array(STORES.length);

  // Phase 1: Pulse tip totals — safe to batch, no shared auth state involved.
  const BATCH = 6;
  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (s, j) => {
      const idx = i + j;
      const cfg = APIS[s.pc === '345986' ? 'p227' : 'p228'];
      let rows = [], tipPool = 0, checksStatus = 'error';
      try {
        const checksRaw = await callUpstream(cfg, 'getGuestChecks', { locRef: s.pc, opnBusDt: busDt, clsdGuestChecksOnly: true, include: 'guestChecks' });
        const data = JSON.parse(checksRaw || '{}');
        const checks = Array.isArray(data.guestChecks) ? data.guestChecks : [];
        rows = checks
          .filter(c => (c.tipTotal || 0) > 0)
          .map(c => ({ chkNum: c.chkNum, time: c.clsdUTC ? toET(c.clsdUTC) : (c.opnUTC ? toET(c.opnUTC) : '--'), tip: c.tipTotal }))
          .sort((a, b) => a.time.localeCompare(b.time));
        tipPool = checks.reduce((sum, c) => sum + (c.tipTotal || 0), 0);
        checksStatus = 'ok';
      } catch (err) {
        console.error(`[tips-report-cron] ${s.name} checks error:`, err.message);
      }
      storeResults[idx] = { pc: s.pc, name: s.name, district: s.district, status: checksStatus, crewStatus: 'error', rows, tipPool, crew: [] };
    }));
  }

  // Phase 2: Paycor punches/employees — SEQUENTIAL, one store at a time, AND
  // one call at a time within a store. Our own paycor.mjs proxy caches its
  // OAuth token in-memory per warm Lambda instance; firing calls concurrently
  // spins up multiple cold instances with no shared cache, all racing to
  // refresh the same (single-use) refresh token — only one wins, the rest get
  // rejected. Confirmed directly: a real overnight run failed on ~40 of 46
  // stores simultaneously with the same error the instant concurrency was
  // introduced across stores. That fix made the store loop sequential, but
  // store 0's punches+employees calls were still fired together via
  // Promise.all — the very first Paycor calls of a cold invocation, so they
  // could still race each other exactly the same way (seen directly: store 0
  // failing crewStatus while every later store succeeded once the token was
  // cached). Awaiting punches before employees removes that too.
  //
  // Time-budgeted: confirmed via a real overnight run (Netlify function logs,
  // 2026-08-08) that Paycor's own API can go unresponsive for 30+ minutes
  // straight — 85 consecutive calls to our paycor.mjs proxy each hung the
  // full ~30s before failing with a 504. At 46 stores × up to 2 sequential
  // calls each, that alone exceeds Netlify's 15-min background function
  // ceiling, and Netlify kills the whole invocation mid-loop. Because
  // saveDaySnapshot()/the email below only ran AFTER this loop fully
  // finished, that overnight run lost 100% of its work — Phase 1's Pulse
  // data included — and sent nothing. Bailing out of the loop once we're
  // within a safe margin of the ceiling guarantees whatever's done so far
  // (still saved + emailed below) survives even a total Paycor outage,
  // instead of an all-or-nothing loss.
  const PHASE2_BUDGET_MS = 11 * 60 * 1000; // leaves ~4min for save/email/rollups
  let phase2TimedOut = false;
  for (let idx = 0; idx < STORES.length; idx++) {
    if (Date.now() - invocationStart > PHASE2_BUDGET_MS) {
      phase2TimedOut = true;
      console.warn(`[tips-report-cron] Phase 2 time budget hit at store ${idx}/${STORES.length} (${STORES[idx].name}) — saving/emailing what's done, skipping the rest`);
      break;
    }
    const s = STORES[idx];
    let crew = [], crewStatus = 'error';
    try {
      const punchesRaw = await callPaycorProxy('punches', { legalEntityId: s.paycor, startDate: busDt, endDate: busDt });
      const empList = await fetchAllEmployees(s.paycor);
      const punchData = JSON.parse(punchesRaw || '{}');
      const punches = Array.isArray(punchData.records) ? punchData.records : (Array.isArray(punchData) ? punchData : []);
      const empByGuid = {};
      empList.forEach(e => { if (e && e.id) empByGuid[e.id] = e; });

      // Matched by Paycor's own GUID (employeeId on the punch === id on the
      // employee record) — no cross-system name-matching needed. Hours are
      // summed per employee (a split shift shows as multiple punch rows) so
      // the tip pool can be divided by hours worked, not headcount.
      const hoursByGuid = {};
      punches.forEach(p => {
        if (!p.employeeId) return;
        hoursByGuid[p.employeeId] = (hoursByGuid[p.employeeId] || 0) + punchHours(p);
      });
      crew = Object.keys(hoursByGuid).map(guid => {
        const e = empByGuid[guid];
        const jobTitle = e?.positionData?.jobTitle || '';
        return {
          name: e ? `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim() || 'Unnamed Employee' : `Unknown Employee (${guid.slice(0, 8)})`,
          payrollId: e?.employeeNumber || e?.alternateEmployeeNumber || '',
          hours: hoursByGuid[guid],
          // Only General Managers / Store Managers are excluded — Asst
          // Managers, Shift Leaders, and Crew Member all stay in the pool.
          // The plain substring match alone would also catch "Assistant
          // General Manager" (a real Paycor title in this data), so an
          // "assist"/"asst" prefix explicitly opts the title back in.
          isManager: /general\s*manager|store\s*manager/i.test(jobTitle) && !/assist|asst/i.test(jobTitle),
        };
      }).filter(c => !c.isManager && c.hours > 0);
      crewStatus = 'ok';
    } catch (err) {
      console.error(`[tips-report-cron] ${s.name} crew error:`, err.message);
    }
    storeResults[idx].crew = crew;
    storeResults[idx].crewStatus = crewStatus;
  }

  // Cache today's snapshot BEFORE building/sending anything — weekly/biweekly
  // rollups (below) read from these, and a report failure downstream shouldn't
  // stop the day's data from being saved for next time.
  await saveDaySnapshot(busDt, storeResults);
  // Snapshots aren't needed past one biweekly cycle plus slack.
  const staleDate = dateRangeEndingAt(busDt, 40)[0];
  getBlobStore().delete(`pcg_tips_snapshot_${staleDate}`).catch(() => {});

  const recipient = (process.env.TIPS_REPORT_EMAIL || 'ahmed@peoplecapitalgroup.com').split(',').map(s => s.trim()).filter(Boolean);

  async function buildAndSend(periodLabel, filenameTag, storeResultsForPeriod, subjectPrefix, missingDates, extraNote) {
    const { buffer, grandTotal, grandCount } = buildWorkbook(periodLabel, storeResultsForPeriod);
    const filename = `PCG-Tips-Report-${filenameTag}.xlsx`;
    const storesWithTips = storeResultsForPeriod.filter(s => s.status === 'ok' && s.rows.length > 0).length;
    const storesWithErrors = storeResultsForPeriod.filter(s => s.status === 'error').length;
    const missingNote = missingDates && missingDates.length
      ? `<p style="margin:0 0 8px;font-size:13px;color:#b45309;">Note: ${missingDates.length} day(s) in this period have no saved data — either before this report existed, or that night's run didn't complete (${missingDates.join(', ')}).</p>`
      : '';
    const extraNoteHtml = extraNote
      ? `<p style="margin:0 0 8px;font-size:13px;color:#b45309;">${extraNote}</p>`
      : '';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: #FF671F; padding: 16px 24px; border-radius: 8px 8px 0 0;">
          <h2 style="color: #fff; margin: 0; font-size: 18px;">${subjectPrefix} — ${periodLabel}</h2>
        </div>
        <div style="padding: 24px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 8px 8px;">
          <p style="margin: 0 0 8px; font-size: 14px;">Total tips: <strong>$${grandTotal.toFixed(2)}</strong> across <strong>${grandCount}</strong> checks.</p>
          <p style="margin: 0 0 8px; font-size: 14px; color: #666;">${storesWithTips} of ${STORES.length} stores had tips recorded${storesWithErrors ? `; ${storesWithErrors} store(s) could not be reached` : ''}.</p>
          ${missingNote}
          ${extraNoteHtml}
          <p style="margin: 16px 0 0; font-size: 13px; color: #999;">Attached (${filename}): "By Employee" sheet divides each store's tip pool by hours worked in this period (GM/Store Managers excluded) and pays each person by their own hours.</p>
        </div>
      </div>
    `;
    const emailResult = await sendReportEmail(recipient, `${subjectPrefix} — ${periodLabel} — $${grandTotal.toFixed(2)}`, html, buffer, filename);
    console.log(`[tips-report-cron] ${subjectPrefix} email result:`, emailResult, 'to', recipient);
    return { grandTotal, grandCount, storesWithTips, storesWithErrors, email: emailResult };
  }

  const phase2TimeoutNote = phase2TimedOut
    ? `Paycor was unresponsive partway through tonight's run, so employee/hours data stops partway through the store list — the dollar totals above are still complete, but the "By Employee" split is incomplete for the stores that weren't reached.`
    : undefined;
  const dailyResult = await buildAndSend(busDt, busDt, storeResults, 'PCG Tips Report — Daily', undefined, phase2TimeoutNote);

  let weeklyResult = null, biweeklyResult = null;
  if (isWeekBoundary(busDt)) {
    const [weekStart] = dateRangeEndingAt(busDt, 7);
    const { storeResults: weekResults, missingDates } = await buildPeriodStoreResults(busDt, 7);
    const label = `Week of ${weekStart} – ${busDt}`;
    weeklyResult = await buildAndSend(label, `Week-${weekStart}-to-${busDt}`, weekResults, 'PCG Tips Report — Weekly', missingDates);
  }
  if (isBiweekBoundary(busDt)) {
    const [periodStart] = dateRangeEndingAt(busDt, 14);
    const { storeResults: biweekResults, missingDates } = await buildPeriodStoreResults(busDt, 14);
    const label = `Pay Period ${periodStart} – ${busDt}`;
    biweeklyResult = await buildAndSend(label, `PayPeriod-${periodStart}-to-${busDt}`, biweekResults, 'PCG Tips Report — Biweekly (Payroll)', missingDates);
  }

  try {
    const store = getBlobStore();
    await store.setJSON('pcg_tips_report_last_run', {
      savedAt: new Date().toISOString(),
      data: { ranAt: new Date().toISOString(), busDt, daily: dailyResult, weekly: weeklyResult, biweekly: biweeklyResult },
    });
  } catch {}

  const summary = { ok: true, busDt, daily: dailyResult, weekly: weeklyResult, biweekly: biweeklyResult };
  console.log('[tips-report-cron] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
