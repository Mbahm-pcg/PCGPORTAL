// weekly-hours-schedule-report-cron.mjs — scheduled weekly: emails
// attachments covering the PREVIOUS week, network-wide (all 45 stores):
//   - Timecard: one small Excel file PER STORE (buildTimecardWorkbooks) —
//     no summary/totals file, no combined workbook with tabs.
//   - Schedule: one PDF (buildSchedulePDF) rendered as an actual weekly
//     calendar grid — one page per store, a row per employee, a column per
//     day (Sun-Sat), shift time ranges in the cells.
// Built 2026-10-08 per explicit request ("I need it emailed to me every
// week, for the previous week, both the timecard and the schedule"), then
// revised several more times per explicit follow-up, in order:
//   1. One workbook with a sheet per store instead of two network-wide
//      sheets mixing all 45 stores' rows (also fixed a real confusion where
//      Gmail's inline preview only renders a multi-sheet xlsx's FIRST sheet,
//      making the Schedule sheet look missing even though it was always the
//      second tab).
//   2. Schedule split out into its own PDF entirely, separate from the
//      Excel file ("I dont want the schedule to be with the xlse file, that
//      need to be separate like a pdf file verse the time card can stay as
//      xlse or excel file").
//   3. Timecard split from one workbook-with-tabs into one FILE per store,
//      no summary file ("i need the schedule to be emailed to me as well...
//      i need to download the files one by one... i dont need the summary
//      of the total"), and Schedule rebuilt as a real calendar grid instead
//      of a flat employee/hours list, matching a reference screenshot of
//      this app's own in-app weekly schedule view.
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
import { STORES, fetchAllEmployees, punchHours, etDate, toET } from './tips-report-cron-background.mjs';
import { fetchSchedulingShifts } from './labor-cron.mjs';
import { callPaycor } from './paycor.mjs';

export const RECIPIENT = 'ahmed@peoplecapitalgroup.com';

const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// MM/DD/YYYY for display (email subject/body, sheet titles) — the ISO form
// (YYYY-MM-DD) is what every Paycor call and internal comparison actually
// uses; this is purely cosmetic, applied only at render time.
export function toUSDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${m}/${d}/${y}`;
}

// The 7 calendar dates of the week, for the schedule grid's column headers —
// weekStart is always a Sunday in real use (the scheduled cron's own
// calculation), so dayIdx 0 = Sunday .. 6 = Saturday.
function weekDates(weekStart) {
  const [y, m, d] = weekStart.split('-').map(Number);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    dates.push({ dow: DOW_FULL[dt.getUTCDay()], label: `${MONTHS_SHORT[dt.getUTCMonth()]} ${dt.getUTCDate()}` });
  }
  return dates;
}

function shiftHours(s) {
  const start = new Date(s.startDateTime || s.StartDateTime || 0).getTime();
  const end = new Date(s.endDateTime || s.EndDateTime || 0).getTime();
  return (start && end && end > start) ? (end - start) / 3600000 : 0;
}

// A shift's own ET calendar date, for bucketing into the right day-of-week
// grid column — same ET-not-UTC reasoning as employee-hours-report-
// background.mjs's punchDateISO: a shift starting at 11:40pm ET must not
// roll into the next column just because its UTC timestamp already crossed
// midnight.
function shiftDateISO(s) {
  const raw = s.startDateTime || s.StartDateTime || null;
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

function dayIndexFromWeekStart(weekStart, dateISO) {
  const [y1, m1, d1] = weekStart.split('-').map(Number);
  const [y2, m2, d2] = dateISO.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// "7:00 am – 12:00 pm" — same toET formatting the rest of this app uses for
// punch times, just lowercased to match the reference layout's style.
function shiftTimeRange(s) {
  const start = s.startDateTime || s.StartDateTime;
  const end = s.endDateTime || s.EndDateTime;
  if (!start || !end) return '';
  return `${toET(start).toLowerCase()} – ${toET(end).toLowerCase()}`;
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
  // schedule here is a GRID, not a flat total — [{ name, jobTitle, days: [string|null x7], totalHours }]
  // days[0] = weekStart's Sunday .. days[6] = its Saturday, matching the
  // reference calendar layout (one row per employee, one column per day).
  const byStore = [];

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
    const schedByEmp = {}; // employeeId -> { name, jobTitle, days: [string|null x7], totalHours }
    for (const s of shifts) {
      if (!s.employeeId) continue;
      const dISO = shiftDateISO(s);
      const dayIdx = dISO ? dayIndexFromWeekStart(weekStart, dISO) : -1;
      if (dayIdx < 0 || dayIdx > 6) continue; // outside the requested week — shouldn't normally happen, but don't mis-bucket it if it does
      if (!schedByEmp[s.employeeId]) {
        const name = s.employeeName || (s.firstName && s.lastName ? `${s.firstName} ${s.lastName}` : null) || 'Unnamed Employee';
        const jobTitle = s.schedulingJobName || s.jobTitle || s.JobTitle || '';
        schedByEmp[s.employeeId] = { name, jobTitle, days: new Array(7).fill(null), totalHours: 0 };
      }
      const entry = schedByEmp[s.employeeId];
      const timeRange = shiftTimeRange(s);
      entry.days[dayIdx] = entry.days[dayIdx] ? `${entry.days[dayIdx]}, ${timeRange}` : timeRange; // rare same-day double shift
      entry.totalHours += shiftHours(s);
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
    const schedule = Object.values(schedByEmp).filter(e => e.days.some(Boolean));
    if (timecard.length === 0 && schedule.length === 0) continue; // nothing to show for this store this week

    timecard.sort((a, b) => a[0].localeCompare(b[0]));
    schedule.sort((a, b) => a.name.localeCompare(b.name));
    byStore.push({ district: store.district, name: store.name, timecard, schedule });
  }

  byStore.sort((a, b) => (a.district - b.district) || a.name.localeCompare(b.name));
  return { byStore };
}

// One small workbook PER STORE — no Summary file, no combined workbook with
// tabs — per explicit request ("i need to download the files one by one...
// i dont need the summary of the total"). Returns [{ storeName, buffer }].
function buildTimecardWorkbooks(XLSX, weekStartUS, weekEndUS, byStore) {
  const files = [];
  for (const store of byStore) {
    if (store.timecard.length === 0) continue; // nothing worked — no file for this store
    const wb = XLSX.utils.book_new();
    const aoa = [[`${store.name} — Timecard, ${weekStartUS} to ${weekEndUS}`], []];
    aoa.push(['Employee', 'Job Title', 'Regular Hours', 'OT Hours', 'Total Hours']);
    store.timecard.forEach(r => aoa.push(r));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 26 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 13 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Timecard');
    files.push({ storeName: store.name, buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) });
  }
  return files;
}

// Schedule as a calendar grid PDF — one page (landscape) per store: a row
// per employee, a column per day (Sun-Sat), each cell the shift time range
// for that employee that day — matching the reference weekly-schedule layout
// (store name header, day-of-week + date column headers, time ranges in
// grid cells) rather than a flat employee/hours list.
async function buildSchedulePDF(weekStart, weekStartUS, weekEndUS, byStore) {
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ margin: 36, size: 'LETTER', layout: 'landscape' });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const dates = weekDates(weekStart);
  const storesWithShifts = byStore.filter(s => s.schedule.length > 0);

  if (storesWithShifts.length === 0) {
    doc.fontSize(14).font('Helvetica-Bold').text(`Weekly Schedule — ${weekStartUS} to ${weekEndUS}`);
    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica').text('No posted shifts found for any store this week.');
    doc.end();
    return done;
  }

  const MARGIN = doc.page.margins.left;
  const PAGE_W = doc.page.width - MARGIN * 2;
  const NAME_COL_W = 150;
  const DAY_COL_W = (PAGE_W - NAME_COL_W) / 7;
  const ROW_H = 34;
  const HEADER_H = 26;
  const PAGE_BOTTOM = doc.page.height - doc.page.margins.bottom;

  storesWithShifts.forEach((store, storeIdx) => {
    if (storeIdx > 0) doc.addPage();

    doc.fontSize(14).font('Helvetica-Bold').text(store.name, MARGIN, MARGIN);
    doc.fontSize(10).font('Helvetica').text(`Weekly Schedule: ${dates[0].dow}, ${dates[0].label} – ${dates[6].dow}, ${dates[6].label}`);
    doc.moveDown(0.6);

    const drawHeaderRow = (y) => {
      doc.rect(MARGIN, y, NAME_COL_W, HEADER_H).stroke();
      doc.fontSize(9).font('Helvetica-Bold').text('Employee', MARGIN + 4, y + 8, { width: NAME_COL_W - 8 });
      dates.forEach((d, i) => {
        const x = MARGIN + NAME_COL_W + i * DAY_COL_W;
        doc.rect(x, y, DAY_COL_W, HEADER_H).stroke();
        doc.fontSize(9).font('Helvetica-Bold').text(d.dow, x + 2, y + 4, { width: DAY_COL_W - 4, align: 'center' });
        doc.fontSize(8).font('Helvetica').text(d.label, x + 2, y + 15, { width: DAY_COL_W - 4, align: 'center' });
      });
      return y + HEADER_H;
    };

    let y = drawHeaderRow(doc.y);

    for (const emp of store.schedule) {
      if (y + ROW_H > PAGE_BOTTOM) {
        doc.addPage();
        doc.fontSize(12).font('Helvetica-Bold').text(`${store.name} — continued`, MARGIN, MARGIN);
        doc.moveDown(0.4);
        y = drawHeaderRow(doc.y);
      }

      doc.rect(MARGIN, y, NAME_COL_W, ROW_H).stroke();
      doc.fontSize(9).font('Helvetica-Bold').text(emp.name, MARGIN + 4, y + 4, { width: NAME_COL_W - 8 });
      if (emp.jobTitle) doc.fontSize(7).font('Helvetica').fillColor('#555').text(emp.jobTitle, MARGIN + 4, y + 18, { width: NAME_COL_W - 8 }).fillColor('#000');

      emp.days.forEach((cell, i) => {
        const x = MARGIN + NAME_COL_W + i * DAY_COL_W;
        doc.rect(x, y, DAY_COL_W, ROW_H).stroke();
        if (cell) doc.fontSize(7.5).font('Helvetica').text(cell, x + 2, y + 10, { width: DAY_COL_W - 4, align: 'center' });
      });

      y += ROW_H;
    }

    doc.y = y + 10;
  });

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
  const timecardFiles = buildTimecardWorkbooks(XLSX, weekStartUS, weekEndUS, byStore);
  const pdfBuffer = await buildSchedulePDF(weekStart, weekStartUS, weekEndUS, byStore);

  const timecardCount = byStore.reduce((s, store) => s + store.timecard.length, 0);
  const scheduleCount = byStore.reduce((s, store) => s + store.schedule.length, 0);
  const totalReg = Math.round(byStore.reduce((s, store) => s + store.timecard.reduce((ss, r) => ss + r[2], 0), 0) * 10) / 10;
  const totalOt = Math.round(byStore.reduce((s, store) => s + store.timecard.reduce((ss, r) => ss + r[3], 0), 0) * 10) / 10;
  const totalHours = Math.round(byStore.reduce((s, store) => s + store.timecard.reduce((ss, r) => ss + r[4], 0), 0) * 10) / 10;
  const totalScheduled = Math.round(byStore.reduce((s, store) => s + store.schedule.reduce((ss, e) => ss + e.totalHours, 0), 0) * 10) / 10;
  const html = `
    <p>Network-wide timecard + schedule for <strong>${weekStartUS} to ${weekEndUS}</strong> (Sun–Sat).</p>
    <ul>
      <li>Worked hours (timecard): <strong>${totalHours.toLocaleString()}</strong> (${totalReg.toLocaleString()} Reg + ${totalOt.toLocaleString()} OT) across ${timecardCount} employee-store rows</li>
      <li>Scheduled hours (posted shifts): <strong>${totalScheduled.toLocaleString()}</strong> across ${scheduleCount} employee-store rows</li>
    </ul>
    <p>${timecardFiles.length} Timecard attachments (one Excel file per store), plus one Schedule PDF (one calendar-grid page per store).</p>
  `;
  const filenameDate = (iso) => iso.replace(/-/g, '');
  const dateTag = `${filenameDate(weekStart)}_to_${filenameDate(weekEnd)}`;
  const safeFileTag = (name) => name.replace(/[^a-z0-9]+/gi, '_');
  const result = await sendReportEmail(
    recipient,
    `Weekly Hours + Schedule Report — ${weekStartUS} to ${weekEndUS}`,
    html,
    [
      ...timecardFiles.map(f => ({ filename: `Timecard_${safeFileTag(f.storeName)}_${dateTag}.xlsx`, content: f.buffer })),
      { filename: `Weekly_Schedule_${dateTag}.pdf`, content: pdfBuffer },
    ],
  );
  return { weekStart, weekEnd, totalHours, totalScheduled, timecardCount, scheduleCount, timecardFiles: timecardFiles.length, emailSent: result.sent, method: result.method };
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
