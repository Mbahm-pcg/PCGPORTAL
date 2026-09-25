// labor-cron-8200.mjs — fills the labor-cron overnight gap for store "8200" only.
//
// labor-cron.mjs's schedule (0 9-23,0-3 * * *, UTC) has a genuine gap at UTC 4-8 — ET
// midnight-4am — where nothing runs for ANY store. That's correct for every store except
// this one: "8200" (pc 364412, district 7) is open 24 hours, so its labor data would
// otherwise go stale for those ~5 hours every single night while every other (closed)
// store correctly has no data pulled.
//
// Reuses labor-cron.mjs's exact per-store processing and blob-save shape (same
// processStore(), same pcg_labor_store_{pc} merge/save) so this fills in the SAME blob
// everything else (dashboard, system-health) already reads — no other changes needed.
// Deliberately scoped to labor only, not per-store P&L (pcg_pnl_store_{pc}) — that's a
// more involved computation tied to the main handler's own P&L step and wasn't part of
// what was asked for.
import { STORES, processStore, fetchLatestBusDt, todayET, getLaborStore, mergeStoreBlob, weekStart } from './labor-cron.mjs';

export const config = { schedule: '0 4-8 * * *' }; // UTC 4-8 = ET midnight-4am, the current gap

const STORE_8200_PC = '364412';

export default async () => {
  const headers = { 'Content-Type': 'application/json' };
  const store = STORES.find(s => s.pc === STORE_8200_PC);
  if (!store) {
    console.error('[labor-cron-8200] store not found in STORES —', STORE_8200_PC);
    return new Response(JSON.stringify({ ok: false, error: 'store not found' }), { status: 500, headers });
  }

  let busDt = await fetchLatestBusDt(store.pc);
  if (!busDt) busDt = todayET();

  try {
    const result = await processStore(store, busDt, { skipSchedules: false });
    if (result.error) {
      console.warn('[labor-cron-8200] processStore error:', result.error);
      return new Response(JSON.stringify({ ok: false, error: result.error }), { status: 200, headers });
    }

    // Safety guard (same as labor-refresh.mjs's scoped single-store path): never overwrite
    // good existing data with zeros. A slow/failed Paycor response during these overnight
    // hours must never look like "the store had zero labor/sales" — that's exactly the
    // kind of false reading that would make an actually-open 24-hour store look closed.
    const hasNewData = result.today.sales > 0 || result.today.laborDollars > 0;
    if (!hasNewData) {
      console.warn('[labor-cron-8200] zero data from Paycor for', store.name, '— keeping existing blob');
      return new Response(JSON.stringify({ ok: true, store: store.pc, busDt, skipped: true, reason: 'zero data from Paycor' }), { status: 200, headers });
    }

    const blobStore = getLaborStore();
    const key = `pcg_labor_store_${store.pc}`;
    let existing = null;
    try { const raw = await blobStore.get(key, { type: 'json' }); existing = raw?.data || raw; } catch {}
    const weekOfStr = weekStart(busDt);
    const dailyEntry = {
      date: busDt, laborDollars: result.today.laborDollars, sales: result.today.sales,
      laborPct: result.today.laborPct, hoursWorked: result.today.hoursWorked, employees: result.employeeDetails,
    };
    const weeklyEntry = {
      weekOf: weekOfStr, laborDollars: result.wtd.laborDollars, sales: result.wtd.sales,
      laborPct: result.wtd.laborPct, avgDailyEmployees: result.today.employees,
    };
    const merged = mergeStoreBlob(existing, dailyEntry, weeklyEntry);
    await blobStore.setJSON(key, { savedAt: new Date().toISOString(), data: merged });

    console.log('[labor-cron-8200] updated', store.name, busDt, 'laborPct:', result.today.laborPct);
    return new Response(JSON.stringify({ ok: true, store: store.pc, busDt, laborPct: result.today.laborPct }), { status: 200, headers });
  } catch (e) {
    console.error('[labor-cron-8200] failed:', e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 500, headers });
  }
};
