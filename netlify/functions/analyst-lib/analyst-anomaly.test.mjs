// analyst-anomaly.test.mjs — the pure helpers behind time-of-day aware detection.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { baselineThroughHour, cumThroughHour, evaluableAnomalyTypes, MIN_BASELINE_SALES } from './analyst-anomaly.mjs';

const day = (date, perHour) => ({ date, hours: Array.from({ length: 16 }, (_, i) => ({ h: 5 + i, sales: perHour, checks: 10 })) });

describe('cumThroughHour', () => {
  test('sums only hours up to and including the given hour', () => {
    const e = day('2026-10-21', 100);
    assert.deepStrictEqual(cumThroughHour(e, 7), { sales: 300, checks: 30 }); // 5,6,7
    assert.deepStrictEqual(cumThroughHour(e, 4), { sales: 0, checks: 0 });
    assert.deepStrictEqual(cumThroughHour(null, 9), { sales: 0, checks: 0 });
  });
});

describe('baselineThroughHour', () => {
  test('uses the same weekday over the last weeks and returns the median through the hour', () => {
    // today Wed 2026-10-21; prior Wednesdays: 10-14, 10-07, 09-30
    const entries = [day('2026-10-14', 100), day('2026-10-07', 120), day('2026-09-30', 80), day('2026-10-20', 999)];
    const b = baselineThroughHour(entries, '2026-10-21', 9);
    assert.strictEqual(b.days, 3);
    assert.strictEqual(b.sales, 500); // median of 500, 600, 400 (5 hours x per-hour)
    assert.match(b.basis, /same weekday/);
  });

  test('falls back to the last 7 days when fewer than 2 same-weekday days exist', () => {
    const entries = [day('2026-10-20', 100), day('2026-10-19', 110), day('2026-10-18', 90)];
    const b = baselineThroughHour(entries, '2026-10-21', 9);
    assert.strictEqual(b.days, 3);
    assert.match(b.basis, /last 3 days/);
  });

  test('returns null with no usable history', () => {
    assert.strictEqual(baselineThroughHour([], '2026-10-21', 9), null);
    assert.strictEqual(baselineThroughHour([day('2026-10-20', 100)], '2026-10-21', 9), null);
  });

  test('a 7 AM baseline is small, which is why drops are only judged against baselines >= MIN_BASELINE_SALES', () => {
    const entries = [day('2026-10-14', 40), day('2026-10-07', 40)];
    const b = baselineThroughHour(entries, '2026-10-21', 6); // two hours in: 80
    assert.ok(b.sales < MIN_BASELINE_SALES);
  });
});

describe('evaluableAnomalyTypes', () => {
  test('the 7 AM run can only judge zero-sales and overtime; labor and sales drops start at 9 AM', () => {
    const seven = evaluableAnomalyTypes(7);
    assert.ok(seven.has('zero_sales') && seven.has('overtime_spike'));
    assert.ok(!seven.has('labor_high') && !seven.has('sales_drop') && !seven.has('network_labor_high'));
    const ten = evaluableAnomalyTypes(10);
    for (const t of ['labor_high', 'labor_watch', 'sales_drop', 'network_labor_high', 'zero_sales', 'overtime_spike']) assert.ok(ten.has(t), t);
    assert.ok(!evaluableAnomalyTypes(6).has('zero_sales'));
  });
});
