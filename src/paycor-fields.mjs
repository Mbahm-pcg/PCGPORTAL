// @ts-check
// src/paycor-fields.mjs — reading Paycor records safely (v23.36). Pure, tested.
// Only ever picks a phone, an email or a badge number out of a record; anything SSN / tax / birth /
// bank-shaped is skipped by NAME before a value is even looked at (rule since 2026-09: birthDate only,
// never SSN — and here not even birthDate).

const BLOCKED = /ssn|social|tax|birth|bank|account|routing/i;
const tenDigits = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 10 ? d : d.length === 11 && d[0] === '1' ? d.slice(1) : null; };

// { phones:[{ v, key }], emails:[{ v, key }] } from any Paycor-shaped object (person / employee).
export function contactsFrom(obj, rootKey = '') {
  const phones = [], emails = [];
  const walk = (o, key) => {
    if (o == null) return;
    if (typeof o !== 'object') {
      const v = String(o).trim();
      if (/e-?mail/i.test(key) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) emails.push({ v, key });
      if (/phone|mobile|cell/i.test(key)) { const d = tenDigits(v); if (d) phones.push({ v: d, key }); }
      return;
    }
    if (Array.isArray(o)) { o.forEach(x => walk(x, key)); return; }
    // { type: 'Mobile', areaCode: '215', phoneNumber: '5550123' }
    const ac = o.areaCode ?? o.areacode, pn = o.phoneNumber ?? o.number;
    if (ac != null && pn != null) { const d = tenDigits(`${ac}${pn}`); if (d) phones.push({ v: d, key: `${key}.${o.type || o.phoneType || ''}` }); }
    for (const [k, v] of Object.entries(o)) if (!BLOCKED.test(k)) walk(v, key ? `${key}.${k}` : k);
  };
  walk(obj, rootKey);
  return { phones, emails };
}

export function pickContact({ phones, emails }) {
  const pick = (list, prefer) => (list.find(x => prefer.test(x.key)) || list[0] || {}).v || '';
  return { phone: pick(phones, /mobile|cell/i), email: pick(emails, /personal|home/i) || pick(emails, /./) };
}

// Badge numbers crew may type: the time-clock badge first, HR's employee number as a backup.
export const normBadge = (x) => String(x ?? '').replace(/\D/g, '').replace(/^0+/, '');
export function badgesFromRecord(rec) {
  const out = new Set();
  for (const k of ['badgeNumber', 'alternateEmployeeNumber', 'employeeNumber']) if (normBadge(rec?.[k])) out.add(normBadge(rec[k]));
  return out;
}
