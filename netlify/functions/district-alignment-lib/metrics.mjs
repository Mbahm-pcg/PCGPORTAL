// district-alignment-lib/metrics.mjs — turns a store's existing
// pcg_hourly_history_{pc} array (written nightly by pulse-hourly-snapshot.mjs)
// into the two figures District Alignment shows: a net-sales snapshot (most
// recent day) and a 7-day-averaged hourly busy/slow profile. Reads only —
// never writes back to the history blob.

const MAX_DAYS = 7;

export function computeStoreMetrics(historyEntries) {
  const entries = Array.isArray(historyEntries) ? historyEntries : [];
  if (entries.length === 0) {
    return { netSales: null, netSalesDate: null, hourlyAvg: [] };
  }

  const newest = entries[0];
  const netSales = (newest.hours || []).reduce((sum, h) => sum + (h.sales || 0), 0);
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

  return { netSales: Math.round(netSales * 100) / 100, netSalesDate, hourlyAvg };
}
