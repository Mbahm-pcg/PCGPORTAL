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

// ── Districts (v22.12) ──────────────────────────────────────────────────────
// Locations is also the source of truth for which district a store is in.
// Every job carries its own hard-coded store list (with a district per store),
// so moving a store to another DM in Locations used to change the screens but
// not who the background alerts went to. These let a job overwrite its list's
// districts from Locations on every run.

// pc (string) -> { district (int >= 1), dmName } — stores with no usable district
// (blank / 0 = Unassigned) are left out, so a job keeps its own value for them.
export function districtMapFromStores(stores) {
  const m = new Map();
  for (const s of (Array.isArray(stores) ? stores : [])) {
    if (!s || s.pc == null || s.pc === '') continue;
    const d = Number(s.district);
    if (!Number.isInteger(d) || d < 1) continue;
    m.set(String(s.pc), { district: d, dmName: s.dmName || '' });
  }
  return m;
}

// Rewrites `district` IN PLACE on each store in `list` from the Locations map, so
// every module holding the same store objects sees it. A store that already has
// a `dmName` field gets the Locations DM name too. Returns how many moved.
// districtMap null (Locations unavailable) = change nothing.
export function applyDistricts(list, districtMap) {
  if (!districtMap || !Array.isArray(list)) return 0;
  let moved = 0;
  for (const s of list) {
    if (!s) continue;
    const live = districtMap.get(String(s.pc));
    if (!live) continue;
    if (Number(s.district) !== live.district) { s.district = live.district; moved++; }
    if ('dmName' in s && live.dmName) s.dmName = live.dmName;
  }
  return moved;
}

// The districts that actually have stores, sorted (v22.21). Replaces hard-coded
// 1..8 loops so a new district (e.g. District 9, added 2026-10-26) shows up in
// screens, DM briefs, P&L and weather with no code change.
export function districtNumbers(stores) {
  const set = new Set();
  for (const s of (Array.isArray(stores) ? stores : [])) {
    const d = Number(s && s.district);
    if (Number.isInteger(d) && d >= 1) set.add(d);
  }
  return [...set].sort((a, b) => a - b);
}

// Weather coordinates per district: the preset ones, plus — for any district with
// no preset — the middle point of its own stores (storeCoords: pc -> { lat, lng }).
export function districtCoords(stores, preset, storeCoords) {
  const out = { ...(preset || {}) };
  for (const d of districtNumbers(stores)) {
    if (out[d]) continue;
    const pts = stores.filter(s => Number(s.district) === d).map(s => storeCoords && storeCoords[String(s.pc)]).filter(Boolean);
    if (!pts.length) continue;
    const avg = (k) => Math.round((pts.reduce((a, p) => a + Number(p[k]), 0) / pts.length) * 1000) / 1000;
    out[d] = { lat: avg('lat'), lon: avg('lng') };
  }
  return out;
}

// `list` = any store-shaped array with a pc. statusMap null/undefined (statuses
// unavailable) = fail OPEN: keep every store rather than silently dropping all.
export function activeSubset(list, statusMap, onIso, graceDays = 0) {
  const all = Array.isArray(list) ? list : [];
  if (!statusMap) return all.slice();
  return all.filter(s => !isClosedOn(statusMap.get(String(s.pc)), onIso, graceDays));
}
