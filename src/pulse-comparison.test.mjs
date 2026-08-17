import { test, describe } from 'node:test';
import assert from 'node:assert';
import { LY_OFFSET_DAYS, shiftDate, dowFor, comparisonDates, delta } from './pulse-comparison.mjs';

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
