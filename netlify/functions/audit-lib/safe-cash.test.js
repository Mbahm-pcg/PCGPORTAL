const { test, describe } = require('node:test');
const assert = require('node:assert');
const { BILL_VALUES, COIN_VALUES, DISPLAY_TOLERANCE, SHORTAGE_ALERT_THRESHOLD, REASONS,
        toCount, computeCashTotals, computeVariance, shouldAlert } = require('./safe-cash');

describe('toCount', () => {
  test('normalizes blanks/NA/negatives to 0, floors to int', () => {
    for (const v of ['', null, undefined, 'N/A', 'n/a', -3, NaN, 'abc']) assert.strictEqual(toCount(v), 0);
    assert.strictEqual(toCount('5'), 5);
    assert.strictEqual(toCount(4.9), 4);
    assert.strictEqual(toCount(10), 10);
  });
});

describe('computeCashTotals', () => {
  test('counts times denomination, cent-accurate (safe audit 3 case)', () => {
    // bills: 3x100 4x50 10x20 3x10 2x5 10x1 = 750 ; coins: 25q 10d 5n 100p = 6.25+1+0.25+1 = 8.50
    const out = computeCashTotals(
      { hundreds:3, fifties:4, twenties:10, tens:3, fives:2, ones:10 },
      { halfDollars:0, quarters:25, dimes:10, nickels:5, pennies:100 });
    assert.strictEqual(out.billsTotal, 750);
    assert.strictEqual(out.coinsTotal, 8.50);
    assert.strictEqual(out.countedTotal, 758.50);
  });
  test('missing/blank denominations treated as 0', () => {
    const out = computeCashTotals({ twenties:'', hundreds:'N/A' }, {});
    assert.strictEqual(out.countedTotal, 0);
  });
  test('no float drift on pennies', () => {
    const out = computeCashTotals({}, { pennies: 3 }); // 0.03 exactly
    assert.strictEqual(out.coinsTotal, 0.03);
  });
});

describe('computeVariance', () => {
  test('balanced within tolerance', () => {
    const r = computeVariance({ countedTotal: 500, receiptsTotal: 0, expected: 500 });
    assert.strictEqual(r.variance, 0); assert.strictEqual(r.status, 'balanced');
  });
  test('receipts count toward accounted', () => {
    const r = computeVariance({ countedTotal: 471.26, receiptsTotal: 28.74, expected: 500 });
    assert.strictEqual(r.accountedTotal, 500); assert.strictEqual(r.status, 'balanced');
  });
  test('short and over past tolerance', () => {
    assert.strictEqual(computeVariance({ countedTotal: 480, receiptsTotal: 0, expected: 500 }).status, 'short');
    assert.strictEqual(computeVariance({ countedTotal: 520, receiptsTotal: 0, expected: 500 }).status, 'over');
    assert.strictEqual(computeVariance({ countedTotal: 499.60, receiptsTotal: 0, expected: 500 }).status, 'balanced');
  });
});

describe('shouldAlert', () => {
  test('alerts on short beyond threshold or counterfeit', () => {
    assert.ok(shouldAlert({ variance: -5.00, hasCounterfeit: false }));
    assert.ok(shouldAlert({ variance: -5.01, hasCounterfeit: false }));
    assert.ok(!shouldAlert({ variance: -4.99, hasCounterfeit: false }));
    assert.ok(!shouldAlert({ variance: 50, hasCounterfeit: false })); // over never alerts
    assert.ok(shouldAlert({ variance: 0, hasCounterfeit: true }));
  });
});

describe('constants', () => {
  test('denominations and reasons match spec', () => {
    assert.strictEqual(BILL_VALUES.hundreds, 100);
    assert.strictEqual(COIN_VALUES.pennies, 0.01);
    assert.strictEqual(DISPLAY_TOLERANCE, 0.50);
    assert.strictEqual(SHORTAGE_ALERT_THRESHOLD, 5.00);
    assert.deepStrictEqual(REASONS, ['Random','Scheduled','Cash Discrepancy','Manager Change','Shift Change','Other']);
  });
});
