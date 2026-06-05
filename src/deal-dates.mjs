// PCG Deal Pipeline — critical-date logic (pure, ESM, unit-tested).
// Warning windows: a date is "in warning" when it falls within its largest configured
// lead-time tier (e.g. an option-notice with [180,120,90] flags at 180 days out).
// Also generates .ics with a VALARM at each tier so the reminder lands on the calendar.

export const DATE_TYPES = [
  { id: 'loi_expiration',           label: 'LOI Response / Expiration',     defaultTiers: [14, 7, 3, 1] },
  { id: 'dd_expiration',            label: 'Due Diligence Expiration',      defaultTiers: [30, 14, 7, 3, 1] },
  { id: 'emd_hard',                 label: 'Earnest Money Goes Hard',       defaultTiers: [14, 7, 3, 1] },
  { id: 'financing_contingency',    label: 'Financing Contingency',         defaultTiers: [30, 14, 7, 3, 1] },
  { id: 'closing',                  label: 'Closing',                       defaultTiers: [60, 30, 14, 7] },
  { id: 'lease_execution',          label: 'Lease Execution Target',        defaultTiers: [30, 14, 7] },
  { id: 'possession',               label: 'Delivery of Possession',        defaultTiers: [30, 14, 7] },
  { id: 'rent_commencement',        label: 'Rent Commencement',             defaultTiers: [30, 14] },
  { id: 'construction_commencement',label: 'Construction Commencement',     defaultTiers: [30, 14] },
  { id: 'option_notice',            label: 'Option / Renewal Notice',       defaultTiers: [180, 120, 90, 60, 30] },
  { id: 'pct_rent_report',          label: '% Rent Report Due',             defaultTiers: [30, 7] },
  { id: 'cam_audit',                label: 'CAM Reconciliation / Audit Window', defaultTiers: [30, 7] },
  { id: 'coi_renewal',              label: 'Insurance / COI Renewal',       defaultTiers: [30, 7] },
  { id: 'estoppel_response',        label: 'Estoppel / SNDA Response',      defaultTiers: [7, 3, 1] },
];

export const dateLabel = (id) => (DATE_TYPES.find((t) => t.id === id) || {}).label || id;

const DAY = 86400000;

/** Whole days from now (UTC) until a 'YYYY-MM-DD' due date. Negative = overdue. */
export function daysUntil(dueDateStr, nowMs) {
  if (!dueDateStr) return Infinity;
  const due = Date.parse(String(dueDateStr).slice(0, 10) + 'T00:00:00Z');
  if (Number.isNaN(due)) return Infinity;
  return Math.ceil((due - nowMs) / DAY);
}

/**
 * Warning status for one date.
 * @returns {{daysOut:number, active:boolean, level:'overdue'|'warning'|'none', tier:number|null}}
 *   active+overdue if past due; active+warning if within the largest tier; else none.
 */
export function warningStatus(dueDateStr, warningTiers, nowMs) {
  const daysOut = daysUntil(dueDateStr, nowMs);
  const tiers = (Array.isArray(warningTiers) ? warningTiers : []).map(Number).filter((n) => n > 0);
  if (daysOut < 0) return { daysOut, active: true, level: 'overdue', tier: null };
  const maxTier = tiers.length ? Math.max(...tiers) : 30;
  const active = daysOut <= maxTier;
  const tier = tiers.filter((t) => daysOut <= t).sort((a, b) => a - b)[0] ?? null;
  return { daysOut, active, level: active ? 'warning' : 'none', tier };
}

/** Soonest unacknowledged upcoming date (or null). */
export function nextDeadline(dates, nowMs) {
  const up = (dates || [])
    .filter((d) => d && d.due_date && !d.acknowledged_at)
    .map((d) => ({ ...d, daysOut: daysUntil(d.due_date, nowMs) }))
    .sort((a, b) => a.daysOut - b.daysOut);
  return up[0] || null;
}

/** Overall deadline flag for a deal: worst active level across its unacknowledged dates. */
export function dealDeadlineFlag(dates, nowMs) {
  let level = 'none';
  let nearest = null;
  for (const d of dates || []) {
    if (!d || !d.due_date || d.acknowledged_at) continue;
    const w = warningStatus(d.due_date, d.warning_tiers, nowMs);
    if (!nearest || w.daysOut < nearest.daysOut) nearest = { ...d, ...w };
    if (w.level === 'overdue') level = 'overdue';
    else if (w.level === 'warning' && level !== 'overdue') level = 'warning';
  }
  return { level, nearest };
}

const esc = (s) => String(s == null ? '' : s).replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n');
const icsDay = (s) => String(s).slice(0, 10).replace(/-/g, '');

/** Build an .ics (all-day VEVENTs + a VALARM per warning tier) for a deal's dates. */
export function icsForDeal(deal, dates) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PCG//Deal Pipeline//EN', 'CALSCALE:GREGORIAN'];
  for (const d of dates || []) {
    if (!d || !d.due_date) continue;
    const label = dateLabel(d.date_type);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:deal-${deal && deal.id}-date-${d.id}@pcg-deals`);
    lines.push(`SUMMARY:${esc((deal && deal.name ? deal.name + ' — ' : '') + label)}`);
    lines.push(`DTSTART;VALUE=DATE:${icsDay(d.due_date)}`);
    if (d.notes) lines.push(`DESCRIPTION:${esc(d.notes)}`);
    for (const t of (Array.isArray(d.warning_tiers) ? d.warning_tiers : [])) {
      const n = Number(t);
      if (n > 0) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-P${n}D`, `DESCRIPTION:${esc(label + ' in ' + n + ' days')}`, 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
