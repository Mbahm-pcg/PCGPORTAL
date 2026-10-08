// weekly-hours-schedule-report-cron.mjs — scheduled weekly: emails a
// network-wide (all 45 stores) workbook covering the PREVIOUS week's worked
// hours (timecard) and posted shifts (schedule), one sheet each. Built
// 2026-10-08 per explicit request ("I need it emailed to me every week, for
// the previous week, both the timecard and the schedule").
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
  const timecardRows = []; // [district, store, employee, jobTitle, hours]
  const scheduleRows = []; // [district, store, employee, scheduledHours]

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

    for (const [empId, hours] of Object.entries(hoursByEmp)) {
      if (hours <= 0) continue;
      const e = empByGuid[empId];
      const name = e ? `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim() || 'Unnamed Employee' : `Unknown Employee (${empId.slice(0, 8)})`;
      const jobTitle = e?.positionData?.jobTitle || '';
      timecardRows.push([store.district, store.name, name, jobTitle, Math.round(hours * 100) / 100]);
    }
    for (const { name, hours } of Object.values(schedByEmp)) {
      if (hours <= 0) continue;
      scheduleRows.push([store.district, store.name, name, Math.round(hours * 100) / 100]);
    }
  }

  timecardRows.sort((a, b) => (a[0] - b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
  scheduleRows.sort((a, b) => (a[0] - b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
  return { timecardRows, scheduleRows };
}

function buildWorkbook(XLSX, weekStartUS, weekEndUS, timecardRows, scheduleRows) {
  const wb = XLSX.utils.book_new();

  const tcAoa = [[`Timecard — Worked Hours, ${weekStartUS} to ${weekEndUS}`], [], ['District', 'Store', 'Employee', 'Job Title', 'Hours']];
  timecardRows.forEach(r => tcAoa.push(r));
  const tcWs = XLSX.utils.aoa_to_sheet(tcAoa);
  tcWs['!cols'] = [{ wch: 9 }, { wch: 22 }, { wch: 26 }, { wch: 20 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, tcWs, 'Timecard');

  const schAoa = [[`Schedule — Posted Shifts, ${weekStartUS} to ${weekEndUS}`], [], ['District', 'Store', 'Employee', 'Scheduled Hours']];
  scheduleRows.forEach(r => schAoa.push(r));
  const schWs = XLSX.utils.aoa_to_sheet(schAoa);
  schWs['!cols'] = [{ wch: 9 }, { wch: 22 }, { wch: 26 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, schWs, 'Schedule');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Same SMTP-then-Resend fallback as tips-report-cron-background.mjs's own
// sendReportEmail — not imported from there (not exported), kept as a small
// self-contained copy rather than adding a new export for one more caller.
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
      await transporter.sendMail({ from: `PCG Portal <ops@${FROM_DOMAIN}>`, to, subject, html, attachments: [{ filename, content: buffer }] });
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
  const { timecardRows, scheduleRows } = await buildReport(weekStart, weekEnd);

  const XLSXMod = await import('xlsx');
  const XLSX = XLSXMod.default || XLSXMod;
  const weekStartUS = toUSDate(weekStart);
  const weekEndUS = toUSDate(weekEnd);
  const buffer = buildWorkbook(XLSX, weekStartUS, weekEndUS, timecardRows, scheduleRows);

  const totalHours = Math.round(timecardRows.reduce((s, r) => s + r[4], 0) * 10) / 10;
  const totalScheduled = Math.round(scheduleRows.reduce((s, r) => s + r[3], 0) * 10) / 10;
  const html = `
    <p>Network-wide timecard + schedule for <strong>${weekStartUS} to ${weekEndUS}</strong> (Sun–Sat).</p>
    <ul>
      <li>Worked hours (timecard): <strong>${totalHours.toLocaleString()}</strong> across ${timecardRows.length} employee-store rows</li>
      <li>Scheduled hours (posted shifts): <strong>${totalScheduled.toLocaleString()}</strong> across ${scheduleRows.length} employee-store rows</li>
    </ul>
    <p>Full per-store, per-employee breakdown is in the attached workbook (Timecard sheet + Schedule sheet).</p>
  `;
  const filenameDate = (iso) => iso.replace(/-/g, '');
  const result = await sendReportEmail(
    recipient,
    `Weekly Hours + Schedule Report — ${weekStartUS} to ${weekEndUS}`,
    html, buffer,
    `Weekly_Hours_Schedule_${filenameDate(weekStart)}_to_${filenameDate(weekEnd)}.xlsx`,
  );
  return { weekStart, weekEnd, totalHours, totalScheduled, timecardCount: timecardRows.length, scheduleCount: scheduleRows.length, emailSent: result.sent, method: result.method };
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
