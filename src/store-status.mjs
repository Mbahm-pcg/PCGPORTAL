// src/store-status.mjs — single definition of "is this store closed" (v22.0).
// Pure, no I/O: shared by the frontend (app.jsx) and every Netlify function via
// netlify/functions/_shared/store-status.mjs.
//
// Only "Permanently Closed" ever hides a store. Temp Closed / Remodel / Coming
// Soon stay visible (with their status badge) because they come back. A closed
// store disappears the day AFTER its closedDate; payroll-type jobs pass graceDays
// (14) so the closing pay period still finishes processing. No closedDate on a
// Permanently Closed store means "closed now".

export const PERMANENTLY_CLOSED = 'Permanently Closed';

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export function isClosedOn(store, onIso, graceDays = 0) {
  if (!store || store.status !== PERMANENTLY_CLOSED) return false;
  const closed = String(store.closedDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(closed)) return true;
  const day = String(onIso || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  return day > addDays(closed, graceDays);
}

// pc (string) -> { status, closedDate }
export function statusMapFromStores(stores) {
  const m = new Map();
  for (const s of (Array.isArray(stores) ? stores : [])) {
    if (s && s.pc != null && s.pc !== '') m.set(String(s.pc), { status: s.status, closedDate: s.closedDate || null });
  }
  return m;
}

// `list` = any store-shaped array with a pc. statusMap null/undefined (statuses
// unavailable) = fail OPEN: keep every store rather than silently dropping all.
export function activeSubset(list, statusMap, onIso, graceDays = 0) {
  const all = Array.isArray(list) ? list : [];
  if (!statusMap) return all.slice();
  return all.filter(s => !isClosedOn(statusMap.get(String(s.pc)), onIso, graceDays));
}
