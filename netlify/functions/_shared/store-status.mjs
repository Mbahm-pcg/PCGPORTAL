// _shared/store-status.mjs — server side of src/store-status.mjs (v22.0).
//
// Every scheduled job used to loop over its own hard-coded store list, none of
// which knew a store had closed. This reads the real Locations data (blob
// pcg_stores_v1 — the list the Locations tab edits) and trims a job's list down
// to stores that aren't permanently closed.
//
// v22.12: it also applies each store's DISTRICT (and DM name) from Locations onto
// the job's list, in place — so moving a store to another DM in Locations moves its
// alerts/briefs/scoping too, with no code change. Jobs that don't trim their list
// call syncDistricts(list) instead.
//
// refreshStoreList(target, all, opts) rewrites `target` IN PLACE from `all`, so
// every module that imported `target` (e.g. labor-cron's STORES) sees the trimmed
// list for this invocation. Call it at the top of each handler. Fails OPEN: if
// the blob can't be read, the full list is kept (never "drop every store").
import { getStore } from '@netlify/blobs';
import { activeSubset, statusMapFromStores, isClosedOn, districtMapFromStores, applyDistricts } from '../../../src/store-status.mjs';

const CACHE_MS = 2 * 60 * 1000;
let cache = { at: 0, map: null, districts: null };

export function todayET() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;
}

export async function loadStoreStatuses() {
  if (cache.map && Date.now() - cache.at < CACHE_MS) return cache.map;
  try {
    const store = getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
    const raw = await store.get('pcg_stores_v1', { type: 'json' });
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : null);
    if (!list || !list.length) return null;
    cache = { at: Date.now(), map: statusMapFromStores(list), districts: districtMapFromStores(list) };
    return cache.map;
  } catch (e) {
    console.warn('[store-status] could not read pcg_stores_v1 — keeping full store lists:', e.message);
    return null;
  }
}

// pc -> { district, dmName } from Locations, or null if it can't be read (fail open:
// callers then keep their own districts).
export async function loadStoreDistricts() {
  const map = await loadStoreStatuses();
  return map ? cache.districts : null;
}

// Overwrite each list's districts from Locations, in place. Safe to call every run.
export async function syncDistricts(...lists) {
  const districts = await loadStoreDistricts();
  let moved = 0;
  for (const list of lists) moved += applyDistricts(list, districts);
  return moved;
}

// graceDays: 14 for payroll/tips/hours jobs so a store's final pay period finishes.
export async function refreshStoreList(target, all, { onDate, graceDays = 0 } = {}) {
  const map = await loadStoreStatuses();
  if (map) applyDistricts(all, cache.districts);
  const next = activeSubset(all, map, onDate || todayET(), graceDays);
  target.length = 0;
  target.push(...next);
  const removed = all.length - next.length;
  if (removed > 0) console.log(`[store-status] skipping ${removed} permanently closed store(s)`);
  return target;
}

// Set of pc strings closed as of the date — for code that keys stores by pc.
export async function closedPcSet({ onDate, graceDays = 0 } = {}) {
  const map = await loadStoreStatuses();
  const out = new Set();
  if (!map) return out;
  const day = onDate || todayET();
  for (const [pc, rec] of map) if (isClosedOn(rec, day, graceDays)) out.add(pc);
  return out;
}
