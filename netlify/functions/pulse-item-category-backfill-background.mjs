// pulse-item-category-backfill-background.mjs — one-time (manual) backfill of the
// `categories` field onto existing pcg_item_history_{pc} entries, so Sales-Mix
// Intelligence has day-of-week baselines immediately instead of waiting weeks for the
// nightly snapshot to accrue them. Background function (15-min timeout). Idempotent:
// only fills entries that don't already have categories. Auth via MIGRATION_SECRET.
//
// Trigger: POST { token: <MIGRATION_SECRET>, days?: 70, batch?: 8 }
import { cacheLoad, cacheSave } from './analyst-lib/analyst-cache.mjs';
import { STORES, apiRoute, buildItemGroupMap, fetchItemCategories } from './pulse-hourly-snapshot.mjs';

export const config = { background: true };

const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { 'Content-Type': 'application/json' } });

export default async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'POST only' });
  const body = await request.json().catch(() => ({}));
  const secret = process.env.MIGRATION_SECRET;
  if (!secret || body.token !== secret) return json(401, { error: 'unauthorized' });

  const days = Math.min(Math.max(Number(body.days) || 70, 1), 120);
  const batchSize = Math.min(Math.max(Number(body.batch) || 8, 1), 12);

  // Build the item→category map once per Pulse route (menu-item numbers are per-route).
  const routeGroup = {};
  for (const route of [...new Set(STORES.map(s => apiRoute(s.pc)))]) {
    const rep = STORES.find(s => apiRoute(s.pc) === route);
    routeGroup[route] = await buildItemGroupMap(rep.pc);
  }

  let storesTouched = 0, entriesFilled = 0, storesSkipped = 0;

  const runStore = async (store) => {
    const key = `pcg_item_history_${store.pc}`;
    let hist;
    try { hist = await cacheLoad(key); } catch { hist = null; }
    if (!Array.isArray(hist) || !hist.length) { storesSkipped++; return; }
    const groupMap = routeGroup[apiRoute(store.pc)];
    if (!groupMap || groupMap.size === 0) { storesSkipped++; return; }

    let changed = false;
    // Oldest-relevant window only; entries are newest-first, so the first `days` cover it.
    for (const e of hist.slice(0, days)) {
      if (!e || !e.date || e.categories) continue; // skip already-filled (idempotent)
      const cats = await fetchItemCategories(store.pc, e.date, groupMap);
      if (cats) { e.categories = cats; entriesFilled++; changed = true; }
    }
    if (changed) await cacheSave(key, hist);
    storesTouched++;
  };

  // Process stores in bounded-concurrency batches to respect Pulse rate limits.
  for (let i = 0; i < STORES.length; i += batchSize) {
    await Promise.all(STORES.slice(i, i + batchSize).map(runStore));
  }

  console.log(`[item-cat-backfill] stores=${storesTouched} filled=${entriesFilled} skipped=${storesSkipped} (days=${days})`);
  return json(200, { ok: true, storesTouched, entriesFilled, storesSkipped, days });
};
