// exec-lib/exec-data.mjs — one source of truth for the Executive view and the MCP
// executive tools (v22.18, 2026-10-25).
//
// Everything here reads what the crons already wrote (Netlify Blobs + Neon) and never
// calls Pulse or Paycor live, so a tab is one round trip of a second or two. The same
// builders feed `analyst.mjs` (action 'exec', for the page) and `mcp.mjs` (get_exec_*),
// so a number on the page and a number an agent reads are the same number.
//
// House rule carried through every sales figure: current, then vs last week, then vs
// last year — and a comparison is only made like for like (same hours, same days).
import { cacheLoad } from '../analyst-lib/analyst-cache.mjs';
import { sql } from '../_shared/db.mjs';

// ── small helpers ─────────────────────────────────────────────────────────────
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const pct = (num, den) => (den > 0 ? r1((num / den) * 100) : null);
const delta = (cur, prev) => (prev > 0 ? r1(((cur - prev) / prev) * 100) : null);
export function etNowDate() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
export function ymdOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function addDaysYmd(ymd, n) { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return ymdOf(d); }
export function weekdayOfYmd(ymd) { return new Date(ymd + 'T12:00:00').getDay(); }
const sundayOf = (ymd) => addDaysYmd(ymd, -weekdayOfYmd(ymd));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function worker() { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function cumThroughHour(entry, hour) {
  let sales = 0, checks = 0;
  for (const h of (entry?.hours || [])) { if (h.h <= hour) { sales += h.sales || 0; checks += h.checks || 0; } }
  return { sales: r2(sales), checks };
}

function isTestRecord(name) { return /^\s*test\b/i.test(String(name || '')); }

/**
 * Build the executive data builders over injectable loaders (tests pass fakes; the
 * portal and MCP use the defaults: Netlify Blobs via cacheLoad and Neon via sql()).
 */
export function createExecData({ load = cacheLoad, dbFactory = sql } = {}) {
// Locations (pcg_stores_v1) → pc → { name, city, district, dmName, status, isNextGen, isBridge, baseAsset }
async function loadStoreDirectory() {
  const list = await load('pcg_stores_v1').catch(() => null);
  const map = new Map();
  for (const s of (Array.isArray(list) ? list : [])) {
    if (s?.pc == null || s.pc === '') continue;
    map.set(String(s.pc), {
      pc: String(s.pc), name: s.name || String(s.pc), city: s.city || '', district: Number(s.district) || null,
      dmName: s.dmName || '', status: s.status || 'Open', isNextGen: !!s.isNextGen, isBridge: !!s.isBridge,
      isBaskin: !!s.isBaskin, baseAsset: s.baseAsset || '', mgr: s.mgr || '',
    });
  }
  return map;
}


// ── Today ─────────────────────────────────────────────────────────────────────
// Sources: pcg_labor_v1 (net sales + labor today, per store, hourly), pcg_pulse_today_v1
// (guests, discounts, hourly buckets, every 30 min), pcg_labor_store_{pc}.daily (30 days of
// net sales, for Sunday-start WTD and last week's same days), pcg_hourly_history_{pc}
// (hourly guest-check history, for "same time last week").
async function execToday({ laborThresholdPct = 23 } = {}) {
  const [labor, todayBlob, dir] = await Promise.all([
    load('pcg_labor_v1'), load('pcg_pulse_today_v1'), loadStoreDirectory(),
  ]);
  if (!labor?.stores) return { error: 'No labor data yet (labor-cron has not written pcg_labor_v1).' };
  const busDt = labor.busDt || ymdOf(etNowDate());
  const asOf = labor.lastUpdated || null;
  const hour = etNowDate().getHours();
  const completeHour = hour - 1;
  const sun = sundayOf(busDt);
  const lastSun = addDaysYmd(sun, -7);
  const lastWeekSameDay = addDaysYmd(busDt, -7);
  const todayFresh = !!todayBlob && todayBlob.busDt === busDt;

  const pcs = Object.keys(labor.stores);
  const extra = await mapLimit(pcs, 10, async (pc) => {
    const [storeBlob, hist] = await Promise.all([
      load(`pcg_labor_store_${pc}`).catch(() => null),
      load(`pcg_hourly_history_${pc}`).catch(() => null),
    ]);
    return { pc, daily: Array.isArray(storeBlob?.daily) ? storeBlob.daily : [], hist: Array.isArray(hist) ? hist : [] };
  });
  const extraByPc = Object.fromEntries(extra.map((e) => [e.pc, e]));

  const stores = [];
  for (const pc of pcs) {
    const s = labor.stores[pc]; if (!s || s.error) continue;
    const d = dir.get(String(pc)) || {};
    if (d.status && d.status === 'Permanently Closed') continue;
    const t = s.today || {}; const live = todayFresh ? todayBlob.stores?.[pc] : null;
    const { daily, hist } = extraByPc[pc] || { daily: [], hist: [] };
    const byDate = new Map(daily.filter((x) => x?.date).map((x) => [x.date, x]));
    // Sunday-start WTD from complete days + today (net sales, same source as Pulse's net)
    let wtdPrior = 0, lwSameDays = 0, matched = 0;
    for (let dt = sun; dt < busDt; dt = addDaysYmd(dt, 1)) {
      const cur = byDate.get(dt); const prev = byDate.get(addDaysYmd(dt, -7));
      if (cur) wtdPrior += Number(cur.sales) || 0;
      if (cur && prev) { lwSameDays += Number(prev.sales) || 0; matched++; }
    }
    const lwFull = byDate.get(lastWeekSameDay);
    // Same time last week (guest-check totals, through the last complete hour)
    const histByDate = new Map(hist.filter((x) => x?.date).map((x) => [x.date, x]));
    const lwEntry = histByDate.get(lastWeekSameDay);
    const lwSameTime = lwEntry && completeHour >= 5 ? cumThroughHour(lwEntry, completeHour) : null;
    const todaySameTime = live && completeHour >= 5 ? cumThroughHour(live, completeHour) : null;
    const guests = live?.ops?.guests ?? live?.checks ?? null;
    stores.push({
      pc: String(pc), name: s.name || d.name || String(pc), city: d.city || '', district: Number(s.district || d.district) || null,
      dmName: d.dmName || '', status: d.status || 'Open',
      sales: r2(t.sales), laborDollars: r2(t.laborDollars), laborPct: r1(t.laborPct),
      guests, avgCheck: guests > 0 ? r2((live?.ops?.net ?? t.sales) / guests) : null,
      discounts: live?.ops?.discounts != null ? r2(live.ops.discounts) : null,
      voids: live?.voids?.total != null ? r2(live.voids.total) : null,
      scheduledNow: t.scheduledNow || 0, onClock: t.employeesOnClock || 0, overtime: t.overtimeCount || 0,
      wtdSales: r2(wtdPrior + (Number(t.sales) || 0)),
      wtdLastWeekSameDays: (matched || lwFull) ? r2(lwSameDays + (lwFull ? Number(lwFull.sales) || 0 : 0)) : null,
      lastWeekSameDayFull: lwFull ? r2(lwFull.sales) : null,
      sameTime: todaySameTime && lwSameTime ? { today: todaySameTime.sales, lastWeek: lwSameTime.sales, throughHour: completeHour } : null,
      overThreshold: r1(t.laborPct) >= laborThresholdPct && (Number(t.sales) || 0) > 0,
    });
  }

  const sum = (f) => stores.reduce((a, s) => a + (Number(s[f]) || 0), 0);
  const sales = r2(sum('sales')); const laborDollars = r2(sum('laborDollars'));
  const guests = stores.some((s) => s.guests != null) ? stores.reduce((a, s) => a + (s.guests || 0), 0) : null;
  const stSales = stores.filter((s) => s.sameTime).reduce((a, s) => a + s.sameTime.today, 0);
  const stLW = stores.filter((s) => s.sameTime).reduce((a, s) => a + s.sameTime.lastWeek, 0);
  const wtd = r2(sum('wtdSales'));
  const wtdLW = stores.some((s) => s.wtdLastWeekSameDays != null) ? r2(stores.reduce((a, s) => a + (s.wtdLastWeekSameDays || 0), 0)) : null;

  // Districts (sales-weighted labor %)
  const byD = new Map();
  for (const s of stores) {
    const k = s.district || 0;
    const d = byD.get(k) || { district: k, dmName: s.dmName, stores: 0, sales: 0, laborDollars: 0, guests: 0, wtdSales: 0, wtdLastWeekSameDays: 0, overThreshold: 0 };
    d.stores++; d.sales += s.sales; d.laborDollars += s.laborDollars; d.guests += s.guests || 0;
    d.wtdSales += s.wtdSales; d.wtdLastWeekSameDays += s.wtdLastWeekSameDays || 0; if (s.overThreshold) d.overThreshold++;
    if (!d.dmName && s.dmName) d.dmName = s.dmName;
    byD.set(k, d);
  }
  const districts = [...byD.values()].sort((a, b) => a.district - b.district).map((d) => ({
    ...d, sales: r2(d.sales), laborDollars: r2(d.laborDollars), laborPct: pct(d.laborDollars, d.sales),
    avgCheck: d.guests > 0 ? r2(d.sales / d.guests) : null, wtdSales: r2(d.wtdSales),
    vsLastWeekWtdPct: delta(d.wtdSales, d.wtdLastWeekSameDays),
  }));

  return {
    busDt, asOf, throughHour: hour, laborThresholdPct,
    todayDataAsOf: todayFresh ? todayBlob.asOf : null,
    network: {
      sales, laborDollars, laborPct: pct(laborDollars, sales),
      guests, avgCheck: guests > 0 ? r2(sales / guests) : null,
      discounts: stores.some((s) => s.discounts != null) ? r2(sum('discounts')) : null,
      voids: stores.some((s) => s.voids != null) ? r2(sum('voids')) : null,
      scheduledNow: sum('scheduledNow'), onClock: sum('onClock'), overtime: sum('overtime'),
      storesReporting: stores.length,
      sameTimeLastWeek: stLW > 0 ? { today: r2(stSales), lastWeek: r2(stLW), pct: delta(stSales, stLW), throughHour: completeHour, basis: 'guest-check totals through the last complete hour, this day vs the same weekday last week' } : null,
      wtd: { sales: wtd, weekStart: sun, lastWeekSameDays: wtdLW, pct: wtdLW ? delta(wtd, wtdLW) : null, basis: 'Sunday-start week; today compared to the same weekday last week in full' },
      lastYear: null, // not held in any blob (history is 30/90 days); the Week tab carries vs LY from the weekly report
    },
    districts,
    stores: stores.sort((a, b) => b.sales - a.sales),
    laborWatch: stores.filter((s) => s.overThreshold).sort((a, b) => b.laborPct - a.laborPct),
  };
}

// ── Week (uploaded weekly report, pcg_sales_v1) ───────────────────────────────
async function execWeek({ weekIndex = 0 } = {}) {
  const [weeks, dir] = await Promise.all([load('pcg_sales_v1'), loadStoreDirectory()]);
  const list = Array.isArray(weeks) ? weeks : [];
  if (!list.length) return { error: 'No weekly report has been uploaded yet (Analytics > Upload Weekly Report).' };
  const idx = Math.max(0, Math.min(list.length - 1, Number(weekIndex) || 0));
  const w = list[idx];
  const stores = (w.stores || []).map((r) => {
    const d = dir.get(String(r.pc)) || {};
    const district = Number(r.district || d.district) || null;
    return {
      pc: String(r.pc), name: d.name || String(r.pc), city: d.city || '', district, dmName: d.dmName || '',
      sales: r2(r.lwSale), priorWeekSales: r2(r.pwSale), lastYearSales: r2(r.swly),
      vsPriorWeekPct: delta(r.lwSale, r.pwSale), vsLastYearPct: r.swly > 0 ? delta(r.lwSale, r.swly) : null,
      guests: Number(r.lwCC) || 0, priorWeekGuests: Number(r.pwCC) || 0,
      dcpPct: r1(r.dcpPct), bakeryPct: r1(r.donutsPct), laborPct: r1(r.laborPct), totalCostPct: r1(r.totalPct),
      forecast: r2(r.fcSale), targetPct: r1(r.targetPct),
    };
  });
  const sum = (f) => stores.reduce((a, s) => a + (Number(s[f]) || 0), 0);
  const avg = (f) => { const v = stores.map((s) => s[f]).filter((x) => x > 0); return v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const sales = r2(sum('sales')), pw = r2(sum('priorWeekSales'));
  const lyRows = stores.filter((s) => s.lastYearSales > 0);
  const ly = r2(lyRows.reduce((a, s) => a + s.lastYearSales, 0));
  const lySalesComparable = r2(lyRows.reduce((a, s) => a + s.sales, 0));
  const byD = new Map();
  for (const s of stores) {
    const k = s.district || 0;
    const d = byD.get(k) || { district: k, dmName: s.dmName, stores: 0, sales: 0, priorWeekSales: 0, lastYearSales: 0, lySales: 0, guests: 0, labor: [], dcp: [], total: [] };
    d.stores++; d.sales += s.sales; d.priorWeekSales += s.priorWeekSales; d.guests += s.guests;
    if (s.lastYearSales > 0) { d.lastYearSales += s.lastYearSales; d.lySales += s.sales; }
    if (s.laborPct > 0) d.labor.push(s.laborPct); if (s.dcpPct > 0) d.dcp.push(s.dcpPct); if (s.totalCostPct > 0) d.total.push(s.totalCostPct);
    if (!d.dmName && s.dmName) d.dmName = s.dmName;
    byD.set(k, d);
  }
  const mean = (a) => (a.length ? r1(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const districts = [...byD.values()].sort((a, b) => a.district - b.district).map((d) => ({
    district: d.district, dmName: d.dmName, stores: d.stores, sales: r2(d.sales), guests: d.guests,
    vsPriorWeekPct: delta(d.sales, d.priorWeekSales), vsLastYearPct: d.lastYearSales > 0 ? delta(d.lySales, d.lastYearSales) : null,
    laborPct: mean(d.labor), foodCostPct: mean(d.dcp), totalCostPct: mean(d.total),
  }));
  return {
    weekNum: w.weekNum, weekEnd: w.weekEnd, isDraft: !!w.isDraft, weeksAvailable: list.map((x, i) => ({ index: i, weekNum: x.weekNum, weekEnd: x.weekEnd })),
    network: {
      sales, vsPriorWeekPct: delta(sales, pw), vsPriorWeekDollars: r2(sales - pw),
      vsLastYearPct: ly > 0 ? delta(lySalesComparable, ly) : null, storesWithLastYear: lyRows.length,
      guests: sum('guests'), vsPriorWeekGuestsPct: delta(sum('guests'), sum('priorWeekGuests')),
      stores: stores.length, perStoreSales: stores.length ? r2(sales / stores.length) : null,
      laborPct: avg('laborPct'), foodCostPct: avg('dcpPct'), bakeryPct: avg('bakeryPct'), totalCostPct: avg('totalCostPct'),
      forecastNextWeek: r2(sum('forecast')),
    },
    districts,
    stores: stores.sort((a, b) => b.sales - a.sales),
    flagged: stores.filter((s) => s.totalCostPct >= 58 || s.laborPct >= 30).sort((a, b) => b.totalCostPct - a.totalCostPct),
    thresholds: { flagTotalCostPct: 58, flagLaborPct: 30 },
  };
}

// ── Districts & DMs ───────────────────────────────────────────────────────────
async function execDistricts() {
  const [scorecard, casesIndex, dir] = await Promise.all([
    load('pcg_dm_scorecard'), load('analyst/cases-index'), loadStoreDirectory(),
  ]);
  const hist = Array.isArray(scorecard) ? scorecard : [];
  const latest = hist[0] || null;
  const dmByDistrict = new Map();
  for (const s of dir.values()) if (s.district && s.dmName && !dmByDistrict.has(s.district)) dmByDistrict.set(s.district, s.dmName);
  const rows = latest ? Object.entries(latest.scores || {}).map(([d, s]) => ({
    district: Number(d), dmName: dmByDistrict.get(Number(d)) || '', rank: s.rank ?? null, score: s.composite ?? null,
    laborPct: s.avgLaborPct, salesGrowthPct: s.avgGrowthPct, dcpPct: s.avgDcpPct, responseMinutes: s.avgRespMin,
    openTickets: s.openTickets, ticketAgeDays: s.avgTicketAge, storeCount: s.storeCount,
    laborScore: s.laborScore, salesScore: s.salesScore, dcpScore: s.dcpScore, responseScore: s.responseScore, ticketScore: s.ticketScore,
  })).sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)) : [];
  const prev = hist[1] || null;
  if (prev) for (const r of rows) { const p = prev.scores?.[String(r.district)]; r.scoreChange = p?.composite != null && r.score != null ? r.score - p.composite : null; }
  const closed = new Set(['Done', 'Dismissed', 'Rejected', 'Closed']);
  const cases = (Array.isArray(casesIndex) ? casesIndex : []).filter((c) => !closed.has(c.status)).slice(0, 50).map((c) => ({
    id: c.id, title: c.title, status: c.status, severity: c.severity, type: c.anomalyType, storeName: c.storeName, district: c.district,
    dollarOpportunity: c.dollarOpportunity || 0, createdAt: c.createdAt, lastSeenAt: c.lastSeenAt || null, seenCount: c.seenCount || 1,
  }));
  return {
    scorecard: latest ? { weekOf: latest.weekOf, computedAt: latest.computedAt, basis: latest.basis || null, rows,
      weights: { labor: 0.25, sales: 0.25, dcp: 0.20, response: 0.15, tickets: 0.15 }, bands: { strong: 75, watch: 55 } } : null,
    openCases: cases,
  };
}

// ── Development & supply ──────────────────────────────────────────────────────
async function execDevelopment() {
  const [projects, dir] = await Promise.all([load('pcg_projects_v1'), loadStoreDirectory()]);
  const list = (Array.isArray(projects) ? projects : []).filter((p) => p && !isTestRecord(p.nickname || p.name));
  const today = ymdOf(etNowDate());
  const rows = list.map((p) => {
    const complete = !!p.completed || p.phaseOverride === 'complete';
    const due = p.dueDate ? String(p.dueDate).slice(0, 10) : null;
    const d = dir.get(String(p.pc)) || {};
    return {
      id: p.id, name: p.nickname || p.name || String(p.pc), pc: p.pc ? String(p.pc) : null, address: p.address || '', city: p.city || '',
      type: p.type || '', dueDate: due, complete, phaseOverride: p.phaseOverride || null, completionDate: p.completionDate || null,
      overdue: !complete && !!due && due < today, district: Number(p.district || d.district) || null, dmName: d.dmName || '',
      priority: p.priority ?? null, notes: p.notes || '',
    };
  });
  const counts = { total: rows.length, active: rows.filter((r) => !r.complete).length, complete: rows.filter((r) => r.complete).length,
    overdue: rows.filter((r) => r.overdue).length, noDueDate: rows.filter((r) => !r.complete && !r.dueDate).length };
  const byType = {}; for (const r of rows) byType[r.type || 'Other'] = (byType[r.type || 'Other'] || 0) + 1;

  // NDCP weekly spend, last 13 weeks, latest version of each order (DISTINCT ON order_number)
  let ndcp = { weeks: [], totals: null, error: null };
  try {
    const db = dbFactory();
    const rowsDb = await db`
      WITH latest AS (
        SELECT DISTINCT ON (order_number) order_number, account, total_order, email_date
        FROM ndcp_orders
        WHERE order_number IS NOT NULL AND email_date >= now() - interval '98 days'
        ORDER BY order_number, email_date DESC NULLS LAST)
      SELECT to_char(date_trunc('week', email_date + interval '1 day') - interval '1 day', 'YYYY-MM-DD') AS week_of,
             count(*)::int AS orders, round(sum(total_order)::numeric, 2) AS spend
      FROM latest GROUP BY 1 ORDER BY 1`;
    const revised = await db`SELECT count(*)::int AS n FROM (SELECT order_number FROM ndcp_orders WHERE order_number IS NOT NULL AND email_date >= now() - interval '98 days' GROUP BY order_number HAVING count(*) > 1) x`;
    ndcp.weeks = rowsDb.map((r) => ({ weekOf: r.week_of, orders: Number(r.orders), spend: Number(r.spend) }));
    const full = ndcp.weeks.slice(0, -1);
    ndcp.totals = {
      orders: ndcp.weeks.reduce((a, w) => a + w.orders, 0), spend: r2(ndcp.weeks.reduce((a, w) => a + w.spend, 0)),
      revisedOrders: Number(revised?.[0]?.n || 0), weeks: ndcp.weeks.length,
      avgFullWeekSpend: full.length ? r2(full.reduce((a, w) => a + w.spend, 0) / full.length) : null, fullWeeks: full.length,
      basis: 'Sunday-start weeks by order email date; the last week is partial',
    };
  } catch (e) { ndcp.error = e.message; }

  const locs = [...dir.values()];
  const portfolio = {
    locations: locs.length, open: locs.filter((s) => s.status === 'Open').length,
    remodel: locs.filter((s) => s.status === 'Remodel').length, tempClosed: locs.filter((s) => s.status === 'Temp Closed').length,
    comingSoon: locs.filter((s) => s.status === 'Coming Soon').length, permanentlyClosed: locs.filter((s) => s.status === 'Permanently Closed').length,
    nextGen: locs.filter((s) => s.isNextGen && s.status !== 'Permanently Closed').length,
    bridge: locs.filter((s) => s.isBridge && s.status !== 'Permanently Closed').length,
    districts: new Set(locs.filter((s) => s.district).map((s) => s.district)).size,
  };
  return { projects: { counts, byType, rows: rows.sort((a, b) => (b.overdue - a.overdue) || String(a.dueDate || '9').localeCompare(String(b.dueDate || '9'))) }, ndcp, portfolio };
}

// ── Data health ───────────────────────────────────────────────────────────────
// System Health's own snapshot plus the reconciliations that used to be done by eye.
async function execHealth() {
  const [health, labor, pnl, todayBlob, cashUploads, scorecard, lock, dir] = await Promise.all([
    load('pcg_system_health_v1'), load('pcg_labor_v1'), load('pcg_pnl_live_v1'), load('pcg_pulse_today_v1'),
    load('pcg_cash_uploads_v1'), load('pcg_dm_scorecard'), load('analyst/cron-lock'), loadStoreDirectory(),
  ]);
  const checks = [];
  const add = (id, label, ok, detail, values = {}) => checks.push({ id, label, status: ok === null ? 'unknown' : ok ? 'pass' : 'fail', detail, ...values });

  // 1. Labor blob today total vs P&L live revenue total (same business date → should match)
  if (labor?.stores && pnl?.stores) {
    const openOnly = (pc) => (dir.get(String(pc))?.status || 'Open') !== 'Permanently Closed';
    const a = r2(Object.entries(labor.stores).filter(([pc]) => openOnly(pc)).reduce((s, [, x]) => s + (x?.today?.sales || 0), 0));
    const b = r2(pnl.stores.reduce((s, x) => s + (x.revenue || 0), 0));
    const sameDay = !pnl.busDt || !labor.busDt || pnl.busDt === labor.busDt;
    const gap = Math.abs(a - b);
    add('pulse_vs_pnl', 'Pulse today total = P&L revenue total', sameDay ? gap <= Math.max(50, a * 0.005) : null,
      sameDay ? `Labor feed ${a.toLocaleString()} vs P&L ${b.toLocaleString()} (gap ${gap.toLocaleString()})` : `Different business dates (${labor.busDt} vs ${pnl.busDt})`, { a, b, gap });
  } else add('pulse_vs_pnl', 'Pulse today total = P&L revenue total', null, 'One of the feeds is missing');

  // 2. "Today so far" cache is current (anomaly detection and the Today tab depend on it)
  if (todayBlob?.asOf) {
    const ageMin = Math.round((Date.now() - new Date(todayBlob.asOf).getTime()) / 60000);
    const hourET = etNowDate().getHours();
    const expected = hourET >= 5 && hourET <= 23;
    add('pulse_today_cache', 'Pulse "today so far" cache refreshed in the last 45 min', expected ? ageMin <= 45 : null, `Last refresh ${ageMin} min ago for ${todayBlob.busDt}${expected ? '' : ' (overnight: refresh paused by design)'}`, { ageMin, busDt: todayBlob.busDt });
  } else add('pulse_today_cache', 'Pulse "today so far" cache refreshed in the last 45 min', false, 'No pcg_pulse_today_v1 blob');

  // 3. Deposit file age
  const newestUpload = (Array.isArray(cashUploads) ? cashUploads : []).reduce((m, u) => (u?.uploadedAt > m ? u.uploadedAt : m), '');
  if (newestUpload) {
    const ageDays = Math.floor((Date.now() - new Date(newestUpload).getTime()) / 86400000);
    add('deposit_upload_age', 'Deposit file uploaded this week', ageDays <= 7, `Last deposit file ${ageDays} day(s) ago (${newestUpload.slice(0, 10)})`, { ageDays, at: newestUpload });
  } else add('deposit_upload_age', 'Deposit file uploaded this week', false, 'No deposit file on record');

  // 4. DM scorecard freshness and sales-growth sanity (every district negative = broken comparison)
  const sc = Array.isArray(scorecard) ? scorecard[0] : null;
  if (sc) {
    const ageH = Math.round((Date.now() - new Date(sc.computedAt).getTime()) / 3600000);
    const growths = Object.values(sc.scores || {}).map((s) => s.avgGrowthPct).filter((g) => g != null);
    const allNeg = growths.length >= 4 && growths.every((g) => g < -5);
    add('scorecard_fresh', 'DM scorecard computed in the last 26 h', ageH <= 26, `Computed ${ageH} h ago (week of ${sc.weekOf})`, { ageHours: ageH });
    add('scorecard_growth', 'DM scorecard sales growth is like for like', !allNeg, allNeg ? 'Every district shows sales down more than 5% - usually a partial week compared to a full one' : `Growth basis: ${sc.basis?.sales || 'unspecified'}`, { growths });
  } else add('scorecard_fresh', 'DM scorecard computed in the last 26 h', false, 'No scorecard on record');

  // 5. Analyst run lock not stuck
  if (lock?.startedAt) {
    const ageMin = Math.round((Date.now() - new Date(lock.startedAt).getTime()) / 60000);
    const stuck = !lock.releasedAt && ageMin > 20;
    add('analyst_lock', 'Analyst run completed (lock released)', !stuck, lock.releasedAt ? `Last run ${ageMin} min ago, ${lock.summary?.durationMs ? Math.round(lock.summary.durationMs / 1000) + ' s' : 'completed'}` : `Run started ${ageMin} min ago and has not released`, { startedAt: lock.startedAt, releasedAt: lock.releasedAt || null });
  } else add('analyst_lock', 'Analyst run completed (lock released)', null, 'No run recorded since the v22.18 deploy');

  // 6. Stores in labor feed vs Locations "Open"
  if (labor?.stores) {
    const openPcs = [...dir.values()].filter((s) => s.status === 'Open').map((s) => s.pc);
    const missing = openPcs.filter((pc) => !labor.stores[pc]);
    add('labor_coverage', 'Every open store is in the labor feed', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : `${openPcs.length} open stores, all present`, { missing });
  }

  const feeds = (health?.feeds || []).map((f) => ({ key: f.key, label: f.label, category: f.category, status: f.status, critical: !!f.critical, savedAt: f.savedAt || null, error: f.error || null, beat: f.beat || null }));
  return { systemHealth: health ? { overall: health.overall, asOf: health.asOf, feeds } : null, checks };
}

// ── Attention (what needs a VP's eyes right now) ──────────────────────────────
async function execAttention() {
  const [today, dev, dist] = await Promise.all([execToday(), execDevelopment(), execDistricts()]);
  const items = [];
  if (!today.error) {
    const high = today.laborWatch.filter((s) => s.laborPct >= 30), med = today.laborWatch.filter((s) => s.laborPct >= 26 && s.laborPct < 30), low = today.laborWatch.filter((s) => s.laborPct < 26);
    if (high.length) items.push({ key: 'labor_high', area: 'Labor', severity: 'High', count: high.length, title: 'Stores with labor over 30%', detail: high.map((s) => `${s.name} ${s.laborPct}%`).join(', ') });
    if (med.length) items.push({ key: 'labor_med', area: 'Labor', severity: 'Medium', count: med.length, title: 'Stores with labor 26-30%', detail: med.map((s) => `${s.name} ${s.laborPct}%`).join(', ') });
    if (low.length) items.push({ key: 'labor_low', area: 'Labor', severity: 'Low', count: low.length, title: `Stores approaching the ${today.laborThresholdPct}% threshold`, detail: low.map((s) => s.name).join(', ') });
  }
  if (dev.projects.counts.overdue) items.push({ key: 'projects_overdue', area: 'Construction', severity: 'Medium', count: dev.projects.counts.overdue, title: 'Construction projects past due date', detail: dev.projects.rows.filter((r) => r.overdue).map((r) => r.name).join(', ') });
  const openHigh = dist.openCases.filter((c) => c.severity === 'high');
  if (openHigh.length) items.push({ key: 'cases_high', area: 'Orion cases', severity: 'High', count: openHigh.length, title: 'Open high-severity cases', detail: openHigh.slice(0, 6).map((c) => c.title).join(' · ') });
  return { asOf: new Date().toISOString(), items };
}

  return { loadStoreDirectory, execToday, execWeek, execDistricts, execDevelopment, execHealth, execAttention };
}

export { isTestRecord };
const defaults = createExecData();
export const loadStoreDirectory = defaults.loadStoreDirectory;
export const execToday = defaults.execToday;
export const execWeek = defaults.execWeek;
export const execDistricts = defaults.execDistricts;
export const execDevelopment = defaults.execDevelopment;
export const execHealth = defaults.execHealth;
export const execAttention = defaults.execAttention;
