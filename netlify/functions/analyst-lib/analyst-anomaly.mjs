// analyst-anomaly.js — Anomaly detection across KPI data
import { buildKPISnapshot, getStoreDailyHistory, STORES } from './analyst-data.mjs';

// Thresholds
const LABOR_RED = 26;         // labor % above this = red flag
const LABOR_YELLOW = 23;      // labor % above this = watch
const SALES_DROP_PCT = 15;    // daily sales drop > this % vs WTD avg = anomaly
const OT_THRESHOLD = 3;       // more than this many OT employees = flag
const DISCOUNT_HIGH = 5;      // discount % > this = flag (placeholder for when we have discount data)

/**
 * Detect anomalies across all stores. Returns array of anomaly objects:
 * { type, severity, storeName, district, metric, value, threshold, description, dataContext }
 */
async function detectAnomalies({ district } = {}) {
  const snapshot = await buildKPISnapshot({ district });
  if (snapshot.error) return [];

  const anomalies = [];

  for (const store of snapshot.stores) {
    if (store.error) continue;
    const t = store.today;
    const w = store.wtd;

    // 1. Labor % too high
    if (t.laborPct >= LABOR_RED && t.sales > 0) {
      anomalies.push({
        type: 'labor_high',
        severity: 'high',
        storeName: store.name,
        district: store.district,
        metric: 'Labor %',
        value: t.laborPct,
        threshold: LABOR_RED,
        description: `${store.name} labor at ${t.laborPct}% today (threshold: ${LABOR_RED}%). Sales: $${t.sales.toLocaleString()}, Labor cost: $${t.laborDollars.toLocaleString()}.`,
        dataContext: { today: t, wtd: w },
      });
    } else if (t.laborPct >= LABOR_YELLOW && t.laborPct < LABOR_RED && t.sales > 0) {
      anomalies.push({
        type: 'labor_watch',
        severity: 'medium',
        storeName: store.name,
        district: store.district,
        metric: 'Labor %',
        value: t.laborPct,
        threshold: LABOR_YELLOW,
        description: `${store.name} labor at ${t.laborPct}% today — approaching red zone. Sales: $${t.sales.toLocaleString()}.`,
        dataContext: { today: t, wtd: w },
      });
    }

    // 2. Overtime spike
    if (t.overtimeCount >= OT_THRESHOLD) {
      anomalies.push({
        type: 'overtime_spike',
        severity: 'medium',
        storeName: store.name,
        district: store.district,
        metric: 'Overtime Employees',
        value: t.overtimeCount,
        threshold: OT_THRESHOLD,
        description: `${store.name} has ${t.overtimeCount} employees in overtime — review schedules to reduce OT cost.`,
        dataContext: { today: t },
      });
    }

    // 3. Sales drop vs WTD average
    if (w.sales > 0 && t.sales > 0) {
      // Estimate WTD daily avg (WTD sales / days elapsed)
      const busDt = new Date(snapshot.busDt + 'T12:00:00');
      const dayOfWeek = busDt.getDay();
      const daysElapsed = dayOfWeek === 0 ? 7 : dayOfWeek; // Sun=7 days, Mon=1
      const wtdDailyAvg = w.sales / Math.max(daysElapsed - 1, 1); // exclude today
      if (wtdDailyAvg > 0) {
        const dropPct = ((wtdDailyAvg - t.sales) / wtdDailyAvg) * 100;
        if (dropPct >= SALES_DROP_PCT) {
          anomalies.push({
            type: 'sales_drop',
            severity: dropPct >= 25 ? 'high' : 'medium',
            storeName: store.name,
            district: store.district,
            metric: 'Net Sales',
            value: t.sales,
            threshold: wtdDailyAvg,
            description: `${store.name} sales today ($${t.sales.toLocaleString()}) are ${dropPct.toFixed(1)}% below WTD daily avg ($${Math.round(wtdDailyAvg).toLocaleString()}).`,
            dataContext: { today: t, wtd: w, wtdDailyAvg, dropPct },
          });
        }
      }
    }

    // 4. Zero sales but employees scheduled (store may be having POS issues)
    if (t.sales === 0 && (t.scheduledNow > 0 || t.employeesWorked > 0)) {
      anomalies.push({
        type: 'zero_sales',
        severity: 'high',
        storeName: store.name,
        district: store.district,
        metric: 'Net Sales',
        value: 0,
        threshold: 'any',
        description: `${store.name} shows $0 sales but has ${t.scheduledNow || t.employeesWorked} employees active — possible POS issue or data lag.`,
        dataContext: { today: t },
      });
    }
  }

  // 5. Network-level: overall labor % check
  const net = snapshot.network;
  if (net.laborPct >= LABOR_RED && net.sales > 0) {
    anomalies.push({
      type: 'network_labor_high',
      severity: 'high',
      storeName: 'Network',
      district: 0,
      metric: 'Network Labor %',
      value: net.laborPct,
      threshold: LABOR_RED,
      description: `Network-wide labor at ${net.laborPct}% — ${net.overtimeCount} employees in OT across ${net.storeCount} stores.`,
      dataContext: { network: net },
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

export { detectAnomalies, LABOR_RED, LABOR_YELLOW, SALES_DROP_PCT, OT_THRESHOLD };
