// district-alignment-lib/metrics.mjs — turns a store's existing
// pcg_hourly_history_{pc} array (written nightly by pulse-hourly-snapshot.mjs)
// into the figures District Alignment shows: weekly net sales (v21.92 — the
// newest complete Sun–Sat week, same week convention as Pulse), the original
// single-day net-sales snapshot (kept for the PDF export and back-compat), a
// 7-day-averaged hourly busy/slow profile, and that profile's 3 busiest hours.
// Reads only — never writes back to the history blob.

const MAX_DAYS = 7;
const TOP_HOURS = 3;

const daySales = (day) => (day?.hours || []).reduce((sum, h) => sum + (h.sales || 0), 0);
const r2 = (n) => Math.round(n * 100) / 100;
const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = Sunday

function weeklyFigure(entries) {
  const byDate = new Map(entries.filter(e => e?.date).map(e => [e.date, e]));
  // Newest Saturday on or before the newest entry with all 7 of its days present.
  const dates = [...byDate.keys()].sort().reverse();
  for (const d of dates) {
    if (weekday(d) !== 6) continue;
    const start = addDays(d, -6);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    if (days.every(x => byDate.has(x))) {
      return { weeklySales: r2(days.reduce((s, x) => s + daySales(byDate.get(x)), 0)), weekStart: start, weekEnd: d, weekComplete: true };
    }
  }
  // No full Sun–Sat week on file — fall back to the newest 7 days we do have.
  const recent = entries.slice(0, MAX_DAYS).filter(e => e?.date);
  if (!recent.length) return { weeklySales: null, weekStart: null, weekEnd: null, weekComplete: false };
  const sorted = recent.map(e => e.date).sort();
  return { weeklySales: r2(recent.reduce((s, e) => s + daySales(e), 0)), weekStart: sorted[0], weekEnd: sorted[sorted.length - 1], weekComplete: false };
}

export function computeStoreMetrics(historyEntries) {
  const entries = Array.isArray(historyEntries) ? historyEntries : [];
  if (entries.length === 0) {
    return { netSales: null, netSalesDate: null, hourlyAvg: [], weeklySales: null, weekStart: null, weekEnd: null, weekComplete: false, topHours: [] };
  }

  const newest = entries[0];
  const netSales = daySales(newest);
  const netSalesDate = newest.date;

  const window = entries.slice(0, MAX_DAYS);
  const sumByHour = new Map(); // h -> { total, count }
  window.forEach(day => {
    (day.hours || []).forEach(h => {
      const bucket = sumByHour.get(h.h) || { total: 0, count: 0 };
      bucket.total += h.sales || 0;
      bucket.count += 1;
      sumByHour.set(h.h, bucket);
    });
  });

  const hourlyAvg = Array.from(sumByHour.entries())
    .map(([h, { total, count }]) => ({ h, avgSales: Math.round((total / count) * 100) / 100 }))
    .sort((a, b) => a.h - b.h);

  const topHours = [...hourlyAvg].filter(h => h.avgSales > 0).sort((a, b) => b.avgSales - a.avgSales || a.h - b.h).slice(0, TOP_HOURS);

  return { netSales: r2(netSales), netSalesDate, hourlyAvg, ...weeklyFigure(entries), topHours, hourlyDays: window.length };
}
