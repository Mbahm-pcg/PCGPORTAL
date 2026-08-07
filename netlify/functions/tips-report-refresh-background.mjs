// Manual backfill for a single date's tips snapshot — for when the nightly
// tips-report-cron-background run failed/timed out for a specific day and
// nobody caught it. That function itself already supports POST {busDt} for
// exactly this, but it declares config.schedule, and Netlify's edge blocks
// ALL direct external POSTs to any scheduled function (same issue already
// solved for labor-cron.mjs / labor-refresh.mjs) — so this unscheduled sibling
// exists purely to make that manual path reachable. Reuses the exact same
// Phase 1 (Pulse tips) + Phase 2 (Paycor punches) logic via shared exports;
// does NOT send the daily/weekly/biweekly email — this only rebuilds and
// saves the one day's pcg_tips_snapshot_{busDt} blob so it's available to the
// nightly cron's own weekly/biweekly rollups and to the in-app Tips Report.
import { STORES, APIS, callUpstream, callPaycorProxy, fetchAllEmployees, punchHours, toET, saveDaySnapshot, getBlobStore, dateRangeEndingAt } from './tips-report-cron-background.mjs';

// 46 stores sequential (Phase 2) takes minutes — well past Netlify's ~26s
// synchronous function limit. Must be a background function (202 immediately,
// no body); caller polls pcg_tips_snapshot_{busDt} via storage.mjs afterward.
export const config = { background: true };

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const body = await request.json().catch(() => ({}));
  const busDt = body?.busDt;
  if (!busDt || !/^\d{4}-\d{2}-\d{2}$/.test(busDt)) {
    return new Response(JSON.stringify({ error: 'busDt required, format YYYY-MM-DD' }), { status: 400, headers });
  }

  console.log(`[tips-report-refresh] backfilling ${busDt} across ${STORES.length} stores`);
  const storeResults = new Array(STORES.length);

  // Phase 1: Pulse tip totals — batched, no shared auth state.
  const BATCH = 6;
  for (let i = 0; i < STORES.length; i += BATCH) {
    const batch = STORES.slice(i, i + BATCH);
    await Promise.all(batch.map(async (s, j) => {
      const idx = i + j;
      const cfg = APIS[s.pc === '345986' ? 'p227' : 'p228'];
      let rows = [], tipPool = 0, checksStatus = 'error';
      try {
        const checksRaw = await callUpstream(cfg, 'getGuestChecks', { locRef: s.pc, opnBusDt: busDt, clsdGuestChecksOnly: true, include: 'guestChecks' });
        const data = JSON.parse(checksRaw || '{}');
        const checks = Array.isArray(data.guestChecks) ? data.guestChecks : [];
        rows = checks
          .filter(c => (c.tipTotal || 0) > 0)
          .map(c => ({ chkNum: c.chkNum, time: c.clsdUTC ? toET(c.clsdUTC) : (c.opnUTC ? toET(c.opnUTC) : '--'), tip: c.tipTotal }))
          .sort((a, b) => a.time.localeCompare(b.time));
        tipPool = checks.reduce((sum, c) => sum + (c.tipTotal || 0), 0);
        checksStatus = 'ok';
      } catch (err) {
        console.error(`[tips-report-refresh] ${s.name} checks error:`, err.message);
      }
      storeResults[idx] = { pc: s.pc, name: s.name, district: s.district, status: checksStatus, crewStatus: 'error', rows, tipPool, crew: [] };
    }));
  }

  // Phase 2: Paycor punches/employees — sequential, same reasoning as the
  // scheduled cron (concurrent calls race the same refresh token).
  for (let idx = 0; idx < STORES.length; idx++) {
    const s = STORES[idx];
    let crew = [], crewStatus = 'error';
    try {
      const [punchesRaw, empList] = await Promise.all([
        callPaycorProxy('punches', { legalEntityId: s.paycor, startDate: busDt, endDate: busDt }),
        fetchAllEmployees(s.paycor),
      ]);
      const punchData = JSON.parse(punchesRaw || '{}');
      const punches = Array.isArray(punchData.records) ? punchData.records : (Array.isArray(punchData) ? punchData : []);
      const empByGuid = {};
      empList.forEach(e => { if (e && e.id) empByGuid[e.id] = e; });

      const hoursByGuid = {};
      punches.forEach(p => {
        if (!p.employeeId) return;
        hoursByGuid[p.employeeId] = (hoursByGuid[p.employeeId] || 0) + punchHours(p);
      });
      crew = Object.keys(hoursByGuid).map(guid => {
        const e = empByGuid[guid];
        const jobTitle = e?.positionData?.jobTitle || '';
        return {
          name: e ? `${(e.firstName || '').trim()} ${(e.lastName || '').trim()}`.trim() || 'Unnamed Employee' : `Unknown Employee (${guid.slice(0, 8)})`,
          payrollId: e?.employeeNumber || e?.alternateEmployeeNumber || '',
          hours: hoursByGuid[guid],
          isManager: /general\s*manager|store\s*manager/i.test(jobTitle) && !/assist|asst/i.test(jobTitle),
        };
      }).filter(c => !c.isManager && c.hours > 0);
      crewStatus = 'ok';
    } catch (err) {
      console.error(`[tips-report-refresh] ${s.name} crew error:`, err.message);
    }
    storeResults[idx].crew = crew;
    storeResults[idx].crewStatus = crewStatus;
  }

  await saveDaySnapshot(busDt, storeResults);
  const staleDate = dateRangeEndingAt(busDt, 40)[0];
  getBlobStore().delete(`pcg_tips_snapshot_${staleDate}`).catch(() => {});

  const storesWithTips = storeResults.filter(s => s.status === 'ok' && s.rows.length > 0).length;
  const grandTotal = storeResults.reduce((sum, s) => sum + s.rows.reduce((a, r) => a + r.tip, 0), 0);
  console.log(`[tips-report-refresh] done: ${busDt} — ${storesWithTips}/${STORES.length} stores had tips, $${grandTotal.toFixed(2)} total`);
  return new Response(JSON.stringify({ ok: true, busDt, storesWithTips, totalStores: STORES.length, grandTotal }), { status: 200, headers });
};
