// Scoped single-store live labor refresh — called directly from the client
// (manager mobile dashboard tile, Pulse's Labor sub-tab). This used to be a
// branch inside labor-cron.mjs, but labor-cron.mjs declares `config.schedule`,
// and Netlify's edge blocks ALL direct external POSTs to any function with a
// schedule config — even POSTs meant for a different, manual-only branch of
// that same handler. That silently broke this feature the whole time (calls
// always 403'd at the edge, before even reaching the function; the client's
// try/catch swallowed it). Moving the scoped logic to its own unscheduled
// function fixes that, reusing labor-cron.mjs's exported helpers so the
// calculation itself stays identical to the network-wide cron.
import { STORES, processStore, getLaborStore, mergeStoreBlob, weekStart, fetchLatestBusDt, todayET, fetchLiveClockIn } from './labor-cron.mjs';

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const body = await request.json().catch(() => ({}));
  const scopedPC = body?.storePC || null;
  if (!scopedPC) return new Response(JSON.stringify({ error: 'storePC required' }), { status: 400, headers });

  const storeConfig = STORES.find(s => String(s.pc) === String(scopedPC));
  if (!storeConfig) return new Response(JSON.stringify({ error: `Store ${scopedPC} not found` }), { status: 404, headers });

  console.log('[labor-refresh] scoped refresh for store', scopedPC, storeConfig.name);
  try {
    const busDt = await fetchLatestBusDt(scopedPC).catch(() => todayET());
    const result = await processStore(storeConfig, busDt, { skipSchedules: false });
    if (result.error) return new Response(JSON.stringify({ error: result.error }), { status: 500, headers });

    // Safety guard: never overwrite good existing data with zeros.
    // If Paycor returned no punches (e.g. slow API), keep the old blob intact.
    const hasNewData = result.today.sales > 0 || result.today.laborDollars > 0;
    if (!hasNewData) {
      console.warn('[labor-refresh] scoped refresh returned zero data for', scopedPC, '— keeping existing blob');
      return new Response(JSON.stringify({ ok: true, store: scopedPC, busDt, skipped: true, reason: 'zero data from Paycor' }), { status: 200, headers });
    }

    // True "currently clocked in right now" status — distinct from employeesOnClock
    // (which means "worked at all today", even if already punched out). Only
    // employees processStore found hours for today can possibly still be open,
    // so this stays a small batch of live Paycor lookups — safe for the 26s cap
    // since this scoped path only ever covers one store's roster.
    //
    // Per-employee results are kept (clockInStatus), not just counted — the
    // client (LaborDrillDown, app.jsx) used to re-fetch this same live status
    // itself via its own separate per-employee employeePunches loop, right
    // after calling this endpoint, because this response used to discard
    // exactly the data it needed down to a bare count. Returning the map lets
    // the client skip re-checking anyone already resolved here.
    //
    // processStore's own liveClockInStatus (labor-cron.mjs) already answered
    // this exact question, moments earlier, for anyone whose hoursToday came
    // from its needsLiveCheck estimate — every one of those employees now has
    // hoursToday > 0 (that's what the estimate is for), so without reusing
    // that result here, this loop was calling fetchLiveClockIn a SECOND time
    // for the same employee, same day, same purpose. Confirmed live in
    // production (2026-09-02) as the dominant remaining cost after the
    // Promise.all parallelization further down this file's history — still
    // 11-21s per store with the duplicate check, vs. 2-4s without it.
    const activeEmpIds = (result.employeeDetails || []).filter(e => e.hoursToday > 0).map(e => e.employeeId);
    const alreadyChecked = result.liveClockInStatus || {};
    let currentlyClockedIn = 0;
    const clockInStatus = {};
    const stillNeedsCheck = [];
    for (const id of activeEmpIds) {
      if (Object.prototype.hasOwnProperty.call(alreadyChecked, id)) {
        const lastPunchTime = alreadyChecked[id];
        clockInStatus[id] = { isClockedIn: !!lastPunchTime, lastPunchTime: lastPunchTime || null };
        if (lastPunchTime) currentlyClockedIn++;
      } else {
        stillNeedsCheck.push(id);
      }
    }
    for (let i = 0; i < stillNeedsCheck.length; i += 5) {
      const batch = stillNeedsCheck.slice(i, i + 5);
      const checks = await Promise.all(batch.map(id => fetchLiveClockIn(id, busDt)));
      batch.forEach((id, idx) => {
        const lastPunchTime = checks[idx];
        clockInStatus[id] = { isClockedIn: !!lastPunchTime, lastPunchTime: lastPunchTime || null };
      });
      currentlyClockedIn += checks.filter(Boolean).length;
    }

    const blobStore = getLaborStore();
    const weekOfStr = weekStart(busDt);
    const key = `pcg_labor_store_${scopedPC}`;
    let existing = null;
    try { const raw = await blobStore.get(key, { type: 'json' }); existing = raw?.data || raw; } catch {}

    const dailyEntry = { date: busDt, laborDollars: result.today.laborDollars, sales: result.today.sales, laborPct: result.today.laborPct, hoursWorked: result.today.hoursWorked, employees: result.employeeDetails, currentlyClockedIn };
    const weeklyEntry = { weekOf: weekOfStr, laborDollars: result.wtd.laborDollars, sales: result.wtd.sales, laborPct: result.wtd.laborPct, avgDailyEmployees: result.today.employees };
    const merged = mergeStoreBlob(existing, dailyEntry, weeklyEntry);
    await blobStore.setJSON(key, { savedAt: new Date().toISOString(), data: merged });

    // NOTE: Do NOT patch pcg_labor_v1 here — that blob is owned by the full cron.
    // Patching it from a scoped refresh can overwrite valid network totals with partial data.
    // The full cron will pick up this store's fresh data on its next scheduled run.

    console.log('[labor-refresh] scoped refresh complete for', scopedPC, '— labor', result.today.laborPct?.toFixed(1), '% sales $', Math.round(result.today.sales));
    return new Response(JSON.stringify({ ok: true, store: scopedPC, busDt, laborPct: result.today.laborPct, laborDollars: result.today.laborDollars, sales: result.today.sales, currentlyClockedIn, clockInStatus }), { status: 200, headers });
  } catch (e) {
    console.error('[labor-refresh] scoped refresh error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};
