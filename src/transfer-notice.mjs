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
// Name, current title, current PC# and wage come only from Paycor (locked on the form).
export function transferLetterValues({ employee, fromPC, toPC, toTitle, employmentType, effectiveDate, supervisorName, supervisorTitle, dmName, date, employeeSig, dmSig }) {
  return {
    date,
    employeeName: employee?.name || '',
    fromTitle: employee?.jobTitle || '',
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

// What still has to be filled before the PDF can be made ([] = ready).
export function missingTransferFields(v) {
  const need = [['employeeName', 'Employee'], ['fromPC', 'Current store'], ['toPC', 'New store'], ['toTitle', 'New position'],
    ['employmentType', 'Full/part time'], ['effectiveDate', 'Effective date'], ['supervisorName', 'Supervisor name'],
    ['supervisorTitle', 'Supervisor title'], ['dmName', 'District Manager'],
    ['employeeSignature', 'Employee signature'], ['dmSignature', 'District Manager signature']];
  return need.filter(([k]) => !String(v?.[k] ?? '').trim()).map(([, label]) => label);
}
