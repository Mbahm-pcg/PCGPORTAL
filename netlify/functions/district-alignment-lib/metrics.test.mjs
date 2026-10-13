import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStoreMetrics } from './metrics.mjs';

function makeDay(date, hourSales) {
  return { date, hours: hourSales.map(([h, sales]) => ({ h, sales, count: 1 })) };
}

test('computeStoreMetrics: no history returns nulls and an empty hourly average', () => {
  const result = computeStoreMetrics([]);
  assert.equal(result.netSales, null);
  assert.equal(result.netSalesDate, null);
  assert.deepEqual(result.hourlyAvg, []);
});

test('computeStoreMetrics: netSales is the sum of the newest entry\'s hourly sales', () => {
  const history = [
    makeDay('2026-09-16', [[9, 100], [10, 150]]),
    makeDay('2026-09-15', [[9, 50], [10, 50]]),
  ];
  const result = computeStoreMetrics(history);
  assert.equal(result.netSales, 250);
  assert.equal(result.netSalesDate, '2026-09-16');
});

test('computeStoreMetrics: hourlyAvg averages the same hour across days present', () => {
  const history = [
    makeDay('2026-09-16', [[9, 100]]),
    makeDay('2026-09-15', [[9, 50]]),
  ];
  const result = computeStoreMetrics(history);
  const hour9 = result.hourlyAvg.find(h => h.h === 9);
  assert.equal(hour9.avgSales, 75);
});

test('computeStoreMetrics: only averages over the newest 7 entries, ignoring older history', () => {
  const history = [];
  for (let i = 0; i < 10; i++) {
    history.push(makeDay(`2026-09-${String(16 - i).padStart(2, '0')}`, [[9, i === 9 ? 10000 : 10]]));
  }
  // The 10th-newest entry (index 9) has an outlier value that must NOT be included.
  const result = computeStoreMetrics(history);
  const hour9 = result.hourlyAvg.find(h => h.h === 9);
  assert.equal(hour9.avgSales, 10); // all 7 newest entries have sales=10, outlier excluded
});

test('computeStoreMetrics: fewer than 7 days available still averages correctly over what exists', () => {
  const history = [makeDay('2026-09-16', [[9, 30]]), makeDay('2026-09-15', [[9, 60]])];
  const result = computeStoreMetrics(history);
  const hour9 = result.hourlyAvg.find(h => h.h === 9);
  assert.equal(hour9.avgSales, 45);
});

test('computeStoreMetrics: hours only present on some days still appear, averaged only over days that had them', () => {
  const history = [
    makeDay('2026-09-16', [[9, 100], [20, 40]]),
    makeDay('2026-09-15', [[9, 100]]), // no hour 20 this day
  ];
  const result = computeStoreMetrics(history);
  const hour20 = result.hourlyAvg.find(h => h.h === 20);
  assert.equal(hour20.avgSales, 40); // averaged only over the 1 day it appeared
});

test('computeStoreMetrics: hourlyAvg is sorted by hour ascending', () => {
  const history = [makeDay('2026-09-16', [[14, 1], [9, 1], [20, 1]])];
  const result = computeStoreMetrics(history);
  assert.deepEqual(result.hourlyAvg.map(h => h.h), [9, 14, 20]);
});

// ── Weekly sales + busiest hours (v21.92) ──────────────────────────────────
function weekOfDays(startIso, perDay) {
  // 7 consecutive days starting at startIso, newest first (like the real blob)
  const out = [];
  const d = new Date(`${startIso}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    out.push(makeDay(d.toISOString().slice(0, 10), [[9, perDay]]));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out.reverse();
}

test('computeStoreMetrics: weeklySales sums the newest complete Sun–Sat week', () => {
  // Sun 2026-10-04 .. Sat 2026-10-10 complete (100/day), plus Sun 10-11 and Mon 10-12 of the next week
  const history = [
    makeDay('2026-10-12', [[9, 999]]),
    makeDay('2026-10-11', [[9, 999]]),
    ...weekOfDays('2026-10-04', 100),
  ];
  const r = computeStoreMetrics(history);
  assert.equal(r.weeklySales, 700);
  assert.equal(r.weekStart, '2026-10-04');
  assert.equal(r.weekEnd, '2026-10-10');
  assert.equal(r.weekComplete, true);
});

test('computeStoreMetrics: weeklySales falls back to the newest 7 days when no full Sun–Sat week exists', () => {
  const history = [
    makeDay('2026-10-12', [[9, 10]]),
    makeDay('2026-10-11', [[9, 20]]),
    makeDay('2026-10-09', [[9, 30]]),
  ];
  const r = computeStoreMetrics(history);
  assert.equal(r.weeklySales, 60);
  assert.equal(r.weekStart, '2026-10-09');
  assert.equal(r.weekEnd, '2026-10-12');
  assert.equal(r.weekComplete, false);
});

test('computeStoreMetrics: weeklySales is null with no history', () => {
  const r = computeStoreMetrics([]);
  assert.equal(r.weeklySales, null);
  assert.deepEqual(r.topHours, []);
});

test('computeStoreMetrics: topHours lists the 3 busiest hours by average sales, highest first', () => {
  const history = [
    makeDay('2026-10-12', [[6, 50], [7, 300], [8, 400], [9, 200], [10, 100]]),
    makeDay('2026-10-11', [[6, 50], [7, 300], [8, 400], [9, 200], [10, 100]]),
  ];
  const r = computeStoreMetrics(history);
  assert.deepEqual(r.topHours.map(h => h.h), [8, 7, 9]);
  assert.equal(r.topHours[0].avgSales, 400);
});
