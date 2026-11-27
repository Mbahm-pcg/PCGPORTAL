// @ts-check
// src/crew-time-off.mjs — Crew Time Off (v23.30): pure rules, no I/O.
// Crew members have no login: a manager / DM / office sends them a private link (email, or a QR on the
// manager's screen), or they scan the store's QR poster. They fill HR's Time Off Request (the same PDF
// as the managers' tool) → their store manager approves → the office (Roxy) approves → Drive + HR.
// Crew often have no email, so email / address / emergency-contact email are optional here.

export const CREW_LEAVE_TYPES = ['Sick Leave', 'Vacation Time', 'Unpaid Leave', 'Religious Observance', 'Jury Duty', 'Military Leave',
  '(FMLA) Family & Medical Leave Act', 'Other'];
export const CREW_POSITIONS = ['Crew Member', 'Shift Leader', 'Store Manager & Asst Manager'];

const clean = (s, n = 200) => String(s ?? '').trim().slice(0, n);
const has = (v, k) => !!String(v?.[k] ?? '').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');
export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
export const isPhone = (s) => { const d = digits(s); return d.length === 10 || (d.length === 11 && d[0] === '1'); };
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Paycor job title → the form's position box.
export function positionFor(jobTitle) {
  const t = String(jobTitle || '').toLowerCase();
  if (/manager/.test(t)) return CREW_POSITIONS[2];
  if (/shift|lead|supervisor/.test(t)) return CREW_POSITIONS[1];
  return CREW_POSITIONS[0];
}

// Which Paycor balance a leave type uses (null = none: unpaid, jury duty…).
export function balanceFor(leaveType, balances) {
  const rx = leaveType === 'Sick Leave' ? /sick/i : leaveType === 'Vacation Time' ? /vac|pto|paid time/i : null;
  if (!rx) return null;
  return (Array.isArray(balances) ? balances : []).find(b => rx.test(String(b?.type || ''))) || null;
}

export function crewValues(f = {}) {
  const leaveType = CREW_LEAVE_TYPES.includes(f.leaveType) ? f.leaveType : '';
  return {
    employeeName: clean(f.employeeName, 80), position: CREW_POSITIONS.includes(f.position) ? f.position : '', location: clean(f.location, 120),
    email: clean(f.email, 120), phone: clean(f.phone, 30), address: clean(f.address, 200),
    ecName: clean(f.ecName, 120), ecPhone: clean(f.ecPhone, 30), ecEmail: clean(f.ecEmail, 120),
    ecAuthorized: f.ecAuthorized === true ? true : f.ecAuthorized === false ? false : null,
    startDate: clean(f.startDate, 10), startTime: clean(f.startTime, 5), returnDate: clean(f.returnDate, 10), returnTime: clean(f.returnTime, 5),
    totalHours: f.totalHours === '' || f.totalHours == null ? '' : Number(f.totalHours),
    leaveType, leaveOther: leaveType === 'Other' ? clean(f.leaveOther, 120) : '',
    lastWorked: clean(f.lastWorked, 10), date: clean(f.date, 10),
    signature: f.sig?.image || f.signature || '', signedDate: f.sig?.date || f.signedDate || '',
    documents: (f.documents || []).map(d => clean(typeof d === 'string' ? d : d.name, 120)).filter(Boolean),
  };
}

export function missingCrewFields(v) {
  const out = [];
  if (!has(v, 'employeeName')) out.push('Your name');
  if (!isPhone(v?.phone)) out.push('Your phone number');
  if (has(v, 'email') && !isEmail(v.email)) out.push('Your email (or leave it empty)');
  if (!has(v, 'ecName')) out.push('Emergency contact name and relation');
  if (!isPhone(v?.ecPhone)) out.push('Emergency contact phone');
  if (has(v, 'ecEmail') && !isEmail(v.ecEmail)) out.push('Emergency contact email (or leave it empty)');
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

export function crewProblem(v, todayIso) {
  if (isDate(v?.startDate) && isDate(v?.returnDate) && v.returnDate < v.startDate) return 'The back-to-work date has to be on or after the start date.';
  if (isDate(v?.lastWorked) && isDate(v?.startDate) && v.lastWorked > v.startDate) return 'The last date worked has to be on or before the start date.';
  if (Number(v?.totalHours) > 400) return 'Check the total hours requested.';
  if (todayIso && isDate(v?.startDate) && v.startDate < addDays(todayIso, -60)) return 'The start date is more than 60 days ago — check it.';
  return null;
}
const addDays = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// Everything the signature vouches for — editing anything after signing voids the signature.
export function crewFingerprint(v) {
  return ['employeeName', 'position', 'location', 'email', 'phone', 'address', 'ecName', 'ecPhone', 'ecEmail', 'ecAuthorized', 'startDate', 'startTime',
    'returnDate', 'returnTime', 'totalHours', 'leaveType', 'leaveOther', 'lastWorked'].map(k => String(v?.[k] ?? '').trim()).concat((v?.documents || []).join(',')).join('|');
}

export const usDay = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
export const leaveText = (v) => (v.leaveType === 'Other' ? `Other: ${v.leaveOther}` : v.leaveType);
export const crewSummary = (v) => `${usDay(v.startDate)} to ${usDay(v.returnDate)}, ${Number(v.totalHours)} h, ${leaveText(v)}`;
export const crewFileName = (v) => `Crew Time Off - ${String(v.employeeName || 'Employee').replace(/[\\/:*?"<>|]+/g, '-')} - ${usDay(v.startDate).replace(/\//g, '-')}.pdf`;
