// tips-report-cron.mjs — Nightly network-wide tips report. Runs 12am ET, right
// after the prior business day fully closes. Pulls every check for that day
// across all stores, sums the "Charged Tip" service-charge amount (mirrored in
// the check-level tipTotal field — verified against store 302446 check #9344),
// builds a per-transaction Excel breakdown grouped by district → store with
// store subtotals + a grand total, and emails it as an attachment.
//
// Second sheet ("By Employee"): each store's tip pool is divided by total hours
// worked that day (crew only) to get a per-hour rate, then multiplied by each
// person's own hours — hours-weighted, not equal split. Hours come from real
// Paycor punches (summed per employee for the day) — NOT Pulse's per-check
// employee ID, which was tested against live data and found to reflect whoever
// is logged into the register, not who's actually working; one store showed
// 191 checks all attributed to just 2 IDs, one of them a non-person "TransSvcs"
// system account. Punches are matched to Paycor's own employee list by GUID
// (employeeId), so no cross-system name-matching is needed. Managers (jobTitle
// containing "Manager") are excluded from the pool per explicit instruction.
// Known limitation (accepted): Paycor punch data has been sparse for some
// stores/days in this environment even after the labor-cron retry fix, so this
// sheet may undercount crew until that's resolved — same underlying data gap,
// not a bug in this file.

import https from 'node:https';
import XLSX from 'xlsx';
import { getStore } from '@netlify/blobs';

export const config = { schedule: '0 4 * * *' };

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

// Keep in sync with schedule-alerts.mjs / labor-cron.mjs / pos-negative-cron.mjs (CLAUDE.md gotcha #9).
const STORES = [
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

function callUpstream(cfg, endpoint, body) {
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
    req.setTimeout(45000, () => req.destroy(new Error('paycor proxy request timed out')));
    req.write(body);
    req.end();
  });
}
async function callPaycorProxy(action, payload) {
  let result;
  try {
    result = await callPaycorProxyOnce(action, payload);
  } catch (err) {
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
async function fetchAllEmployees(legalEntityId) {
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
function punchHours(p) {
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

function toET(utc) {
  try { return new Date(utc.endsWith('Z') ? utc : utc + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }); }
  catch { return '--'; }
}

// ── Build the workbook (single sheet: per-employee distribution) ──
function buildWorkbook(busDt, storeResults) {
  let grandTotal = 0;
  let grandCount = 0;
  for (const s of storeResults) {
    grandTotal += s.rows.reduce((sum, r) => sum + r.tip, 0);
    grandCount += s.rows.length;
  }

  // Employee distribution: each store's tip pool is divided by the total hours
  // worked that day (crew only, managers excluded) to get a per-hour tip rate,
  // then each person's share = that rate × their own hours worked — hours feed
  // the calculation but aren't shown as their own column, matching the exact
  // 5-column layout requested (District / Store(PC) / Employee / Total Tips /
  // Share), with District, Store(PC), and Total Tips merged down each store's
  // employee rows. Payroll ID is intentionally omitted per that same request.
  const empAoa = [
    [`PCG Tips — Employee Distribution — ${busDt} (hours-weighted, managers excluded)`],
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

function getBlobStore() {
  return getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

export default async (request) => {
  // Manual catch-up runs can target a specific date: POST {"busDt":"YYYY-MM-DD"}.
  // Scheduled invocations have no body, so this falls back to yesterday-ET.
  let busDt = etDate(1);
  try {
    const body = await request.json();
    if (body?.busDt) busDt = body.busDt;
  } catch {}
  console.log(`[tips-report-cron] Building tips report for ${busDt} across ${STORES.length} stores`);

  const storeResults = new Array(STORES.length);
  const BATCH = 6;
  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (s, j) => {
      const idx = i + j;
      const cfg = APIS[s.pc === '345986' ? 'p227' : 'p228'];
      let rows = [], tipPool = 0, checksStatus = 'error';
      let crew = [], crewStatus = 'error';

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

      try {
        const [punchesRaw, empList] = await Promise.all([
          callPaycorProxy('punches', { legalEntityId: s.paycor, startDate: busDt, endDate: busDt }),
          fetchAllEmployees(s.paycor),
        ]);
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
            // Only the actual Store Manager is excluded — Asst Managers, Shift
            // Leaders, and Crew Member all stay in the tip pool.
            isManager: /store\s*manager/i.test(jobTitle),
          };
        }).filter(c => !c.isManager && c.hours > 0);
        crewStatus = 'ok';
      } catch (err) {
        console.error(`[tips-report-cron] ${s.name} crew error:`, err.message);
      }

      storeResults[idx] = { pc: s.pc, name: s.name, district: s.district, status: checksStatus, crewStatus, rows, tipPool, crew };
    }));
  }

  const { buffer, grandTotal, grandCount } = buildWorkbook(busDt, storeResults);
  const filename = `PCG-Tips-Report-${busDt}.xlsx`;

  const storesWithTips = storeResults.filter(s => s.status === 'ok' && s.rows.length > 0).length;
  const storesWithErrors = storeResults.filter(s => s.status === 'error').length;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #FF671F; padding: 16px 24px; border-radius: 8px 8px 0 0;">
        <h2 style="color: #fff; margin: 0; font-size: 18px;">PCG Tips Report — ${busDt}</h2>
      </div>
      <div style="padding: 24px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 8px 8px;">
        <p style="margin: 0 0 8px; font-size: 14px;">Total tips: <strong>$${grandTotal.toFixed(2)}</strong> across <strong>${grandCount}</strong> checks.</p>
        <p style="margin: 0 0 8px; font-size: 14px; color: #666;">${storesWithTips} of ${STORES.length} stores had tips recorded${storesWithErrors ? `; ${storesWithErrors} store(s) could not be reached` : ''}.</p>
        <p style="margin: 16px 0 0; font-size: 13px; color: #999;">Attached (${filename}): "By Employee" sheet divides each store's tip pool by hours worked that day (Store Managers excluded) and pays each person by their own hours.</p>
      </div>
    </div>
  `;

  const recipient = (process.env.TIPS_REPORT_EMAIL || 'ahmed@peoplecapitalgroup.com').split(',').map(s => s.trim()).filter(Boolean);
  const emailResult = await sendReportEmail(recipient, `PCG Tips Report — ${busDt} — $${grandTotal.toFixed(2)}`, html, buffer, filename);
  console.log('[tips-report-cron] Email result:', emailResult, 'to', recipient);

  try {
    const store = getBlobStore();
    await store.setJSON('pcg_tips_report_last_run', {
      savedAt: new Date().toISOString(),
      data: { ranAt: new Date().toISOString(), busDt, grandTotal, grandCount, storesWithTips, storesWithErrors, email: emailResult },
    });
  } catch {}

  const summary = { ok: true, busDt, grandTotal, grandCount, storesWithTips, storesWithErrors, email: emailResult };
  console.log('[tips-report-cron] done:', JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
