// terminations-lib/run.mjs — Terminations report sync (v22.33). Shared by the daily cron
// (terminations-sync-cron-background.mjs) and the exec/IT "Sync now" twin
// (terminations-sync-background.mjs). Reads each open store's Paycor roster
// (employees?include=All, the same paged call the tips report uses — read-only, never
// identifyingData) and keeps one small row per person who is no longer employed:
// name, job title, hire date, termination date, store. Saved to one blob,
// pcg_terminations_v1; terminations-report.mjs scopes it per caller.
//
// A store that fails keeps its rows from the previous run (marked stale in `stores`)
// rather than dropping to zero, so a Paycor hiccup never reads as "nobody left".
import { getStore } from '@netlify/blobs';
import { STORES, ALL_STORES, fetchAllEmployees } from '../tips-report-cron-background.mjs';
import { refreshStoreList } from '../_shared/store-status.mjs';
import { extractTermination } from '../../../src/terminations.mjs';

export const TERMINATIONS_KEY = 'pcg_terminations_v1';
const blobs = () => getStore({ name: 'pcg-portal', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });

export async function loadTerminations() {
  try {
    const w = await blobs().get(TERMINATIONS_KEY, { type: 'json' });
    return (w && w.data) || null;
  } catch { return null; }
}

export async function runTerminationsSync({ trigger = 'cron' } = {}) {
  const startedAt = new Date().toISOString();
  // Closed stores' people still left the company in that period, so keep the store in the
  // sync for a long grace window; the report labels it by name either way.
  await refreshStoreList(STORES, ALL_STORES, { graceDays: 400 });
  const prev = await loadTerminations();
  const prevByPc = new Map();
  for (const r of prev?.rows || []) {
    if (!prevByPc.has(r.pc)) prevByPc.set(r.pc, []);
    prevByPc.get(r.pc).push(r);
  }

  const rows = [];
  const stores = [];
  // Field names (never values) seen on non-active records — lets us confirm where Paycor
  // actually puts the termination date without logging anyone's data.
  const fieldKeys = new Set();
  const queue = [...STORES];
  const worker = async () => {
    while (queue.length) {
      const store = queue.shift();
      try {
        const employees = await fetchAllEmployees(store.paycor);
        let n = 0, inactiveNoDate = 0;
        for (const e of employees) {
          const st = String(e?.statusData?.status || '');
          if (st && !/^active$/i.test(st)) {
            for (const k of Object.keys(e.employmentDateData || {})) fieldKeys.add(`employmentDateData.${k}`);
            for (const k of Object.keys(e.statusData || {})) fieldKeys.add(`statusData.${k}`);
          }
          const t = extractTermination(e, store.pc);
          if (t) { rows.push(t); n++; } else if (st && !/^active$/i.test(st) && !/leave/i.test(st)) inactiveNoDate++;
        }
        stores.push({ pc: String(store.pc), ok: true, count: n, inactiveNoDate });
      } catch (err) {
        console.warn('[terminations-sync] store failed:', store.pc, err.message);
        const kept = prevByPc.get(String(store.pc)) || [];
        rows.push(...kept);
        stores.push({ pc: String(store.pc), ok: false, stale: kept.length > 0, count: kept.length, error: err.message });
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);

  // One person can appear under two legal entities after a transfer — keep one row per id+date.
  const seen = new Set();
  const deduped = rows.filter(r => { const k = `${r.id}|${r.terminationDate}`; if (seen.has(k)) return false; seen.add(k); return true; });

  const data = {
    syncedAt: new Date().toISOString(), startedAt, trigger,
    rows: deduped,
    stores: stores.sort((a, b) => a.pc.localeCompare(b.pc)),
    fieldKeys: [...fieldKeys].sort(),
  };
  await blobs().setJSON(TERMINATIONS_KEY, { savedAt: data.syncedAt, data });
  const failed = stores.filter(s => !s.ok).length;
  return { rows: deduped.length, stores: stores.length, failed, fieldKeys: data.fieldKeys };
}
