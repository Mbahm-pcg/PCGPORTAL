// src/resignation-letter.mjs — pure rules for Tools · Resignation Letter (v22.87). No I/O.
// Shared by netlify/functions/resignation-letter.mjs (server) and the screen.
//
// HR's "Resignation Letter" form: the supervisor picks the employee (name, position, PC# from
// Paycor, locked), the store address is filled from the store list, and the last day of employment
// is entered. The employee signs (here, or from an emailed link when they aren't there); the
// supervisor signs "Acknowledged by" with their name and title. No approval step: once the employee
// has signed it is filed in the Resignation Letters Drive (store → employee) and the alert list told.

const clean = (s, n = 160) => String(s ?? '').trim().slice(0, n);
const has = (v, k) => !!String(v?.[k] ?? '').trim();

export function resignationValues(f = {}) {
  return {
    employeeName: clean(f.employee?.name, 80), position: clean(f.employee?.jobTitle || f.position, 80), pc: clean(f.employee ? f.pc : '', 10),
    storeAddress: clean(f.storeAddress, 160), lastDay: clean(f.lastDay, 10), date: clean(f.date, 10),
    supervisorName: clean(f.supervisorName, 80), supervisorTitle: clean(f.supervisorTitle, 60),
    employeeSignature: f.employeeSig?.image || '', employeeSignedDate: f.employeeSig?.date || '',
    supervisorSignature: f.supervisorSig?.image || '', supervisorSignedDate: f.supervisorSig?.date || '',
  };
}

// What every signature vouches for. Signing does not change it; editing anything does.
export function resignationFingerprint(v) {
  return ['employeeName', 'position', 'pc', 'storeAddress', 'lastDay', 'date', 'supervisorName', 'supervisorTitle'].map(k => String(v?.[k] ?? '').trim()).join('|');
}

export function missingResignationFields(v) {
  const out = [];
  if (!has(v, 'employeeName')) out.push('Employee');
  if (!has(v, 'storeAddress')) out.push('Store address');
  if (!has(v, 'lastDay')) out.push('Last day of employment');
  if (!has(v, 'supervisorName')) out.push('Supervisor name');
  if (!has(v, 'supervisorTitle')) out.push('Supervisor title');
  if (!has(v, 'supervisorSignature')) out.push('Supervisor signature');
  return out;
}

export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function resignationFileName(v, storeName) {
  return `Resignation Letter - ${v.employeeName} - ${storeName || v.pc} - ${usDate(v.date).replace(/\//g, '-')}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
}

export function resignationAlertText(v, storeName, submittedBy) {
  const title = `Resignation: ${v.employeeName}`;
  const line = `${v.employeeName} (${v.position ? v.position + ', ' : ''}${storeName || 'PC ' + v.pc}) resigned; last day ${usDate(v.lastDay)}${submittedBy ? `. Sent by ${submittedBy}` : ''}.`;
  return { title, line, sms: `PCG ${title}\n${line}` };
}

export function resignationEmailHtml(v, storeName, submittedBy, driveLink) {
  const rows = [['Employee', v.employeeName], ['Position', v.position], ['Store', `${storeName} (PC ${v.pc})`], ['Store address', v.storeAddress],
    ['Last day of employment', usDate(v.lastDay)], ['Letter date', usDate(v.date)], ['Acknowledged by', [v.supervisorName, v.supervisorTitle].filter(Boolean).join(', ')], ['Sent by', submittedBy]];
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>A resignation letter was signed. The signed letter is attached.</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.filter(r => r[1]).map(([k, val]) => `<tr><td style="color:#666;padding-right:14px;vertical-align:top">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</table>
${driveLink ? `<p><a href="${esc(driveLink)}">Open it in Google Drive</a></p>` : ''}</div>`;
}

// Default "Acknowledged by" title from the portal role.
export const titleForRole = (t) => ({ manager: 'Store Manager', dm: 'District Manager', director: 'Director of Operations', executive: 'Executive', it: 'HR / IT Administrator', office_staff: 'Office Staff' }[t] || '');
