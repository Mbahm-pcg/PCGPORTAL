// src/transfer-notice.mjs — pure helpers for Tools · Transfer Notice (v22.49). No I/O.
// Shared by transfer-notice.mjs (server) and the form (src/transfer-notice-ui.jsx).

// Paycor /employees/{id}/payrates → the rate in force today: newest effective date first,
// same rule the labor cron uses, skipping any rate that has already ended.
export function pickCurrentPayRate(rates, today = new Date().toISOString().slice(0, 10)) {
  const list = (Array.isArray(rates) ? rates : []).filter(Boolean);
  const start = (r) => String(r.effectiveDate || r.startDate || '').slice(0, 10);
  const end = (r) => String(r.endDate || r.effectiveEndDate || '').slice(0, 10);
  const live = list.filter(r => (!start(r) || start(r) <= today) && (!end(r) || end(r) >= today));
  const pool = live.length ? live : list;
  return [...pool].sort((a, b) => start(b).localeCompare(start(a)))[0] || null;
}

// "Full time" / "Part time" if Paycor says so anywhere in the employee's status/position
// data; '' when it doesn't (the form then asks).
export function readEmploymentType(emp) {
  const seen = new Set();
  const walk = (v, depth) => {
    if (v == null || depth > 4 || seen.has(v)) return '';
    if (typeof v === 'string') {
      if (/\bpart[\s-]?time\b|^pt$/i.test(v.trim())) return 'Part time';
      if (/\bfull[\s-]?time\b|^ft$/i.test(v.trim())) return 'Full time';
      return '';
    }
    if (typeof v !== 'object') return '';
    seen.add(v);
    for (const k of Object.keys(v)) { const r = walk(v[k], depth + 1); if (r) return r; }
    return '';
  };
  return walk(emp?.statusData, 0) || walk(emp?.positionData, 0) || walk(emp?.employmentData, 0) || '';
}

// Everything the letter needs, from the picked employee + destination + form inputs.
// Name, current PC# and wage come only from Paycor (locked on the form). The current title
// is Paycor's too; only when Paycor has none on file (fromTitle) may the form supply it.
export function transferLetterValues({ employee, fromTitle, fromPC, toPC, toTitle, employmentType, effectiveDate, supervisorName, supervisorTitle, dmName, date, employeeSig, dmSig }) {
  return {
    date,
    employeeName: employee?.name || '',
    fromTitle: employee?.jobTitle || (employee ? String(fromTitle || '').trim() : ''),
    fromPC: fromPC || '',
    toPC: toPC || '',
    toTitle: toTitle || '',
    employmentType: employmentType || '',
    effectiveDate: effectiveDate || '',
    supervisorName: supervisorName || '',
    supervisorTitle: supervisorTitle || '',
    hourlyWage: employee?.payRate ?? '',
    dmName: dmName || '',
    employeeSignature: employeeSig?.image || '',
    employeeSignedDate: employeeSig?.date || '',
    dmSignature: dmSig?.image || '',
    dmSignedDate: dmSig?.date || '',
  };
}

// The letter's text (everything a signature vouches for). A signature captured on one
// version is void once any of this changes — no signing one letter and printing another.
export function letterFingerprint(v) {
  return ['date', 'employeeName', 'fromTitle', 'fromPC', 'toPC', 'toTitle', 'employmentType', 'effectiveDate',
    'supervisorName', 'supervisorTitle', 'hourlyWage', 'dmName'].map(k => String(v?.[k] ?? '').trim()).join('|');
}

// ── v22.54: save to Google Drive + alert ──────────────────────────────────────
const usDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const money = (n) => (Number(n) > 0 ? `$${Number(n).toFixed(2)}` : '');
const fileSafe = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

// Drive file name, e.g. "Transfer - Jane Doe - Bustleton to Cottman - eff 11-16-2026.pdf"
export function transferFileName(v, fromName, toName) {
  return fileSafe(`Transfer - ${v.employeeName} - ${fromName || v.fromPC} to ${toName || v.toPC} - eff ${usDate(v.effectiveDate).replace(/\//g, '-')}`) + '.pdf';
}

// The words every alert channel uses (no wage — SMS/push are not the place for pay).
export function transferAlertText(v, fromName, toName, submittedBy) {
  const title = `Transfer: ${v.employeeName}`;
  const line = `${v.employeeName} (${v.fromTitle}) is transferring from ${fromName || 'PC ' + v.fromPC} to ${toName || 'PC ' + v.toPC} as ${v.toTitle}, ${String(v.employmentType || '').toLowerCase()}, effective ${usDate(v.effectiveDate)}.`;
  const by = submittedBy ? `Submitted by ${submittedBy}.` : '';
  return { title, line, by, sms: `PCG ${title}\n${line}${by ? '\n' + by : ''}` };
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function transferEmailHtml(v, fromName, toName, submittedBy, driveLink) {
  const rows = [
    ['Employee', v.employeeName], ['Current position', v.fromTitle], ['From', `${fromName} (PC ${v.fromPC})`],
    ['To', `${toName} (PC ${v.toPC})`], ['New position', v.toTitle], ['Full / part time', v.employmentType],
    ['Effective', usDate(v.effectiveDate)], ['Hourly wage', money(v.hourlyWage)], ['New supervisor', `${v.supervisorName} — ${v.supervisorTitle}`],
    ['District Manager', v.dmName], ['Submitted by', submittedBy || ''],
  ];
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
<p>A transfer notice was signed by the employee and the District Manager. The signed letter is attached.</p>
<table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, val]) => `<tr><td style="color:#666;padding-right:14px">${esc(k)}</td><td><b>${esc(val)}</b></td></tr>`).join('')}</table>
${driveLink ? `<p><a href="${esc(driveLink)}">Open it in Google Drive</a></p>` : ''}</div>`;
}

// What still has to be filled before the PDF can be made ([] = ready).
export function missingTransferFields(v) {
  const need = [['employeeName', 'Employee'], ['fromTitle', 'Current position'], ['fromPC', 'Current store'], ['toPC', 'New store'], ['toTitle', 'New position'],
    ['employmentType', 'Full/part time'], ['effectiveDate', 'Effective date'], ['supervisorName', 'Supervisor name'],
    ['supervisorTitle', 'Supervisor title'], ['dmName', 'District Manager'],
    ['employeeSignature', 'Employee signature'], ['dmSignature', 'District Manager signature']];
  return need.filter(([k]) => !String(v?.[k] ?? '').trim()).map(([, label]) => label);
}
