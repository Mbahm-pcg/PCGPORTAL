// analyst-cron-helpers.test.mjs — the pure like-for-like helpers the DM scorecard grades on.
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { storeLaborWindow, storeSalesGrowth, trailingWeeksSales } from '../analyst-cron.mjs';

// Monday-start weeks. "today" below is Wed 2026-10-28; thisMonday 2026-10-26.
const blob = {
  daily: [
    { date: '2026-10-27', sales: 5000, laborDollars: 1100 }, // Tue (complete)
    { date: '2026-10-26', sales: 4000, laborDollars: 1000 }, // Mon (complete)
    { date: '2026-10-20', sales: 4800, laborDollars: 1200 }, // last Tue
    { date: '2026-10-19', sales: 3900, laborDollars: 900 },  // last Mon
  ],
  weekly: [
    { weekOf: '2026-10-26', sales: 9000, laborDollars: 2100, laborPct: 23.3 }, // current (partial)
    { weekOf: '2026-10-19', sales: 30000, laborDollars: 6600, laborPct: 22.0 },
    { weekOf: '2026-10-12', sales: 29000, laborDollars: 6700, laborPct: 23.1 },
  ],
};

describe('storeLaborWindow', () => {
  test('mid-week: complete days of this week only, dollars and sales summed', () => {
    const w = storeLaborWindow(blob, '2026-10-28', '2026-10-26');
    assert.deepStrictEqual({ laborDollars: w.laborDollars, sales: w.sales }, { laborDollars: 2100, sales: 9000 });
    assert.match(w.basis, /Mon-Tue this week/);
  });
  test('Monday morning (no complete day yet): the last complete week, never the live WTD', () => {
    const w = storeLaborWindow(blob, '2026-10-26', '2026-10-26');
    assert.deepStrictEqual({ laborDollars: w.laborDollars, sales: w.sales }, { laborDollars: 6600, sales: 30000 });
    assert.strictEqual(w.basis, 'last complete week');
  });
  test('nothing usable returns null', () => {
    assert.strictEqual(storeLaborWindow(null, '2026-10-26', '2026-10-26'), null);
    assert.strictEqual(storeLaborWindow({ daily: [], weekly: [] }, '2026-10-26', '2026-10-26'), null);
  });
});

describe('storeSalesGrowth / trailingWeeksSales', () => {
  test('mid-week: same weekdays this week vs last week', () => {
    const g = storeSalesGrowth(blob, '2026-10-28', '2026-10-26');
    assert.strictEqual(Math.round(g.pct * 10) / 10, Math.round(((9000 - 8700) / 8700) * 1000) / 10);
    assert.match(g.basis, /Mon-Tue this week vs the same days last week/);
  });
  test('Monday: last complete week vs the week before', () => {
    const g = storeSalesGrowth(blob, '2026-10-26', '2026-10-26');
    assert.strictEqual(Math.round(g.pct * 10) / 10, Math.round(((30000 - 29000) / 29000) * 1000) / 10);
    assert.strictEqual(g.basis, 'last complete week vs the week before');
  });
  test('trailing complete weeks exclude the current one', () => {
    assert.strictEqual(trailingWeeksSales(blob, '2026-10-26', 4), 59000);
  });
});
