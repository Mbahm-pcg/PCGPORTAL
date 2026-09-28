// src/incident-report.mjs
// Pure logic for Workplace Incident Reports — no I/O. Shared by the
// incident-reports.mjs Netlify function (permission check) and the frontend
// form/PDF export (evidence list, people-list shaping, store autofill).

export const DEFAULT_EVIDENCE_ITEMS = [
  { id: 'camera', label: 'Interior security camera footage', defaultChecked: true },
  { id: 'report', label: 'This Workplace Incident Report', defaultChecked: true },
  { id: 'witness', label: 'Witness statements', defaultChecked: false },
];

// Builds the final evidence list to store on the report: every default item
// (checked per checkedIds) plus any non-blank custom labels, always checked
// (a custom row only exists because the user typed it in).
export function buildEvidenceList(checkedIds = [], customLabels = []) {
  const checked = new Set(checkedIds || []);
  const defaults = DEFAULT_EVIDENCE_ITEMS.map(item => ({ label: item.label, checked: checked.has(item.id) }));
  const custom = (customLabels || [])
    .map(l => String(l || '').trim())
    .filter(Boolean)
    .map(label => ({ label, checked: true }));
  return [...defaults, ...custom];
}

// Given a STORES-shaped record (pc/name/address/city/state/zip/legal), returns
// the fields the incident-report form auto-fills. Never throws on a missing store.
export function autofillFromStore(store) {
  if (!store) return { storePC: '', storeName: '', address: '', operatingEntity: '' };
  const addressParts = [store.address, store.city, [store.state, store.zip].filter(Boolean).join(' ')].filter(Boolean);
  return {
    storePC: store.pc || '',
    storeName: store.name || '',
    address: addressParts.join(', '),
    operatingEntity: store.legal || '',
  };
}

// One merged people list (name/role/phone/email) becomes the two sections the
// PDF prints, matching the source document's layout — without making the user
// enter each person twice.
export function splitPeopleForPdf(people) {
  const named = (people || []).filter(p => String(p?.name || '').trim());
  return {
    parties: named.map(p => ({ name: p.name.trim(), role: p.role || '' })),
    contacts: named.map(p => ({ name: p.name.trim(), phone: p.phone || '', email: p.email || '' })),
  };
}

// The source document lists the subject employee both in their own "Subject
// Employee" block AND as the first entry in the Parties/Witnesses + Contact
// List (role "Injured employee") — this builds that second appearance from
// the same fields the Subject Employee section already collects, so nothing
// has to be typed twice. Returns null when no employee name was entered.
export function buildSubjectEmployeeParty(report) {
  const name = String(report?.employeeName || '').trim();
  if (!name) return null;
  return { name, role: 'Injured employee', phone: report?.employeePhone || '', email: report?.employeeEmail || '' };
}

// Exec/IT can see any report. Everyone else can see only the report they filed.
export function canViewReport(report, caller) {
  if (!caller) return false;
  if (caller.userType === 'executive' || caller.userType === 'it') return true;
  return String(report?.preparedByUserId ?? '') === String(caller.sub ?? '');
}

export function filterVisibleReports(reports, caller) {
  return (reports || []).filter(r => canViewReport(r, caller));
}
