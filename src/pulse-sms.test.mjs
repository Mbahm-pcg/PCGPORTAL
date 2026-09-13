import { test, describe } from 'node:test';
import assert from 'node:assert';
import { fmtUSD, topStoresByWtd, buildPulseSms } from './pulse-sms.mjs';

const STORES = [
  { pc: '100', name: 'County Line' },
  { pc: '200', name: '8200' },
  { pc: '300', name: 'Warrington' },
  { pc: '400', name: 'Lansdowne' },
  { pc: '500', name: 'Elkins' },
  { pc: '600', name: 'Willits' },
];

describe('fmtUSD', () => {
  test('comma-grouped, 2 decimals', () => {
    assert.strictEqual(fmtUSD(124530.47), '$124,530.47');
  });
  test('whole number gets .00', () => {
    assert.strictEqual(fmtUSD(40000), '$40,000.00');
  });
  test('zero / nullish', () => {
    assert.strictEqual(fmtUSD(0), '$0.00');
    assert.strictEqual(fmtUSD(null), '$0.00');
  });
});

describe('topStoresByWtd', () => {
  const wtd = { '100': 52300, '200': 49100, '300': 47800, '400': 45200, '500': 44900, '600': 60000 };
  test('sorts desc, limits to n, maps names', () => {
    const top = topStoresByWtd(wtd, STORES, {}, 5);
    assert.deepStrictEqual(top.map(s => s.name), ['Willits', 'County Line', '8200', 'Warrington', 'Lansdowne']);
    assert.strictEqual(top.length, 5);
    assert.strictEqual(top[0].wtd, 60000);
  });
  test('excludes non-operational stores', () => {
    const top = topStoresByWtd(wtd, STORES, { '600': 'Temp Closed' }, 5);
    assert.ok(!top.some(s => s.name === 'Willits'));
    assert.strictEqual(top[0].name, 'County Line');
  });
  test('fewer than n available', () => {
    const top = topStoresByWtd({ '100': 10, '200': 5 }, STORES, {}, 5);
    assert.strictEqual(top.length, 2);
  });
});

describe('buildPulseSms', () => {
  const base = { todaySales: 124530.47, wtdSales: 842100.19, perStoreWtd: {}, stores: STORES, statusByPc: {} };
  test('nightly (Fri 2026-09-11): 3 lines + closing, no Top 5', () => {
    const msg = buildPulseSms({ ...base, busDt: '2026-09-11' });
    assert.strictEqual(msg,
      'PCG Pulse Daily Update (Fri 9/11)\n' +
      "Today's Sales: $124,530.47\n" +
      'WTD Sales: $842,100.19\n' +
      'Have a Good Night');
  });
  test('Saturday (2026-09-12): adds Top 5 before closing', () => {
    const perStoreWtd = { '100': 52300, '200': 49100, '300': 47800, '400': 45200, '500': 44900 };
    const msg = buildPulseSms({ ...base, busDt: '2026-09-12', wtdSales: 990400.55, perStoreWtd });
    assert.strictEqual(msg,
      'PCG Pulse Daily Update (Sat 9/12)\n' +
      "Today's Sales: $124,530.47\n" +
      'WTD Sales: $990,400.55\n' +
      'Top 5:\n' +
      '1) County Line $52,300.00\n' +
      '2) 8200 $49,100.00\n' +
      '3) Warrington $47,800.00\n' +
      '4) Lansdowne $45,200.00\n' +
      '5) Elkins $44,900.00\n' +
      'Have a Good Night');
  });
});
