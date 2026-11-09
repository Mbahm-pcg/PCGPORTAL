// src/pay-increase.mjs — pure rules for Tools · Pay Increase (v22.55). No I/O.
// Shared by netlify/functions/pay-increase.mjs (server) and the screen.
//
// The portal is only the handshake from the DM to the office: the DM fills HR's Pay
// Increase Form with the employee's details from Paycor, the Store Manager, the DM and the
// Director of Operations all sign on the DM's screen, and it goes to the office (Google Drive
// + the Admin · Notifications · Pay Increase list). The office does the change in Paycor; the
// "For Office Use Only" box stays blank on the portal's copy.

// New rate must be a real raise: more than today's Paycor rate, at most $100/hr.
export function rateProblem(currentRate, newRate) {
  const cur = Number(currentRate), nr = Number(newRate);
  if (!(nr > 0)) return 'Enter the new pay rate.';
  if (!(cur > 0)) return 'Paycor has no current hourly rate for this employee.';
  if (nr <= cur) return `The new rate has to be higher than the current $${cur.toFixed(2)}.`;
  if (nr > 100) return 'That rate looks wrong — check it.';
  return null;
}

// Everything the form shows. Name, PC#, current rate come only from Paycor (locked); the
// position is Paycor's, or typed only when Paycor has none on file.
export function payFormValues({ employee, pc, position, newRate, reason, date, smSig, dmSig, directorSig }) {
  return {
    date: date || '',
    pc: employee ? String(pc || '') : '',
    employeeName: employee?.name || '',
    position: employee?.jobTitle || (employee ? String(position || '').trim() : ''),
    currentRate: employee?.payRate ?? '',
    newRate: newRate === '' || newRate == null ? '' : Number(newRate),
    reason: String(reason || '').trim(),
    smSignature: smSig?.image || '', dmSignature: dmSig?.image || '', directorSignature: directorSig?.image || '',
  };
}

// The form's text — what the signatures vouch for. A signature given on one version is void
// once any of this changes.
export function payFingerprint(v) {
  return ['date', 'pc', 'employeeName', 'position', 'currentRate', 'newRate', 'reason'].map(k => String(v?.[k] ?? '').trim()).join('|');
}

// Signatures: the Store Manager, plus ONE of the District Manager or the Director of
// Operations (user, 2026-11-09: "we dont need 2 of them sign, one should be enough").
export function missingPayFields(v) {
  const need = [['employeeName', 'Employee'], ['position', 'Position'], ['newRate', 'New pay rate'], ['reason', 'Reason'], ['date', 'Date'],
    ['smSignature', 'Store Manager signature']];
  const out = need.filter(([k]) => !String(v?.[k] ?? '').trim()).map(([, label]) => label);
  if (!String(v?.dmSignature ?? '').trim() && !String(v?.directorSignature ?? '').trim()) out.push('District Manager or Director signature');
  return out;
}

export const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const money = (n) => (Number(n) > 0 ? `$${Number(n).toFixed(2)}` : '');
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function payFileName(v, storeName) {
  return `Pay Increase - ${v.employeeName} - ${storeName || v.pc} - ${usDate(v.date).replace(/\//g, '-')}.pdf`.replace(/[\\/:*?"<>|]+/g, '-');
}

// Push / SMS / bell text never carries pay rates; the email (to the list) does.
export function payAlertText(v, storeName, submittedBy) {
  const title = `Pay increase: ${v.employeeName}`;
  const line = `A signed pay increase for ${v.employeeName} (${v.position}, ${storeName || 'PC ' + v.pc}) is ready to be entered in Paycor.`;
  const by = submittedBy ? ` Sent by ${submittedBy}.` : '';
  return { title, line: line + by, sms: `PCG ${title}\n${line}${by}` };
}

export function payEmailHtml(v, storeName, submittedBy, driveLink) {
  const rows = [['Employee', v.employeeName], ['Store', `${storeName} (PC ${v.pc})`], ['Position', v.position],
    ['Current rate', money(v.currentRate)], ['New rate', money(v.newRate)], ['Reason', v.reason], ['Form date', usDate(v.date)], ['Sent by', submittedBy]];
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>A pay increase was signed by the Store Manager and the ${v.directorSignature && !v.dmSignature ? 'Director of Operations' : 'District Manager'}. The signed form is attached — please enter it in Paycor.</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.filter(r => r[1]).map(([k, val]) => `<tr><td style="color:#666;padding-right:14px;vertical-align:top">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</table>
${driveLink ? `<p><a href="${esc(driveLink)}">Open it in Google Drive</a></p>` : ''}</div>`;
}
