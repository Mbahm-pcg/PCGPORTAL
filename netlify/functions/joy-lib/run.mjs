// joy-lib/run.mjs — Joy in Childhood leaderboard data (v22.75).
//
// Each store's $1 Joy in Childhood donations are Pulse service charge #1010 ("$1 JICF Donation",
// confirmed 2026-11-06 / 2026-11-11). getServiceChargeDailyTotals gives the day's count per store.
// This job keeps pcg_joy_daily_v1 = { days: { 'YYYY-MM-DD': { [pc]: { cnt, ttl } } }, updatedAt }
// for a rolling window of the last WINDOW_DAYS days — the card shows one day at a time and the
// user steps back and forth through it (user, 2026-11-11: no campaign dates to set).
// Each run re-pulls today and yesterday (late closes), plus any day in the window not pulled yet.
import { getStore } from '@netlify/blobs';
import { STORES, ALL_STORES, APIS, callUpstream } from '../tips-report-cron-background.mjs';
import { syncDistricts } from '../_shared/store-status.mjs';

export const JOY_SVC_NUM = 1010;
export const DAILY_KEY = 'pcg_joy_daily_v1';
export const WINDOW_DAYS = 100; // covers this month and the two before it (Month view)
const MAX_NEW_DAYS_PER_RUN = 20;

export const joyBlobs = () => getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
export async function loadJSON(key) {
  const raw = await joyBlobs().get(key, { type: 'json' }).catch(() => null);
  return raw && raw.data !== undefined ? raw.data : raw;
}
export const saveJSON = (key, data) => joyBlobs().setJSON(key, { savedAt: new Date().toISOString(), data });

export const etToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const windowStart = (today = etToday()) => addDays(today, -(WINDOW_DAYS - 1));

// One store, one day → { cnt, ttl } of #1010, or null if Pulse gave no real answer.
export async function storeDayJoy(s, busDt) {
  try {
    const cfg = APIS[String(s.pc) === '345986' ? 'p227' : 'p228'];
    const raw = await callUpstream(cfg, 'getServiceChargeDailyTotals', { locRef: String(s.pc), busDt });
    const j = JSON.parse(raw || '{}');
    // An empty / error answer is "no data", never "0 donations" (Willits' route returned an empty
    // body for every report on 2026-11-11). A real day always carries revenueCenters.
    if (!Array.isArray(j.revenueCenters)) return null;
    let cnt = 0, ttl = 0;
    for (const rvc of j.revenueCenters) for (const sc of rvc.serviceCharges || []) {
      if (Number(sc.svcNum) === JOY_SVC_NUM) { cnt += Number(sc.cnt) || 0; ttl += Number(sc.ttl) || 0; }
    }
    return { cnt, ttl: Math.round(ttl * 100) / 100 };
  } catch (e) {
    console.error(`[joy] ${s.name} ${busDt}:`, e.message);
    return null;
  }
}

export async function runJoy({ log = console.log } = {}) {
  await syncDistricts(STORES, ALL_STORES);
  const today = etToday();
  const first = windowStart(today);
  const data = (await loadJSON(DAILY_KEY)) || { days: {} };
  data.days = data.days || {};
  for (const d of Object.keys(data.days)) if (d < first || d > today) delete data.days[d];
  // Today and yesterday every run; then the most recent days not pulled yet (newest first).
  const missing = [];
  for (let d = addDays(today, -2); d >= first && missing.length < MAX_NEW_DAYS_PER_RUN; d = addDays(d, -1)) if (!data.days[d]) missing.push(d);
  const todo = [today, addDays(today, -1), ...missing];
  let calls = 0, failed = 0;
  for (const d of todo) {
    const next = { ...(data.days[d] || {}) };
    const queue = [...STORES];
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let s; (s = queue.shift());) {
        calls++;
        const r = await storeDayJoy(s, d);
        if (r) next[String(s.pc)] = r; else failed++; // a failed store keeps its last good number
      }
    }));
    data.days[d] = next;
  }
  data.updatedAt = new Date().toISOString();
  await saveJSON(DAILY_KEY, data);
  log(`[joy] refreshed ${todo.length} day(s) (${todo[todo.length - 1]}…${today}), ${calls} store-days, ${failed} without data`);
  return { ok: true, days: todo.length, calls, failed };
}
