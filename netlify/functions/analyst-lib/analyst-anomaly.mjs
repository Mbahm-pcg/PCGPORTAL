// analyst-anomaly.mjs — Anomaly detection across KPI data
//
// v22.18 (2026-10-25): time-of-day aware. The previous version compared a PARTIAL
// day against FULL-day numbers, so the 7 AM run filed "labor 1512% on $11.77 sales"
// and the 10 AM run filed "sales 78% below WTD daily avg" for stores that were
// simply three hours into their day (every such case in the 10/19-10/25 logs was
// false). Now:
//   - sales drops compare today's COMPLETE hours against the same weekday's
//     cumulative sales through the same hour over the last BASELINE_WEEKS weeks
//     (pcg_hourly_history_{pc}, written nightly by pulse-hourly-snapshot), using
//     the pcg_pulse_today_v1 "today so far" cache for today's hourly buckets;
//   - labor % is only judged once a store has real sales (SALES_FLOOR_FOR_LABOR)
//     and the day is far enough along (EARLIEST_ALERT_HOUR_ET);
//   - stores whose Locations status is not "Open" (Remodel, Temp Closed, Coming
//     Soon) are skipped — a remodel day is not an anomaly;
//   - every anomaly carries a `key` (type|pc|busDt) so the cron and the case
//     store can dedupe and auto-resolve it.
import { buildKPISnapshot } from './analyst-data.mjs';
import { cacheLoad } from './analyst-cache.mjs';
import { loadStoreStatuses } from '../_shared/store-status.mjs';

// Thresholds
const LABOR_RED = 26;         // labor % above this = red flag
const LABOR_YELLOW = 23;      // labor % above this = watch
const SALES_DROP_PCT = 25;    // same-hour sales drop >= this % vs baseline = anomaly (was 15 vs a full-day avg)
const SALES_DROP_HIGH_PCT = 40;
const OT_THRESHOLD = 3;       // more than this many OT employees = flag

// Partial-day guards
const SALES_FLOOR_FOR_LABOR = 500; // $ of sales today before a labor % means anything
const EARLIEST_ALERT_HOUR_ET = 9;  // no labor % / sales-drop anomalies before 9 AM ET
const ZERO_SALES_HOUR_ET = 7;      // a store with staff and $0 by 7 AM ET is a real problem
const MIN_BASELINE_SALES = 300;    // baseline-through-hour must be at least this to call a drop
const BASELINE_WEEKS = 6;          // same-weekday history to average
const MIN_BASELINE_DAYS = 2;       // need at least this many comparable days
const TODAY_CACHE_MAX_AGE_MIN = 90;

// ── ET clock helpers ─────────────────────────────────────────────────────────
function etNowDate() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })); }
function etHourNow() { return etNowDate().getHours(); }
function ymdOf(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function addDaysYmd(ymd, n) { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return ymdOf(d); }
function weekdayOfYmd(ymd) { return new Date(ymd + 'T12:00:00').getDay(); }
function hr12(h) { return `${((h + 11) % 12) + 1} ${h < 12 ? 'AM' : 'PM'}`; }
const money = (n) => '$' + Math.round(n || 0).toLocaleString();

// Cumulative sales through `hour` (inclusive) from one day's { hours:[{h,sales}] } entry.
function cumThroughHour(entry, hour) {
  let sales = 0, checks = 0;
  for (const h of (entry?.hours || [])) { if (h.h <= hour) { sales += h.sales || 0; checks += h.checks || 0; } }
  return { sales: Math.round(sales * 100) / 100, checks };
}

function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Same weekday over the last BASELINE_WEEKS weeks, cumulative through `hour`.
// Falls back to the last 7 days when there are not enough same-weekday days.
export function baselineThroughHour(entries, today, hour, weeks = BASELINE_WEEKS) {
  const list = Array.isArray(entries) ? entries : [];
  const byDate = new Map(list.filter((e) => e?.date).map((e) => [e.date, e]));
  const sameDow = [];
  for (let w = 1; w <= weeks; w++) {
    const e = byDate.get(addDaysYmd(today, -7 * w));
    if (e) sameDow.push(cumThroughHour(e, hour).sales);
  }
  if (sameDow.length >= MIN_BASELINE_DAYS) return { sales: median(sameDow), days: sameDow.length, basis: `same weekday, last ${sameDow.length} weeks` };
  const recent = [];
  for (let d = 1; d <= 7; d++) {
    const e = byDate.get(addDaysYmd(today, -d));
    if (e) recent.push(cumThroughHour(e, hour).sales);
  }
  if (recent.length >= MIN_BASELINE_DAYS) return { sales: median(recent), days: recent.length, basis: `last ${recent.length} days` };
  return null;
}

async function loadTodaySoFar(today) {
  const blob = await cacheLoad('pcg_pulse_today_v1').catch(() => null);
  if (!blob || blob.busDt !== today || !blob.asOf) return null;
  const ageMin = (Date.now() - new Date(blob.asOf).getTime()) / 60000;
  if (!Number.isFinite(ageMin) || ageMin > TODAY_CACHE_MAX_AGE_MIN) return null;
  return blob;
}

/**
 * Detect anomalies across all stores. Returns array of anomaly objects:
 * { key, type, severity, storeName, storePC, district, metric, value, threshold, description, dataContext }
 */
async function detectAnomalies({ district, now = null } = {}) {
  const snapshot = await buildKPISnapshot({ district });
  if (snapshot.error) return [];

  const etNow = now || etNowDate();
  const hour = now ? now.getHours() : etHourNow();
  const today = ymdOf(etNow);
  const busDt = snapshot.busDt || today;
  const completeHour = hour - 1; // the current hour is still filling in
  const lateDay = hour >= 20;    // by 8 PM a day is close enough to complete to compare whole days

  const statuses = await loadStoreStatuses().catch(() => null);
  const todayBlob = await loadTodaySoFar(busDt);

  const anomalies = [];
  const push = (a) => anomalies.push({ key: `${a.type}|${a.storePC || a.storeName}|${busDt}`, busDt, ...a });

  for (const store of snapshot.stores) {
    if (store.error) continue;
    const status = statuses?.get(String(store.pc))?.status;
    if (status && status !== 'Open') continue; // Remodel / Temp Closed / Coming Soon are not anomalies
    const t = store.today;
    const w = store.wtd;

    // 1. Labor % too high — only once the day and the sales are real
    if (hour >= EARLIEST_ALERT_HOUR_ET && t.sales >= SALES_FLOOR_FOR_LABOR) {
      if (t.laborPct >= LABOR_RED) {
        push({
          type: 'labor_high', severity: 'high',
          storeName: store.name, storePC: store.pc, district: store.district,
          metric: 'Labor %', value: t.laborPct, threshold: LABOR_RED,
          description: `${store.name} labor at ${t.laborPct}% through ${hr12(hour)} (threshold: ${LABOR_RED}%). Sales so far: ${money(t.sales)}, labor cost: ${money(t.laborDollars)}.`,
          dataContext: { today: t, wtd: w, throughHour: hour },
        });
      } else if (t.laborPct >= LABOR_YELLOW) {
        push({
          type: 'labor_watch', severity: 'medium',
          storeName: store.name, storePC: store.pc, district: store.district,
          metric: 'Labor %', value: t.laborPct, threshold: LABOR_YELLOW,
          description: `${store.name} labor at ${t.laborPct}% through ${hr12(hour)} — approaching red zone. Sales so far: ${money(t.sales)}.`,
          dataContext: { today: t, wtd: w, throughHour: hour },
        });
      }
    }

    // 2. Overtime spike (not time-of-day sensitive)
    if (t.overtimeCount >= OT_THRESHOLD) {
      push({
        type: 'overtime_spike', severity: 'medium',
        storeName: store.name, storePC: store.pc, district: store.district,
        metric: 'Overtime Employees', value: t.overtimeCount, threshold: OT_THRESHOLD,
        description: `${store.name} has ${t.overtimeCount} employees in overtime — review schedules to reduce OT cost.`,
        dataContext: { today: t },
      });
    }

    // 3. Sales drop — same-hour comparison against the store's own history
    if (hour >= EARLIEST_ALERT_HOUR_ET) {
      const live = todayBlob?.stores?.[store.pc] || null;
      const hist = await cacheLoad(`pcg_hourly_history_${store.pc}`).catch(() => null);
      if (live && Array.isArray(hist) && completeHour >= 5) {
        const todayCum = cumThroughHour(live, completeHour);
        const base = baselineThroughHour(hist, busDt, completeHour);
        if (base && base.sales >= MIN_BASELINE_SALES) {
          const dropPct = ((base.sales - todayCum.sales) / base.sales) * 100;
          if (dropPct >= SALES_DROP_PCT) {
            push({
              type: 'sales_drop', severity: dropPct >= SALES_DROP_HIGH_PCT ? 'high' : 'medium',
              storeName: store.name, storePC: store.pc, district: store.district,
              metric: 'Net Sales', value: todayCum.sales, threshold: base.sales,
              description: `${store.name} sales through ${hr12(completeHour + 1)} (${money(todayCum.sales)}) are ${dropPct.toFixed(1)}% below its usual ${money(base.sales)} by this hour (${base.basis}).`,
              dataContext: { today: t, wtd: w, throughHour: completeHour, todaySoFar: todayCum, baseline: base, dropPct },
            });
          }
        }
      } else if (lateDay && w.sales > 0 && t.sales > 0) {
        // No hourly data (cache cold) but the day is nearly over: whole-day compare is fair.
        const dayOfWeek = weekdayOfYmd(busDt);
        const daysElapsed = dayOfWeek === 0 ? 7 : dayOfWeek;
        const wtdDailyAvg = (w.sales - t.sales) / Math.max(daysElapsed - 1, 1);
        if (wtdDailyAvg >= MIN_BASELINE_SALES) {
          const dropPct = ((wtdDailyAvg - t.sales) / wtdDailyAvg) * 100;
          if (dropPct >= SALES_DROP_PCT) {
            push({
              type: 'sales_drop', severity: dropPct >= SALES_DROP_HIGH_PCT ? 'high' : 'medium',
              storeName: store.name, storePC: store.pc, district: store.district,
              metric: 'Net Sales', value: t.sales, threshold: wtdDailyAvg,
              description: `${store.name} sales today (${money(t.sales)}) are ${dropPct.toFixed(1)}% below its week-to-date daily average (${money(wtdDailyAvg)}).`,
              dataContext: { today: t, wtd: w, wtdDailyAvg, dropPct, basis: 'whole day vs WTD daily average' },
            });
          }
        }
      }
    }

    // 4. Zero sales but employees on the clock (POS issue or store not open)
    if (hour >= ZERO_SALES_HOUR_ET && t.sales === 0 && (t.scheduledNow > 0 || t.employeesWorked > 0)) {
      push({
        type: 'zero_sales', severity: 'high',
        storeName: store.name, storePC: store.pc, district: store.district,
        metric: 'Net Sales', value: 0, threshold: 'any',
        description: `${store.name} shows $0 sales by ${hr12(hour)} but has ${t.scheduledNow || t.employeesWorked} employees active — possible POS issue or data lag.`,
        dataContext: { today: t },
      });
    }
  }

  // 5. Network-level: overall labor % check (same partial-day guard, scaled up)
  const net = snapshot.network;
  if (hour >= EARLIEST_ALERT_HOUR_ET && net.laborPct >= LABOR_RED && net.sales >= SALES_FLOOR_FOR_LABOR * Math.max(1, net.storeCount)) {
    push({
      type: 'network_labor_high', severity: 'high',
      storeName: 'Network', storePC: null, district: 0,
      metric: 'Network Labor %', value: net.laborPct, threshold: LABOR_RED,
      description: `Network-wide labor at ${net.laborPct}% through ${hr12(hour)} — ${net.overtimeCount} employees in OT across ${net.storeCount} stores.`,
      dataContext: { network: net, throughHour: hour },
    });
  }

  // Sort: high severity first, then by value (worst first)
  anomalies.sort((a, b) => {
    const sevRank = { high: 0, medium: 1, low: 2 };
    const r = (sevRank[a.severity] || 2) - (sevRank[b.severity] || 2);
    if (r !== 0) return r;
    return (b.value || 0) - (a.value || 0);
  });

  return anomalies;
}

export {
  detectAnomalies, LABOR_RED, LABOR_YELLOW, SALES_DROP_PCT, OT_THRESHOLD,
  SALES_FLOOR_FOR_LABOR, EARLIEST_ALERT_HOUR_ET, MIN_BASELINE_SALES, BASELINE_WEEKS, cumThroughHour,
};
