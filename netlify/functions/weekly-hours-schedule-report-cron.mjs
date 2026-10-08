// weekly-hours-schedule-report-cron.mjs — scheduled weekly: emails TWO
// attachments covering the PREVIOUS week, network-wide (all 45 stores):
//   - Timecard: an Excel workbook (Summary sheet + one sheet per store)
//   - Schedule: a separate PDF (one section per store)
// Built 2026-10-08 per explicit request ("I need it emailed to me every
// week, for the previous week, both the timecard and the schedule"), then
// revised twice more per explicit follow-up: first to one workbook with a
// sheet per store (not two network-wide sheets mixing all 45 stores'
// rows — also fixed a real confusion where Gmail's inline preview only
// renders a multi-sheet xlsx's FIRST sheet, making the Schedule sheet look
// missing even though it was always the second tab); then to split Schedule
// out into its own PDF entirely ("I dont want the schedule to be with the
// xlse file, that need to be separate like a pdf file verse the time card
// can stay as xlse or excel file") — see buildTimecardWorkbook (xlsx) and
// buildSchedulePDF (pdfkit) below.
//
// Scope decisions made building this (flagged, not silently assumed):
//   - "Timecard" here means raw Paycor punches (one call per store per
//     week — confirmed fast/safe, see employee-hours-report-background.mjs's
//     header for why a whole-range call isn't), NOT the slower per-employee
//     employeePunches reconciliation that the on-demand Hours Report tool
//     uses. For 45 stores every week, adding ~20-30 extra calls PER STORE
//     just to cross-check against the timecard copy would make this job
//     much slower/more fragile for a routine recap email — the on-demand
//     Hours Report tool (Tools hub) is still there for anyone who needs that
//     level of per-employee audit accuracy on a specific store.
//   - "Schedule" means posted/scheduled shifts (Paycor's schedulingShifts),
//     not actual worked hours — the two sheets are deliberately separate,
//     not reconciled against each other (no-show/overage detection already
//     exists elsewhere — schedule-alerts.js, no-clockin-cron.mjs).
//   - Week = Sunday–Saturday, same convention as the tips/payroll pipeline
//     (tips-report-cron-background.mjs's BIWEEKLY_ANCHOR), not the Monday-
//     start week Labor uses elsewhere in this app.
//   - Recipient is hardcoded to Ahmed's email for now, per explicit
//     direction ("just me for now") — not read from any notify-list blob.
//   - Timecard splits into Regular/OT at the standard 40-hrs/week FLSA
//     threshold (same one Office Time Clock's payroll send already uses),
//     per explicit follow-up request ("i need to know the user regular hour
//     and op hours too"). Only meaningful for a single Sun-Sat week.
//   - Schedule intentionally does NOT read the existing pcg_schedule_{pc}
//     blob the app's own Schedule tab shows — that blob is a ROLLING FORWARD
//     7-day window (today through +6 days, overwritten 3x/day by labor-cron),
//     never a history, so it can never hold a past week's actual schedule.
//     A live Paycor schedulingShifts call for the real target week is the
//     only correct source for "what was scheduled last week."
//
// The actual work is in the exported runWeeklyReport(weekStart, weekEnd) so
// weekly-hours-schedule-report-manual.mjs (an exec/IT-only background
// endpoint, NOT schedule-registered) can re-run it on demand for a specific
// past week — e.g. to test the report without waiting for next Monday.
// Netlify refuses direct HTTP calls to a function that's schedule-registered
// in netlify.toml (same reason no-clockin-cron.mjs needs its own separate
// no-clockin.mjs manual-trigger sibling), so this logic can't just be POSTed
// to directly once the schedule below is live.
import { STORES, fetchAllEmployees, punchHours, etDate } from './tips-report-cron-background.mjs';
import { fetchSchedulingShifts } from './labor-cron.mjs';
import { callPaycor } from './paycor.mjs';

export const RECIPIENT = 'ahmed@peoplecapitalgroup.com';

// MM/DD/YYYY for display (email subject/body, sheet titles) — the ISO form
// (YYYY-MM-DD) is what every Paycor call and internal comparison actually
// uses; this is purely cosmetic, applied only at render time.
export function toUSDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

function shiftHours(s) {
  const start = new Date(s.startDateTime || s.StartDateTime || 0).getTime();
  const end = new Date(s.endDateTime || s.EndDateTime || 0).getTime();
  return (start && end && end > start) ? (end - start) / 3600000 : 0;
}

async function fetchStorePunches(legalEntityId, startDate, endDate) {
  try {
    const res = await callPaycor(`/legalentities/${legalEntityId}/punches?startDate=${startDate}&endDate=${endDate}`);
    if (res.status !== 200) return [];
    const body = res.data;
    return Array.isArray(body?.records) ? body.records : (Array.isArray(body) ? body : []);
  } catch { return []; }
}

async function buildReport(weekStart, weekEnd) {
  const byStore = []; // [{ district, name, timecard: [[employee, jobTitle, hours]], schedule: [[employee, hours]] }]

  // Sequential, one store at a time — same reasoning as tips-report-cron-
  // background.mjs's Phase 2: Paycor's own token/rate behavior is unreliable
  // under concurrent load across many stores at once; 45 stores x 2 small
  // (one-week) calls each is a fine sequential workload for the cron budget.
  for (const store of STORES) {
    if (!store.paycor) continue;

    const punches = await fetchStorePunches(store.paycor, weekStart, weekEnd);
    const hoursByEmp = {};
    for (const p of punches) {
      if (!p.employeeId) continue;
      hoursByEmp[p.employeeId] = (hoursByEmp[p.employeeId] || 0) + punchHours(p);
    }

    const shifts = await fetchSchedulingShifts(store.paycor, weekStart, weekEnd);
    const schedByEmp = {}; // employeeId -> { name, hours }
    for (const s of shifts) {
      if (!s.employeeId) continue;
      const name = s.employeeName || (s.firstName && s.lastName ? `${s.firstName} ${s.lastName}` : null) || 'Unnamed Employee';
      if (!schedByEmp[s.employeeId]) schedByEmp[s.employeeId] = { name, hours: 0 };
      schedByEmp[s.employeeId].hours += shiftHours(s);
    }

    let empByGuid = {};
    if (Object.keys(hoursByEmp).length) {
      try {
        const roster = await fetchAllEmployees(store.paycor);
        roster.forEach(e => { if (e && e.id) empByGuid[e.id] = e; });
      } catch { /* names fall back to "Unknown Employee" below */ }
    }

    const timecard = [];
    for (const [empId, hours] of Object.entries(hoursByEmp)) {
      if (hours <= 0) continue;
      const e = empByGuid[empId];
      const name = e ? `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim() || 'Unnamed Employee' : `Unknown Employee (${empId.slice(0, 8)})`;
      const jobTitle = e?.positionData?.jobTitle || '';
      // Standard weekly FLSA split (<=40 Reg, >40 OT) — same threshold the
      // Office Time Clock payroll send already uses (weeklyRegOtFromPunches,
      // src/office-clock-lib.mjs). Only meaningful when weekStart/weekEnd is
      // a single Sun-Sat week, which both the scheduled cron and the manual
      // trigger's intended use always are.
      const total = Math.round(hours * 100) / 100;
      const reg = Math.round(Math.min(total, 40) * 100) / 100;
      const ot = Math.round(Math.max(total - 40, 0) * 100) / 100;
      timecard.push([name, jobTitle, reg, ot, total]);
    }
    const schedule = [];
    for (const { name, hours } of Object.values(schedByEmp)) {
      if (hours <= 0) continue;
      schedule.push([name, Math.round(hours * 100) / 100]);
    }
    if (timecard.length === 0 && schedule.length === 0) continue; // nothing to show for this store this week

    timecard.sort((a, b) => a[0].localeCompare(b[0]));
    schedule.sort((a, b) => a[0].localeCompare(b[0]));
    byStore.push({ district: store.district, name: store.name, timecard, schedule });
  }

  byStore.sort((a, b) => (a.district - b.district) || a.name.localeCompare(b.name));
  return { byStore };
}

// Excel sheet names: max 31 chars, no \ / ? * [ ] — store names here are
// short enough that collisions are unlikely, but a PC# suffix is appended on
// any truncation/dedupe to keep sheet names unique and traceable to a store.
function sheetNameFor(storeName, pc, usedNames) {
  let base = storeName.replace(/[\\/?*[\]]/g, '').slice(0, 25).trim() || `Store ${pc}`;
  let name = base;
  if (usedNames.has(name)) name = `${base} (${pc})`.slice(0, 31);
  usedNames.add(name);
  return name;
}

// Timecard ONLY — a Summary sheet (Reg/OT/Total per store) then one sheet
// per store. Schedule is a separate PDF (buildSchedulePDF below), per
// explicit request to keep the two as separate files, not two parts of one
// workbook.
function buildTimecardWorkbook(XLSX, weekStartUS, weekEndUS, byStore) {
  const wb = XLSX.utils.book_new();

  const summaryAoa = [[`Weekly Timecard — ${weekStartUS} to ${weekEndUS}`], [], ['District', 'Store', 'Regular Hours', 'OT Hours', 'Total Hours']];
  byStore.forEach(s => {
    const regTotal = Math.round(s.timecard.reduce((sum, r) => sum + r[2], 0) * 100) / 100;
    const otTotal = Math.round(s.timecard.reduce((sum, r) => sum + r[3], 0) * 100) / 100;
    const tcTotal = Math.round(s.timecard.reduce((sum, r) => sum + r[4], 0) * 100) / 100;
    summaryAoa.push([s.district, s.name, regTotal, otTotal, tcTotal]);
  });
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);
  summaryWs['!cols'] = [{ wch: 9 }, { wch: 22 }, { wch: 14 }, { wch: 12 }, { wch: 13 }];
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');

  const usedNames = new Set(['Summary']);
  // STORES doesn't carry pc on byStore entries directly — look it up by name
  // for the sheet-name dedupe suffix (store names are already unique in
  // STORES, so this is just for the rare Excel-reserved-name collision).
  const pcByName = {};
  STORES.forEach(s => { pcByName[s.name] = s.pc; });

  for (const store of byStore) {
    if (store.timecard.length === 0) continue; // nothing worked — no sheet needed in the Timecard-only file
    const sheetName = sheetNameFor(store.name, pcByName[store.name] || '', usedNames);
    const aoa = [[`${store.name} — ${weekStartUS} to ${weekEndUS}`], []];
    aoa.push(['Employee', 'Job Title', 'Regular Hours', 'OT Hours', 'Total Hours']);
    store.timecard.forEach(r => aoa.push(r));

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 26 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 13 }];
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Schedule as its own PDF — one section per store (Employee | Scheduled
// Hours), new page started whenever a section wouldn't fit on what's left of
// the current page. pdfkit has no built-in table layout, so columns are just
// fixed x-positions.
async function buildSchedulePDF(weekStartUS, weekEndUS, byStore) {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const COL_NAME_X = 50, COL_HOURS_X = 400, ROW_H = 16;
  const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom;

  doc.fontSize(16).font('Helvetica-Bold').text(`Weekly Schedule — ${weekStartUS} to ${weekEndUS}`, { align: 'left' });
  doc.moveDown(1);

  const storesWithShifts = byStore.filter(s => s.schedule.length > 0);
  if (storesWithShifts.length === 0) {
    doc.fontSize(11).font('Helvetica').text('No posted shifts found for any store this week.');
  }

  for (const store of storesWithShifts) {
    // Store heading + its table header need ~3 rows of room; if that won't
    // fit, start a fresh page rather than splitting a store across pages
    // right at its title.
    if (doc.y + ROW_H * 3 > PAGE_BOTTOM) doc.addPage();

    doc.fontSize(13).font('Helvetica-Bold').text(`${store.name} (District ${store.district})`);
    doc.moveDown(0.3);
    const headerY = doc.y;
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Employee', COL_NAME_X, headerY);
    doc.text('Scheduled Hours', COL_HOURS_X, headerY);
    doc.moveDown(0.5);
    doc.font('Helvetica');

    for (const [name, hours] of store.schedule) {
      if (doc.y + ROW_H > PAGE_BOTTOM) {
        doc.addPage();
        doc.fontSize(10).font('Helvetica-Bold').text(`${store.name} (District ${store.district}) — continued`);
        doc.moveDown(0.3);
        doc.font('Helvetica');
      }
      const rowY = doc.y;
      doc.text(name, COL_NAME_X, rowY, { width: COL_HOURS_X - COL_NAME_X - 10 });
      doc.text(String(hours), COL_HOURS_X, rowY);
      doc.moveDown(0.4);
    }
    doc.moveDown(0.8);
  }

  doc.end();
  return done;
}

// Same SMTP-then-Resend fallback as tips-report-cron-background.mjs's own
// sendReportEmail — not imported from there (not exported), kept as a small
// self-contained copy rather than adding a new export for one more caller.
// attachments: [{ filename, content: Buffer }, ...] — both SMTP and Resend
// accept a list, not just a single file.
async function sendReportEmail(to, subject, html, attachments) {
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
      await transporter.sendMail({ from: `PCG Portal <ops@${FROM_DOMAIN}>`, to, subject, html, attachments });
      return { sent: true, method: 'smtp' };
    } catch (e) {
      console.warn('[weekly-hours-schedule-report-cron] SMTP failed:', e.message);
    }
  }

  if (process.env.RESEND_API_KEY) {
    try {
      const https = await import('node:https');
      const payload = JSON.stringify({
        from: process.env.NOTIFY_FROM || 'PCG Portal <noreply@pcgops.com>',
        to: Array.isArray(to) ? to : [to],
        subject, html,
        attachments: attachments.map(a => ({ filename: a.filename, content: a.content.toString('base64') })),
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
      console.warn('[weekly-hours-schedule-report-cron] Resend failed:', e.message);
    }
  }

  return { sent: false };
}

// weekStart/weekEnd are ISO (YYYY-MM-DD), inclusive, meant to be a Sun-Sat
// week but not actually validated as such — the manual trigger can pass any
// range for testing. Returns the same summary shape logged/returned by both
// callers (the scheduled cron and the manual trigger).
export async function runWeeklyReport(weekStart, weekEnd, recipient = RECIPIENT) {
  const { byStore } = await buildReport(weekStart, weekEnd);

  const XLSXMod = await import('xlsx');
  const XLSX = XLSXMod.default || XLSXMod;
  const weekStartUS = toUSDate(weekStart);
  const weekEndUS = toUSDate(weekEnd);
  const xlsxBuffer = buildTimecardWorkbook(XLSX, weekStartUS, weekEndUS, byStore);
  const pdfBuffer = await buildSchedulePDF(weekStartUS, weekEndUS, byStore);

  const timecardCount = byStore.reduce((s, store) => s + store.timecard.length, 0);
  const scheduleCount = byStore.reduce((s, store) => s + store.schedule.length, 0);
  const totalReg = Math.round(byStore.reduce((s, store) => s + store.timecard.reduce((ss, r) => ss + r[2], 0), 0) * 10) / 10;
  const totalOt = Math.round(byStore.reduce((s, store) => s + store.timecard.reduce((ss, r) => ss + r[3], 0), 0) * 10) / 10;
  const totalHours = Math.round(byStore.reduce((s, store) => s + store.timecard.reduce((ss, r) => ss + r[4], 0), 0) * 10) / 10;
  const totalScheduled = Math.round(byStore.reduce((s, store) => s + store.schedule.reduce((ss, r) => ss + r[1], 0), 0) * 10) / 10;
  const html = `
    <p>Network-wide timecard + schedule for <strong>${weekStartUS} to ${weekEndUS}</strong> (Sun–Sat).</p>
    <ul>
      <li>Worked hours (timecard): <strong>${totalHours.toLocaleString()}</strong> (${totalReg.toLocaleString()} Reg + ${totalOt.toLocaleString()} OT) across ${timecardCount} employee-store rows</li>
      <li>Scheduled hours (posted shifts): <strong>${totalScheduled.toLocaleString()}</strong> across ${scheduleCount} employee-store rows</li>
    </ul>
    <p>Two attachments: an Excel workbook for the Timecard (Summary sheet + one sheet per store), and a PDF for the Schedule (one section per store).</p>
  `;
  const filenameDate = (iso) => iso.replace(/-/g, '');
  const dateTag = `${filenameDate(weekStart)}_to_${filenameDate(weekEnd)}`;
  const result = await sendReportEmail(
    recipient,
    `Weekly Hours + Schedule Report — ${weekStartUS} to ${weekEndUS}`,
    html,
    [
      { filename: `Weekly_Timecard_${dateTag}.xlsx`, content: xlsxBuffer },
      { filename: `Weekly_Schedule_${dateTag}.pdf`, content: pdfBuffer },
    ],
  );
  return { weekStart, weekEnd, totalHours, totalScheduled, timecardCount, scheduleCount, storeSheets: byStore.length, emailSent: result.sent, method: result.method };
}

export default async (request) => {
  try {
    // Sunday-Saturday, same convention as the tips/payroll pipeline. Run
    // Monday morning: yesterday is the week's Saturday, 6 days before that
    // is the week's Sunday.
    const weekEnd = etDate(1);
    const weekStart = etDate(7);
    const summary = await runWeeklyReport(weekStart, weekEnd);
    console.log('[weekly-hours-schedule-report-cron] done', summary);
  } catch (err) {
    console.error('[weekly-hours-schedule-report-cron] error:', err.message);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
