// src/missing-hours.mjs — pure rules for Tools · Missing Hours (v22.89). No I/O.
// Shared by netlify/functions/missing-hours.mjs (server) and the screen.
//
// HR's "Employee Missing Hours" form: a manager (their store), DM or Director (their districts)
// picks the employee (name, PC# from Paycor), lists each missed shift (date, clock in, clock out;
// the hours add themselves up), and signs. It waits for approval (Admin · Notifications · Missing
// Hours approval — Ella); once approved the hours are staged in Paycor's payroll grid for that
// employee (Reg hours, one line per day) and the person who sent it is told.
import { payPeriodEndFor, parseDateOnly, toDateStr } from './office-clock-period-math.mjs';

// Same biweekly anchor as tips / the office time clock (tips-report-cron-background.mjs).
export const MH_ANCHOR_END = '2026-08-15';
export const MH_MAX_ROWS = 14;
export const MH_MAX_DAY_HOURS = 16;
export const MH_LOOKBACK_DAYS = 60;

const clean = (s, n = 80) => String(s ?? '').trim().slice(0, n);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

// Hours between clock in and clock out; a clock out earlier than the clock in is the next day.
export function rowHours(r) {
  if (!isTime(r?.clockIn) || !isTime(r?.clockOut)) return 0;
  let m = mins(r.clockOut) - mins(r.clockIn);
  if (m <= 0) m += 1440;
  return Math.round((m / 60) * 100) / 100;
}

export function periodFor(dateIso) {
  const end = payPeriodEndFor(dateIso, MH_ANCHOR_END);
  const s = parseDateOnly(end); s.setUTCDate(s.getUTCDate() - 13);
  return { start: toDateStr(s), end };
}

export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
export const fmtTime = (t) => { if (!isTime(t)) return ''; let h = Number(t.slice(0, 2)); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${t.slice(3)} ${ap}`; };
export const fmtHours = (h) => (Math.round(h * 100) / 100).toFixed(2);

// Filled rows only (a row with nothing in it is ignored), sorted by date then clock in.
export function missingHoursValues(f = {}) {
  const rows = (f.rows || []).map(r => ({ date: clean(r.date, 10), clockIn: clean(r.clockIn, 5), clockOut: clean(r.clockOut, 5) }))
    .filter(r => r.date || r.clockIn || r.clockOut)
    .map(r => ({ ...r, hours: rowHours(r) }))
    .sort((a, b) => (a.date + a.clockIn).localeCompare(b.date + b.clockIn));
  const total = Math.round(rows.reduce((t, r) => t + r.hours, 0) * 100) / 100;
  const p = rows[0] && isDate(rows[0].date) ? periodFor(rows[0].date) : null;
  return {
    employeeName: clean(f.employee?.name), jobTitle: clean(f.employee?.jobTitle), pc: clean(f.employee ? f.pc : '', 10),
    periodStart: p?.start || '', periodEnd: p?.end || '', rows, total, date: clean(f.date, 10),
    reason: clean(f.reason, 300), signerName: clean(f.signerName), signature: f.sig?.image || '', signedDate: f.sig?.date || '',
  };
}

export function missingHoursFingerprint(v) {
  return [v.employeeName, v.jobTitle, v.pc, v.reason, v.signerName, ...(v.rows || []).map(r => `${r.date} ${r.clockIn}-${r.clockOut}`)].map(x => String(x ?? '').trim()).join('|');
}

// Problems with the form; `today` (YYYY-MM-DD, ET) bounds the dates.
export function missingHoursProblems(v, today) {
  const out = [];
  if (!v.employeeName) out.push('Employee');
  if (!(v.rows || []).length) out.push('At least one day (date, clock in, clock out)');
  const earliest = (() => { const d = parseDateOnly(today); d.setUTCDate(d.getUTCDate() - MH_LOOKBACK_DAYS); return toDateStr(d); })();
  const periods = new Set();
  const seen = new Set();
  (v.rows || []).forEach((r, i) => {
    const n = `Row ${i + 1}`;
    if (!isDate(r.date)) out.push(`${n}: date`);
    else if (r.date > today) out.push(`${n}: the date can't be in the future`);
    else if (r.date < earliest) out.push(`${n}: more than ${MH_LOOKBACK_DAYS} days ago`);
    else periods.add(periodFor(r.date).end);
    if (!isTime(r.clockIn)) out.push(`${n}: clock in`);
    if (!isTime(r.clockOut)) out.push(`${n}: clock out`);
    if (isTime(r.clockIn) && isTime(r.clockOut) && r.hours > MH_MAX_DAY_HOURS) out.push(`${n}: more than ${MH_MAX_DAY_HOURS} hours`);
    const k = `${r.date} ${r.clockIn}`;
    if (seen.has(k)) out.push(`${n}: listed twice`); seen.add(k);
  });
  if (periods.size > 1) out.push('All days must be in the same pay period (send one form per pay period)');
  if (!v.signerName) out.push('Your name');
  if (!v.signature) out.push('Your signature');
  return out;
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function missingHoursFileName(v, storeName) {
  return `Missing Hours - ${v.employeeName} - ${storeName || v.pc} - ${usDate(v.periodEnd).replace(/\//g, '-')}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
}
export function missingHoursRowsHtml(v) {
  return `<table cellpadding="5" style="border-collapse:collapse;font-size:13px"><tr style="color:#666"><td>Date</td><td>Clock in</td><td>Clock out</td><td>Hours</td></tr>${(v.rows || []).map(r => `<tr><td>${esc(usDate(r.date))}</td><td>${esc(fmtTime(r.clockIn))}</td><td>${esc(fmtTime(r.clockOut))}</td><td><b>${esc(fmtHours(r.hours))}</b></td></tr>`).join('')}<tr><td colspan="3"><b>Total</b></td><td><b>${esc(fmtHours(v.total))}</b></td></tr></table>`;
}
