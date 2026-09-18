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
