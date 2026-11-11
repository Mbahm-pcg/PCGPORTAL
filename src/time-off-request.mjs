// src/time-off-request.mjs — pure rules for Tools · Time Off Request (v22.80). No I/O.
// Shared by netlify/functions/time-off-request.mjs (server) and the screen.
//
// Replaces HR's Google Form. A Store Manager, DM, Director or exec requests their OWN time off
// (user, 2026-11-11): their name, position, location and Paycor time-off balances fill in from
// their account; they add contact + emergency contact + the leave, attach documents, and sign.
// It goes straight to HR — no approval step in the portal.

export const POSITIONS = ['Store Manager & Asst Manager', 'Shift Leader', 'Crew Member', 'Office Staff & Admin'];
export const LEAVE_TYPES = ['(FFCRA) Families First Coronavirus Response Act', '(FMLA) Family & Medical Leave Act', 'Sick Leave', 'Vacation Time',
  'Military Leave', 'Jury Duty', 'Religious Observance', 'Other'];
export const CORPORATE = 'Corporate Office';
export const defaultPosition = (role) => (role === 'manager' ? POSITIONS[0] : POSITIONS[3]);

const clean = (s, n = 200) => String(s ?? '').trim().slice(0, n);
const has = (v, k) => !!String(v?.[k] ?? '').trim();
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
const digits = (s) => String(s || '').replace(/\D/g, '');
const isPhone = (s) => { const d = digits(s); return d.length === 10 || (d.length === 11 && d[0] === '1'); };
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

export function timeOffValues(f = {}) {
  const leaveType = LEAVE_TYPES.includes(f.leaveType) ? f.leaveType : '';
  return {
    email: clean(f.email, 120), employeeName: clean(f.employeeName, 80), address: clean(f.address, 200), phone: clean(f.phone, 30),
    ecName: clean(f.ecName, 120), ecPhone: clean(f.ecPhone, 30), ecEmail: clean(f.ecEmail, 120),
    ecAuthorized: f.ecAuthorized === true ? true : f.ecAuthorized === false ? false : null,
    position: POSITIONS.includes(f.position) ? f.position : '', location: clean(f.location, 120),
    startDate: clean(f.startDate, 10), startTime: clean(f.startTime, 5), returnDate: clean(f.returnDate, 10), returnTime: clean(f.returnTime, 5),
    totalHours: f.totalHours === '' || f.totalHours == null ? '' : Number(f.totalHours),
    leaveType, leaveOther: leaveType === 'Other' ? clean(f.leaveOther, 120) : '',
    lastWorked: clean(f.lastWorked, 10), date: clean(f.date, 10),
    signature: f.sig?.image || '', signedDate: f.sig?.date || '',
    documents: (f.documents || []).map(d => clean(d.name, 120)).filter(Boolean),
  };
}

// Everything the signature vouches for. Signing doesn't change it; editing anything does.
export function timeOffFingerprint(v) {
  return ['email', 'employeeName', 'address', 'phone', 'ecName', 'ecPhone', 'ecEmail', 'ecAuthorized', 'position', 'location', 'startDate', 'startTime',
    'returnDate', 'returnTime', 'totalHours', 'leaveType', 'leaveOther', 'lastWorked'].map(k => String(v?.[k] ?? '').trim()).concat((v?.documents || []).join(',')).join('|');
}

export function missingTimeOffFields(v) {
  const out = [];
  if (!isEmail(v?.email)) out.push('Your email');
  if (!has(v, 'employeeName')) out.push('Your name');
  if (!has(v, 'address')) out.push('Your address');
  if (!isPhone(v?.phone)) out.push('Your phone number');
  if (!has(v, 'ecName')) out.push('Emergency contact name and relation');
  if (!isPhone(v?.ecPhone)) out.push('Emergency contact phone');
  if (!isEmail(v?.ecEmail)) out.push('Emergency contact email');
  if (v?.ecAuthorized !== true && v?.ecAuthorized !== false) out.push('Emergency contact authorization');
  if (!v?.position) out.push('Job position');
  if (!has(v, 'location')) out.push('Location');
  if (!isDate(v?.startDate)) out.push('Start date');
  if (!isTime(v?.startTime)) out.push('Start time');
  if (!isDate(v?.returnDate)) out.push('Back to work date');
  if (!isTime(v?.returnTime)) out.push('Back to work start time');
  if (!(Number(v?.totalHours) > 0)) out.push('Total hours requested');
  if (!v?.leaveType) out.push('Type of leave');
  if (v?.leaveType === 'Other' && !has(v, 'leaveOther')) out.push('Type of leave (other)');
  if (!isDate(v?.lastWorked)) out.push('Last date worked');
  if (!has(v, 'signature')) out.push('Your signature');
  return out;
}

// Date / hour sanity on top of "filled in".
export function timeOffProblem(v) {
  if (isDate(v?.startDate) && isDate(v?.returnDate) && v.returnDate < v.startDate) return 'The back-to-work date has to be on or after the start date.';
  if (isDate(v?.lastWorked) && isDate(v?.startDate) && v.lastWorked > v.startDate) return 'The last date worked has to be on or before the start date.';
  if (Number(v?.totalHours) > 2000) return 'Check the total hours requested.';
  return null;
}

export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
export const usTime = (t) => { const m = String(t || '').match(/^(\d{2}):(\d{2})$/); if (!m) return String(t || ''); const h = Number(m[1]); return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`; };
export const leaveLabel = (v) => (v.leaveType === 'Other' ? `Other: ${v.leaveOther}` : v.leaveType);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function timeOffFileName(v) {
  return `Time Off Request - ${v.employeeName} - ${usDate(v.startDate).replace(/\//g, '-')} to ${usDate(v.returnDate).replace(/\//g, '-')}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
}

// Text / push / bell: who, when, what kind — no contact details.
export function timeOffAlertText(v) {
  const title = `Time off request: ${v.employeeName}`;
  const line = `${v.employeeName} (${v.location}) requested ${v.totalHours} h of ${leaveLabel(v)}, ${usDate(v.startDate)} to ${usDate(v.returnDate)}.`;
  return { title, line, sms: `PCG ${title}\n${line}` };
}

export function timeOffEmailHtml(v, driveLink, docLinks = []) {
  const rows = [
    ['Employee', v.employeeName], ['Email', v.email], ['Phone', v.phone], ['Address', v.address], ['Job position', v.position], ['Location', v.location],
    ['Start', `${usDate(v.startDate)} ${usTime(v.startTime)}`], ['Back to work', `${usDate(v.returnDate)} ${usTime(v.returnTime)}`],
    ['Total hours requested', String(v.totalHours)], ['Type of leave', leaveLabel(v)], ['Last date worked', usDate(v.lastWorked)],
    ['Emergency contact', `${v.ecName}, ${v.ecPhone}, ${v.ecEmail}`],
    ['Emergency contact may be contacted', v.ecAuthorized ? 'Yes' : 'No'],
  ];
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>${esc(v.employeeName)} submitted a time off request. The signed form is attached${docLinks.length ? ', with their supporting documents' : ''}.</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.filter(r => r[1]).map(([k, val]) => `<tr><td style="color:#666;padding-right:14px;vertical-align:top">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</table>
${docLinks.length ? `<p>Supporting documents:<br>${docLinks.map(d => d.link ? `<a href="${esc(d.link)}">${esc(d.name)}</a>` : esc(d.name)).join('<br>')}</p>` : ''}
${driveLink ? `<p><a href="${esc(driveLink)}">Open the request in Google Drive</a></p>` : ''}</div>`;
}
