// pulse-compare-cron.mjs — pre-caches every store's "today so far" Pulse data
// (sales, guest checks, hourly buckets, voids, refunds, gross/discounts/net) into the
// pcg_pulse_today_v1 blob every ~30 min during business hours. The Orion analyst's DM
// comparison engine (buildPulseComparisonContext) reads this blob so the chat path makes
// ZERO live Pulse calls — mirroring how labor-cron writes pcg_labor_v1 for the KPI snapshot.
// Skips overnight hours (stores closed) to avoid pointless POS load.

import { STORES, getStoreToday, todayET } from './analyst-lib/analyst-data.mjs';
import { cacheSave } from './analyst-lib/analyst-cache.mjs';

export const config = { schedule: '*/30 * * * *' };

// Run getStoreToday across all stores with bounded concurrency (don't fire 45 at once).
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export default async () => {
  // ET business-hours guard — Dunkin opens ~5am; skip before 4am ET to avoid empty churn.
  let etHour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  if (etHour === 24) etHour = 0;
  if (etHour < 4) return new Response('skipped (overnight ET)');

  const busDt = todayET();
  const pairs = await mapLimit(STORES, 8, async (s) => {
    try { return [s.pc, await getStoreToday(s.pc, busDt)]; }
    catch (e) { console.warn(`[pulse-compare-cron] ${s.pc} failed: ${e.message}`); return [s.pc, null]; }
  });

  const stores = {};
  let ok = 0;
  for (const [pc, data] of pairs) { if (data) { stores[pc] = data; ok++; } }

  await cacheSave('pcg_pulse_today_v1', { busDt, asOf: new Date().toISOString(), stores });
  return new Response(`pulse-compare-cron: cached ${ok}/${STORES.length} stores for ${busDt}`);
};
