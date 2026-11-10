// src/violation-notice.mjs — pure rules for Tools · Violation Notice (v22.72). No I/O.
// Shared by netlify/functions/violation-notice.mjs (server) and the screen.
//
// The person filling it in picks the employee (name, job title, PC# from Paycor, locked); the
// supervisor is them (their portal name); the form date is today. Notice type is one of four,
// violation types any number, disciplinary action one (suspension needs both dates). The
// description and the date of the violation are required. Signatures: the supervisor must sign;
// the employee signs or is marked "refused to sign" or left blank (the notice can be emailed);
// the witness is optional, but a witness signature needs the witness's name.

export const NOTICE_TYPES = [['first', 'First Violation Notice'], ['second', 'Second Violation Notice'], ['third', 'Third Violation Notice'], ['ongoing', 'Ongoing Violation Notice']];
export const VIOLATION_TYPES = [['tardiness', 'Tardiness/Leaving Early'], ['absenteeism', 'Absenteeism or No Call No Show'], ['insubordination', 'Insubordination'],
  ['cash', 'Cash Handling Procedure'], ['conduct', 'Employee Conduct'], ['policy', 'Workplace Policy (safety, uniform, sanitation, etc.)']];
export const ACTIONS = [['verbal', 'Verbal Warning'], ['written', 'Written Warning'], ['termination', 'Termination'], ['suspension', 'Suspension']];
const label = (list, k) => (list.find(([key]) => key === k) || [])[1] || '';
export const DESCRIPTION_MIN = 10;

const clean = (s, n = 600) => String(s ?? '').trim().slice(0, n);
const has = (v, k) => !!String(v?.[k] ?? '').trim();

export function violationValues(f = {}) {
  const action = ACTIONS.some(([k]) => k === f.action) ? f.action : '';
  return {
    employeeName: clean(f.employee?.name, 80), jobTitle: clean(f.employee?.jobTitle || f.jobTitle, 80), pc: clean(f.employee ? f.pc : '', 10),
    supervisor: clean(f.supervisor, 80), date: clean(f.date, 10),
    notice: NOTICE_TYPES.some(([k]) => k === f.notice) ? f.notice : '',
    types: [...new Set((f.types || []).filter(t => VIOLATION_TYPES.some(([k]) => k === t)))],
    action, suspensionStart: action === 'suspension' ? clean(f.suspensionStart, 10) : '', suspensionReturn: action === 'suspension' ? clean(f.suspensionReturn, 10) : '',
    violationDate: clean(f.violationDate, 10), description: clean(f.description, 900),
    improvement: clean(f.improvement, 400), consequences: clean(f.consequences, 200),
    supervisorName: clean(f.supervisorName, 80), witnessName: clean(f.witnessName, 80),
    employeeRefused: !f.employeeSig?.image && !!f.employeeRefused,
    employeeSignature: f.employeeSig?.image || '', employeeSignedDate: f.employeeSig?.date || '',
    supervisorSignature: f.supervisorSig?.image || '', supervisorSignedDate: f.supervisorSig?.date || '',
    witnessSignature: f.witnessSig?.image || '', witnessSignedDate: f.witnessSig?.date || '',
  };
}

// What every signature vouches for. Signing does not change it; editing anything does.
export function violationFingerprint(v) {
  return ['employeeName', 'jobTitle', 'pc', 'supervisor', 'date', 'notice', 'action', 'suspensionStart', 'suspensionReturn',
    'violationDate', 'description', 'improvement', 'consequences', 'supervisorName', 'witnessName']
    .map(k => String(v?.[k] ?? '').trim()).concat((v?.types || []).slice().sort().join(',')).join('|');
}

export function missingViolationFields(v) {
  const out = [];
  if (!has(v, 'employeeName')) out.push('Employee');
  if (!has(v, 'supervisor')) out.push('Supervisor');
  if (!v?.notice) out.push('Type of violation notice');
  if (!(v?.types || []).length) out.push('Type of violation');
  if (!has(v, 'violationDate')) out.push('Date of violation');
  if (String(v?.description ?? '').trim().length < DESCRIPTION_MIN) out.push('Description of violation (at least a sentence)');
  if (!v?.action) out.push('Disciplinary action');
  if (v?.action === 'suspension' && (!has(v, 'suspensionStart') || !has(v, 'suspensionReturn'))) out.push('Suspension start and return dates');
  if (!has(v, 'supervisorName')) out.push('Supervisor name');
  if (!has(v, 'supervisorSignature')) out.push('Supervisor signature');
  if (has(v, 'witnessSignature') && !has(v, 'witnessName')) out.push('Witness name');
  return out;
}

export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function violationFileName(v, storeName) {
  return `Violation Notice - ${v.employeeName} - ${storeName || v.pc} - ${usDate(v.date).replace(/\//g, '-')}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
}

// Text / push / bell carry no details beyond who and which store; the email (to the list) has them.
export function violationAlertText(v, storeName, submittedBy) {
  const title = `Violation notice: ${v.employeeName}`;
  const line = `${label(NOTICE_TYPES, v.notice)} for ${v.employeeName} (${storeName || 'PC ' + v.pc})${submittedBy ? `, by ${submittedBy}` : ''}.`;
  return { title, line, sms: `PCG ${title}\n${line}` };
}

export function violationEmailHtml(v, storeName, submittedBy, driveLink, clientId) {
  const sus = v.action === 'suspension' ? ` (${usDate(v.suspensionStart)} to ${usDate(v.suspensionReturn)})` : '';
  const rows = [
    ['Employee', v.employeeName], ['Job title', v.jobTitle], ['Store', `${storeName} (PC ${v.pc})${clientId ? ` (Client ID ${clientId})` : ''}`],
    ['Notice', label(NOTICE_TYPES, v.notice)], ['Violation', (v.types || []).map(t => label(VIOLATION_TYPES, t)).join(', ')],
    ['Date of violation', usDate(v.violationDate)], ['Description', v.description], ['Action taken', label(ACTIONS, v.action) + sus],
    ['Plans for improvement', v.improvement], ['Consequences', v.consequences], ['Supervisor', v.supervisorName],
    ['Employee signature', v.employeeSignature ? 'Signed' : v.employeeRefused ? 'Refused to sign' : 'Not signed'],
    ['Witness', v.witnessSignature ? v.witnessName : ''], ['Sent by', submittedBy],
  ];
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>A violation notice was completed. The signed form is attached.</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.filter(r => r[1]).map(([k, val]) => `<tr><td style="color:#666;padding-right:14px;vertical-align:top">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</table>
${driveLink ? `<p><a href="${esc(driveLink)}">Open it in Google Drive</a></p>` : ''}</div>`;
}
