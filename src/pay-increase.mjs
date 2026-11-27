// src/pay-increase.mjs — pure rules for Tools · Pay Rate Change (v22.55; approval v22.60; v22.62). No I/O.
// Shared by netlify/functions/pay-increase.mjs (server) and the screen.
//
// A Store Manager or a DM fills HR's Pay Rate Change Form with the employee's details from Paycor and
// signs; it goes to the approver (Mike), then to the office, who make the change in Paycor. The
// "For Office Use Only" box stays blank on the portal's copy.
//
// Signature lines (user, 2026-11-10, v22.64): two lines. The second line's title follows who makes
// the form. A Store Manager makes it → Store Manager signs + their District Manager signs on the
// same screen. A DM → Store Manager line is N/A, DM signs "District Manager". A Director → N/A +
// "Director of Operations". An executive → N/A + "Vice President" for Mike, "Executive" otherwise.
// IT is treated like a DM.

// v22.74: hourly people are paid per hour; salaried people (e.g. Store Managers) per year.
// Paycor marks them type "Salary" — its payRate is then per paycheck, annualPayRate the year.
export const payBasisOf = (employee) => (/salar/i.test(String(employee?.payType || '')) ? 'year' : 'hour');
export const currentPayOf = (employee) => (payBasisOf(employee) === 'year' ? employee?.annualPayRate : employee?.payRate);
export const BASIS_SUFFIX = { hour: '/ hour', year: '/ year' };
export const fmtPay = (n, basis = 'hour') => (Number(n) > 0 ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${BASIS_SUFFIX[basis] || ''}`.trim() : '');

// New pay must be a real raise: more than today's Paycor pay; at most $100/hr or $500,000/yr.
export function rateProblem(currentRate, newRate, basis = 'hour') {
  const cur = Number(currentRate), nr = Number(newRate);
  if (!(nr > 0)) return basis === 'year' ? 'Enter the new yearly salary.' : 'Enter the new pay rate.';
  if (!(cur > 0)) return basis === 'year' ? 'Paycor has no current salary for this employee.' : 'Paycor has no current hourly rate for this employee.';
  // v23.13 (user, 2026-11-23): a Pay Rate Change can also LOWER pay (e.g. moved to another district).
  // v23.35: $12.00 → $0.50 was sent twice (the raise typed instead of the new rate) — never below PA's minimum wage.
  if (basis !== 'year' && nr < 7.25) return `Enter the new hourly rate (e.g. ${fmtPay(cur + 0.5, basis)}), not the raise amount.`;
  if (Math.abs(nr - cur) < 0.005) return `The new ${basis === 'year' ? 'salary' : 'rate'} is the same as the current ${fmtPay(cur, basis)}.`;
  if (nr > (basis === 'year' ? 500000 : 100)) return 'That amount looks wrong — check it.';
  return null;
}

// Everything the form shows. Name, PC#, current rate come only from Paycor (locked); the
// position is Paycor's, or typed only when Paycor has none on file.
export function payFormValues({ employee, pc, position, newRate, reason, date, smSig, dmSig, smNa, secondLabel, smName, dmName }) {
  return {
    date: date || '',
    pc: employee ? String(pc || '') : '',
    employeeName: employee?.name || '',
    position: employee?.jobTitle || (employee ? String(position || '').trim() : ''),
    currentRate: currentPayOf(employee) ?? '',
    payBasis: payBasisOf(employee),
    newRate: newRate === '' || newRate == null ? '' : Number(newRate),
    reason: String(reason || '').trim(),
    smNa: !!smNa, secondLabel: secondLabel || 'District Manager',
    smSignature: smNa ? '' : (smSig?.image || ''), dmSignature: dmSig?.image || '',
    // v22.66: the printed name next to each signature (none on an N/A Store Manager line).
    smName: smNa ? '' : String(smName || '').trim(), dmName: String(dmName || '').trim(),
  };
}

// The form's text — what the signatures vouch for (including an "N/A" Store Manager line). A
// signature given on one version is void once any of this changes.
export function payFingerprint(v) {
  return [...['date', 'pc', 'employeeName', 'position', 'currentRate', 'payBasis', 'newRate', 'reason', 'smName', 'dmName'].map(k => String(v?.[k] ?? '').trim()), v?.smNa ? 'SM:N/A' : ''].join('|');
}

// The second signature line's title for the person making the form.
export function secondLineLabel(role, username) {
  if (role === 'director') return 'Director of Operations';
  if (role === 'executive') return String(username || '').toLowerCase() === 'mike.bahm' ? 'Vice President' : 'Executive';
  if (role === 'it') return 'HR / IT Administrator'; // v22.97: IT signs under its own title, not "District Manager"
  return 'District Manager';
}
// Store Manager line: signed when a Store Manager makes the form, otherwise N/A.
export const storeManagerNa = (role) => role !== 'manager';
const has = (v, k) => !!String(v?.[k] ?? '').trim();

// The reason can't be left empty or a token word (user, 2026-11-10): at least REASON_MIN characters.
export const REASON_MIN = 10;
export function missingPayFields(v, role) {
  const need = [['employeeName', 'Employee'], ['position', 'Position'], ['newRate', 'New pay rate'], ['date', 'Date']];
  const out = need.filter(([k]) => !has(v, k)).map(([, label]) => label);
  if (String(v?.reason ?? '').trim().length < REASON_MIN) out.splice(3, 0, 'Reason for the pay change (at least a sentence)');
  if (role === 'manager') {
    if (!has(v, 'smName')) out.push('Store Manager name');
    if (!has(v, 'dmName')) out.push('District Manager name');
    if (!has(v, 'smSignature')) out.push('Store Manager signature');
    if (!has(v, 'dmSignature')) out.push('District Manager signature');
  } else {
    if (!has(v, 'dmName')) out.push('Your name');
    if (!has(v, 'dmSignature')) out.push('Your signature');
  }
  return out;
}

// Server-side check of the same rule.
export function signatureProblem(role, v) {
  if (role === 'manager') {
    if (!has(v, 'smSignature') || !has(v, 'dmSignature') || v?.smNa) return 'The Store Manager and the District Manager both need to sign.';
    if (!has(v, 'smName') || !has(v, 'dmName')) return 'Write the name next to each signature.';
    return null;
  }
  if (!has(v, 'dmSignature')) return 'Sign your line.';
  if (!has(v, 'dmName')) return 'Write your name next to your signature.';
  if (has(v, 'smSignature') || !v?.smNa) return 'The Store Manager line is N/A when you make the form.';
  return null;
}
// signer column → who signed, for the office email (older values kept for earlier forms).
const SIGNER_LABEL = {
  sm_dm: 'Store Manager and the District Manager', dm: 'District Manager', director: 'Director of Operations', vp: 'Vice President', exec: 'Executive', it: 'HR / IT Administrator',
  sm: 'Store Manager', dm_sm: 'Store Manager and the District Manager', dm_na: 'District Manager',
};
export const signerCode = (role, username) => role === 'manager' ? 'sm_dm' : role === 'director' ? 'director'
  : role === 'executive' ? (String(username || '').toLowerCase() === 'mike.bahm' ? 'vp' : 'exec') : role === 'it' ? 'it' : 'dm';

export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const money = (n, basis) => fmtPay(n, basis);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function payFileName(v, storeName) {
  return `Pay Rate Change - ${v.employeeName} - ${storeName || v.pc} - ${usDate(v.date).replace(/\//g, '-')}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
}

// Push / SMS / bell text never carries pay rates; the email (to the list) does.
export function payAlertText(v, storeName, submittedBy) {
  const title = `Pay rate change: ${v.employeeName}`;
  const line = `A pay rate change for ${v.employeeName} (${v.position}, ${storeName || 'PC ' + v.pc}) was approved and needs the office: enter it in Paycor and set the effective date in Tools > Pay Rate Change.`;
  const by = submittedBy ? ` Sent by ${submittedBy}.` : '';
  return { title, line: line + by, sms: `PCG ${title}\n${line}${by}` };
}

// clientId: the store's Paycor Client ID (legal entity), for the office. approvedBy: who approved it.
export function payEmailHtml(v, storeName, submittedBy, driveLink, clientId, approvedBy) {
  const rows = [['Employee', v.employeeName], ['Store', `${storeName} (PC ${v.pc})${clientId ? ` (Client ID ${clientId})` : ''}`], ['Position', v.position],
    ['Current pay', money(v.currentRate, v.payBasis)], ['New pay', money(v.newRate, v.payBasis)], ['Reason', v.reason], ['Form date', usDate(v.date)],
    ['Store Manager', v.smName], [v.secondLabel || 'District Manager', v.dmName], ['Sent by', submittedBy], ['Approved by', approvedBy]];
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>A pay rate change signed by the ${SIGNER_LABEL[v.signer] || 'Store Manager'}${approvedBy ? ` and approved by ${esc(approvedBy)}` : ''} is ready for the office. The signed form is attached. Enter it in Paycor, then open it in the portal (Tools &gt; Pay Rate Change, Office tab) to fill in the effective date, the paycheck date and your signature; that files it and tells ${esc(submittedBy || 'the person who sent it')}.</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.filter(r => r[1]).map(([k, val]) => `<tr><td style="color:#666;padding-right:14px;vertical-align:top">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</table>
${driveLink ? `<p><a href="${esc(driveLink)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">${/payIncrease=/.test(driveLink) ? 'Open it in the portal' : 'Open it in Google Drive'}</a></p>` : ''}</div>`;
}

// The approval step. Text / push / bell never carry pay rates; the approver's email does.
export function approvalAlertText(kind, r, storeName, extra = {}) {
  const who = `${r.employee_name ?? r.employeeName} (${storeName || 'PC ' + r.pc})`;
  if (kind === 'request') {
    const line = `${r.submitted_by_name || 'A manager'} sent a pay rate change for ${who} for your approval.`;
    return { title: 'Pay rate change to approve', line, sms: `PCG: ${line} Open it to approve:` };
  }
  if (kind === 'approved') return { title: 'Pay rate change approved', line: `${extra.by || 'The approver'} approved the pay rate change for ${who}. It's now with the office to set the effective date; you'll get another email when it's complete.` };
  // v23.0: the office has set the effective date and filed it.
  if (kind === 'completed') return { title: 'Pay rate change complete', line: `The pay rate change for ${who} is complete (${extra.at || 'today'}). It takes effect ${extra.effective || 'on the effective date'}${extra.paycheck ? `, first on the paycheck dated ${extra.paycheck}` : ''}.${extra.by ? ` Completed by ${extra.by}.` : ''}` };
  return { title: 'Pay rate change sent back', line: `${extra.by || 'The approver'} sent back the pay rate change for ${who}: "${extra.note || ''}"` };
}

export function approvalEmailHtml(v, storeName, submittedBy, link, clientId, waitingHours = 0) {
  const rows = [['Employee', v.employeeName], ['Store', `${storeName} (PC ${v.pc})${clientId ? ` (Client ID ${clientId})` : ''}`], ['Position', v.position],
    ['Current pay', money(v.currentRate, v.payBasis)], ['New pay', money(v.newRate, v.payBasis)], ['Reason', v.reason], ['Form date', usDate(v.date)],
    ['Store Manager', v.smName], [v.secondLabel || 'District Manager', v.dmName], ['Sent by', submittedBy]];
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>${waitingHours ? `<b>Reminder:</b> this has been waiting for your approval for ${waitingHours} hour${waitingHours === 1 ? '' : 's'}. ` : ''}${esc(submittedBy || 'A manager')} sent this pay rate change for your approval. Once you approve it, it goes to the office to be entered in Paycor.</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.filter(r => r[1]).map(([k, val]) => `<tr><td style="color:#666;padding-right:14px;vertical-align:top">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</table>
<p><a href="${esc(link)}" style="display:inline-block;background:#FF671F;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Review and approve</a></p></div>`;
}
