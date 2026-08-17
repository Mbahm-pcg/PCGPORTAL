import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LY_OFFSET_DAYS, shiftDate, dowFor, comparisonDates, delta, comparableTotals } from './pulse-comparison.mjs';

describe('shiftDate', () => {
  test('shifts forward and backward', () => {
    assert.strictEqual(shiftDate('2026-08-12', 7), '2026-08-19');
    assert.strictEqual(shiftDate('2026-08-12', -7), '2026-08-05');
  });
  test('crosses month and year boundaries', () => {
    assert.strictEqual(shiftDate('2026-01-01', -1), '2025-12-31');
    assert.strictEqual(shiftDate('2026-02-28', 1), '2026-03-01');
  });
  test('LY offset lands on the same weekday', () => {
    const d = '2026-08-12';
    assert.strictEqual(dowFor(shiftDate(d, -LY_OFFSET_DAYS)), dowFor(d));
  });
});

describe('comparisonDates — day mode', () => {
  test('single current date, one lw and one ly date', () => {
    const r = comparisonDates('2026-08-12', 'day', '2026-08-14');
    assert.deepStrictEqual(r.current, ['2026-08-12']);
    assert.deepStrictEqual(r.lw, ['2026-08-05']);
    assert.deepStrictEqual(r.ly, ['2025-08-13']);
  });
});

describe('comparisonDates — week mode', () => {
  test('current week returns only elapsed days (Sun..today)', () => {
    // 2026-08-12 is a Wednesday; week starts Sun 2026-08-09; today is Wed
    const r = comparisonDates('2026-08-12', 'week', '2026-08-12');
    assert.deepStrictEqual(r.current, ['2026-08-09','2026-08-10','2026-08-11','2026-08-12']);
    assert.strictEqual(r.lw.length, 4);
    assert.strictEqual(r.ly.length, 4);
    assert.strictEqual(r.lw[0], '2026-08-02');
    assert.strictEqual(r.ly[0], '2025-08-10');
  });
  test('a fully past week returns all 7 days', () => {
    const r = comparisonDates('2026-08-05', 'week', '2026-08-14');
    assert.strictEqual(r.current.length, 7);
    assert.strictEqual(r.current[0], '2026-08-02'); // Sunday
    assert.strictEqual(r.current[6], '2026-08-08'); // Saturday
  });
  test('every comparison date keeps day-of-week alignment', () => {
    const r = comparisonDates('2026-08-12', 'week', '2026-08-12');
    r.current.forEach((d, i) => {
      assert.strictEqual(dowFor(r.lw[i]), dowFor(d));
      assert.strictEqual(dowFor(r.ly[i]), dowFor(d));
    });
  });
  test('week spanning a year boundary', () => {
    // 2026-01-01 is a Thursday; week starts Sun 2025-12-28
    const r = comparisonDates('2026-01-01', 'week', '2026-01-01');
    assert.strictEqual(r.current[0], '2025-12-28');
    assert.strictEqual(r.current.length, 5);
  });
});

describe('delta', () => {
  test('normal positive and negative movement', () => {
    assert.strictEqual(delta(110, 100), 10);
    assert.strictEqual(delta(90, 100), -10);
  });
  test('returns null rather than dividing by zero or absent prior', () => {
    assert.strictEqual(delta(100, 0), null);
    assert.strictEqual(delta(100, null), null);
    assert.strictEqual(delta(100, undefined), null);
  });
});

import { dayCompletionFraction, MIN_CURVE_SAMPLES } from './pulse-comparison.mjs';

const ok = (netSales, guests) => ({ status: 'ok', data: { netSales, guests, voids: 0, discounts: 0 } });

describe('comparableTotals', () => {
  const cache = {
    '2026-08-12': { A: ok(100, 10), B: ok(200, 20), C: ok(50, 5) },
    '2026-08-05': { A: ok(90, 9),   B: ok(180, 18) },   // C missing on the prior side
  };

  test('sums only stores present on BOTH sides', () => {
    const r = comparableTotals(cache, ['2026-08-12'], ['2026-08-05'], ['A','B','C']);
    assert.deepStrictEqual(r.comparablePcs, ['A','B']);
    assert.deepStrictEqual(r.excludedPcs, ['C']);
    assert.strictEqual(r.current.netSales, 300);  // C's 50 excluded from current too
    assert.strictEqual(r.prior.netSales, 270);
    assert.strictEqual(r.current.guests, 30);
    assert.strictEqual(r.prior.guests, 27);
  });

  test('a store erroring on either side is excluded', () => {
    const c = {
      '2026-08-12': { A: ok(100, 10), B: { status: 'error' } },
      '2026-08-05': { A: ok(90, 9),   B: ok(180, 18) },
    };
    const r = comparableTotals(c, ['2026-08-12'], ['2026-08-05'], ['A','B']);
    assert.deepStrictEqual(r.comparablePcs, ['A']);
    assert.strictEqual(r.current.netSales, 100);
  });

  test('multi-day: missing ONE day of the range excludes the store entirely', () => {
    const c = {
      '2026-08-11': { A: ok(10, 1), B: ok(20, 2) },
      '2026-08-12': { A: ok(10, 1) },                 // B missing this day
      '2026-08-04': { A: ok(10, 1), B: ok(20, 2) },
      '2026-08-05': { A: ok(10, 1), B: ok(20, 2) },
    };
    const r = comparableTotals(c, ['2026-08-11','2026-08-12'], ['2026-08-04','2026-08-05'], ['A','B']);
    assert.deepStrictEqual(r.comparablePcs, ['A']);
    assert.strictEqual(r.current.netSales, 20);
    assert.strictEqual(r.prior.netSales, 20);
  });

  test('no comparable stores yields zeros, not a throw', () => {
    const r = comparableTotals({}, ['2026-08-12'], ['2026-08-05'], ['A']);
    assert.deepStrictEqual(r.comparablePcs, []);
    assert.strictEqual(r.current.netSales, 0);
    assert.strictEqual(r.prior.netSales, 0);
  });

  test('missing cache object does not throw', () => {
    const r = comparableTotals(undefined, ['2026-08-12'], ['2026-08-05'], ['A']);
    assert.deepStrictEqual(r.excludedPcs, ['A']);
  });
});

describe('dayCompletionFraction', () => {
  test('weights across stores and days, not a mean of fractions', () => {
    const histories = [
      [{ date: '2026-08-05', hours: [{ h: 8, sales: 25 }, { h: 14, sales: 75 }] },
       { date: '2026-07-29', hours: [{ h: 8, sales: 25 }, { h: 14, sales: 75 }] },
       { date: '2026-07-22', hours: [{ h: 8, sales: 25 }, { h: 14, sales: 75 }] }],
    ];
    // through hour 8 → 25 of every 100
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), 0.25);
  });

  test('includes the boundary hour itself', () => {
    const histories = [[
      { date: '2026-08-05', hours: [{ h: 8, sales: 50 }, { h: 9, sales: 50 }] },
      { date: '2026-07-29', hours: [{ h: 8, sales: 50 }, { h: 9, sales: 50 }] },
      { date: '2026-07-22', hours: [{ h: 8, sales: 50 }, { h: 9, sales: 50 }] },
    ]];
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), 0.5);
    assert.strictEqual(dayCompletionFraction(histories, 3, 9), 1);
  });

  test('only matching day-of-week entries count', () => {
    const histories = [[
      { date: '2026-08-04', hours: [{ h: 8, sales: 100 }] },  // Tuesday — ignored for dow=3
      { date: '2026-08-05', hours: [{ h: 8, sales: 10 }, { h: 14, sales: 90 }] },
      { date: '2026-07-29', hours: [{ h: 8, sales: 10 }, { h: 14, sales: 90 }] },
      { date: '2026-07-22', hours: [{ h: 8, sales: 10 }, { h: 14, sales: 90 }] },
    ]];
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), 0.10);
  });

  test('returns null below the sample floor', () => {
    const histories = [[{ date: '2026-08-05', hours: [{ h: 8, sales: 50 }, { h: 14, sales: 50 }] }]];
    assert.strictEqual(dayCompletionFraction(histories, 3, 8), null);
    assert.ok(MIN_CURVE_SAMPLES > 1);
  });

  test('returns null on empty, missing, or zero-sales history', () => {
    assert.strictEqual(dayCompletionFraction([], 3, 8), null);
    assert.strictEqual(dayCompletionFraction(undefined, 3, 8), null);
    assert.strictEqual(dayCompletionFraction([null, 'nope'], 3, 8), null);
    const zeroes = [[
      { date: '2026-08-05', hours: [{ h: 8, sales: 0 }] },
      { date: '2026-07-29', hours: [{ h: 8, sales: 0 }] },
      { date: '2026-07-22', hours: [{ h: 8, sales: 0 }] },
    ]];
    assert.strictEqual(dayCompletionFraction(zeroes, 3, 8), null);
  });

  test('respects maxSamples per store', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      date: shiftDate('2026-08-05', -7 * i),
      hours: [{ h: 8, sales: i === 0 ? 100 : 0 }, { h: 14, sales: 100 }],
    }));
    // With maxSamples=1 only the newest Wednesday counts → 100/200 = 0.5,
    // but that is below MIN_CURVE_SAMPLES, so null.
    assert.strictEqual(dayCompletionFraction([many], 3, 8, 1), null);
    // With the full window, later days contribute 0 early sales → well under 0.1
    const full = dayCompletionFraction([many], 3, 8, 12);
    assert.ok(full !== null && full < 0.1);
  });
});
