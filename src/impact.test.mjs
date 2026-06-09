import { test, describe } from 'node:test';
import assert from 'node:assert';
import { haversineMiles } from './impact.mjs';

describe('haversineMiles', () => {
  test('identical points → 0', () => {
    assert.strictEqual(haversineMiles({ lat: 39.92, lng: -75.18 }, { lat: 39.92, lng: -75.18 }), 0);
  });

  test('1° of latitude ≈ 69.1 miles', () => {
    const d = haversineMiles({ lat: 40.0, lng: -75.0 }, { lat: 41.0, lng: -75.0 });
    assert.ok(Math.abs(d - 69.09) < 0.5, `expected ~69.09, got ${d}`);
  });

  test('1° of longitude at 40°N ≈ 53.0 miles', () => {
    const d = haversineMiles({ lat: 40.0, lng: -75.0 }, { lat: 40.0, lng: -76.0 });
    assert.ok(Math.abs(d - 53.0) < 0.6, `expected ~53.0, got ${d}`);
  });

  test('two points ~0.40 mi apart (0.0058° lat)', () => {
    const d = haversineMiles({ lat: 39.9200, lng: -75.1800 }, { lat: 39.9258, lng: -75.1800 });
    assert.ok(Math.abs(d - 0.40) < 0.02, `expected ~0.40, got ${d}`);
  });
});

import { beforeAfter } from './impact.mjs';

// ── The real 18th-St weekly net-sales series, verbatim from PCG/18th-street-impact-claim.md §6 ──
// Event week = 2025-12-28 (competitor food license issued 2025-12-29).
const EIGHTEENTH_ST = [
  { weekOf: '2025-10-05', sales: 29308 }, { weekOf: '2025-10-12', sales: 29022 },
  { weekOf: '2025-10-19', sales: 30168 }, { weekOf: '2025-10-26', sales: 30075 },
  { weekOf: '2025-11-02', sales: 30000 }, { weekOf: '2025-11-09', sales: 29187 },
  { weekOf: '2025-11-16', sales: 29184 }, { weekOf: '2025-11-23', sales: 29818 },
  { weekOf: '2025-11-30', sales: 28135 }, { weekOf: '2025-12-07', sales: 28137 },
  { weekOf: '2025-12-14', sales: 27951 }, { weekOf: '2025-12-21', sales: 27220 },
  { weekOf: '2025-12-28', sales: 23507 }, // ← event week (last "before")
  { weekOf: '2026-01-04', sales: 23502 }, { weekOf: '2026-01-11', sales: 22479 },
  { weekOf: '2026-01-18', sales: 21647 }, { weekOf: '2026-01-25', sales: 17944 },
  { weekOf: '2026-02-01', sales: 20948 }, { weekOf: '2026-02-08', sales: 20951 },
  { weekOf: '2026-02-15', sales: 20115 }, { weekOf: '2026-02-22', sales: 18622 },
  { weekOf: '2026-03-01', sales: 20757 }, { weekOf: '2026-03-08', sales: 21585 },
  { weekOf: '2026-03-15', sales: 20837 }, { weekOf: '2026-03-22', sales: 20518 },
  { weekOf: '2026-03-29', sales: 20799 }, { weekOf: '2026-04-05', sales: 21043 },
  { weekOf: '2026-04-12', sales: 21575 }, { weekOf: '2026-04-19', sales: 20257 },
  { weekOf: '2026-04-26', sales: 22571 }, { weekOf: '2026-05-03', sales: 22297 },
  { weekOf: '2026-05-10', sales: 22781 },
];

describe('beforeAfter — formula exactness vs the claim headline', () => {
  // Two synthetic weeks whose averages ARE the claim's stated figures.
  // Proves the formula reproduces −28.9% / $429,154 exactly.
  test('avgBefore=28593, avgAfter=20340 → −28.9% / ~$429k', () => {
    const series = [
      { weekOf: '2025-12-21', sales: 28593 }, // before
      { weekOf: '2026-01-04', sales: 20340 }, // after
    ];
    const r = beforeAfter(series, '2025-12-28', 13, null);
    assert.strictEqual(Math.round(r.avgBefore), 28593);
    assert.strictEqual(Math.round(r.avgAfter), 20340);
    assert.ok(Math.abs(r.deltaPct - -28.86) < 0.05, `deltaPct ${r.deltaPct}`);
    assert.ok(Math.abs(r.annualizedLoss - 429156) < 100, `annualizedLoss ${r.annualizedLoss}`);
  });
});

describe('beforeAfter — real 18th-St series (event week → before)', () => {
  const r = beforeAfter(EIGHTEENTH_ST, '2025-12-28', 13, null); // 13 before, "through now" after

  test('reproduces the claim avgBefore to the dollar ($28,593)', () => {
    assert.strictEqual(Math.round(r.avgBefore), 28593);
    assert.strictEqual(r.weeksBeforeUsed, 13);
  });

  test('after-side regression lock (live table extends through spring recovery)', () => {
    assert.strictEqual(r.weeksAfterUsed, 19);
    assert.strictEqual(Math.round(r.avgAfter), 21117);
    assert.ok(Math.abs(r.deltaPct - -26.15) < 0.1, `deltaPct ${r.deltaPct}`);
    assert.ok(Math.abs(r.annualizedLoss - 388750) < 200, `annualizedLoss ${r.annualizedLoss}`);
  });

  test('is directionally consistent with the manual claim (within ~10%)', () => {
    assert.ok(r.deltaPct < -23 && r.deltaPct > -32, `deltaPct ${r.deltaPct}`);
    assert.ok(r.annualizedLoss > 360000 && r.annualizedLoss < 460000, `loss ${r.annualizedLoss}`);
  });

  test('series carries before/after side labels for charting', () => {
    assert.strictEqual(r.series.length, 32);
    assert.strictEqual(r.series[0].side, 'before');
    assert.strictEqual(r.series.find(s => s.weekOf === '2025-12-28').side, 'before');
    assert.strictEqual(r.series.find(s => s.weekOf === '2026-01-04').side, 'after');
  });
});

describe('beforeAfter — windowing & guardrails', () => {
  test('weeksBefore caps how many pre-event weeks are averaged', () => {
    const r = beforeAfter(EIGHTEENTH_ST, '2025-12-28', 4, null);
    // last 4 before-or-equal weeks: 12/07,12/14,12/21,12/28 = 28137,27951,27220,23507
    assert.strictEqual(r.weeksBeforeUsed, 4);
    assert.strictEqual(Math.round(r.avgBefore), Math.round((28137 + 27951 + 27220 + 23507) / 4));
  });

  test('weeksAfter caps how many post-event weeks are averaged', () => {
    const r = beforeAfter(EIGHTEENTH_ST, '2025-12-28', 13, 3);
    // first 3 after weeks: 01/04,01/11,01/18 = 23502,22479,21647
    assert.strictEqual(r.weeksAfterUsed, 3);
    assert.strictEqual(Math.round(r.avgAfter), Math.round((23502 + 22479 + 21647) / 3));
  });

  test('empty / no-after series degrades safely', () => {
    const r = beforeAfter([{ weekOf: '2025-12-21', sales: 1000 }], '2025-12-28', 13, null);
    assert.strictEqual(r.weeksAfterUsed, 0);
    assert.strictEqual(r.avgAfter, 0);
    assert.strictEqual(r.deltaPct, 0);
  });
});

import { pickControls } from './impact.mjs';

describe('pickControls', () => {
  // ranked = stores sorted ascending by distance from the event (impacted is nearest)
  const ranked = [
    { pc: 'A', distance: 0.4 }, // impacted
    { pc: 'B', distance: 0.8 },
    { pc: 'C', distance: 1.6 },
    { pc: 'D', distance: 2.9 },
    { pc: 'E', distance: 4.2 },
    { pc: 'F', distance: 7.1 },
  ];

  test('excludes the impacted store and returns a near/mid/far trio', () => {
    const controls = pickControls(ranked, 'A', 3);
    assert.strictEqual(controls.length, 3);
    assert.ok(!controls.some((s) => s.pc === 'A'), 'impacted excluded');
    assert.strictEqual(controls[0].pc, 'B'); // near = closest non-impacted
    assert.strictEqual(controls[2].pc, 'F'); // far = farthest
    assert.ok(controls[1].distance > controls[0].distance && controls[1].distance < controls[2].distance, 'mid is between');
  });

  test('returns all available when fewer than n controls exist', () => {
    const controls = pickControls([{ pc: 'A', distance: 0 }, { pc: 'B', distance: 1 }], 'A', 3);
    assert.deepStrictEqual(controls.map((s) => s.pc), ['B']);
  });

  test('n=1 returns the nearest control', () => {
    assert.deepStrictEqual(pickControls(ranked, 'A', 1).map((s) => s.pc), ['B']);
  });
});

import { isoWeekStartFromEnd, weeklyFromScorecard } from './impact.mjs';

describe('isoWeekStartFromEnd', () => {
  test('week-end Saturday → Sunday week-of (−6 days)', () => {
    assert.strictEqual(isoWeekStartFromEnd('01/03/2026'), '2025-12-28'); // matches claim event week
    assert.strictEqual(isoWeekStartFromEnd('10/11/2025'), '2025-10-05'); // matches claim first week
  });
  test('2-digit year', () => {
    assert.strictEqual(isoWeekStartFromEnd('01/03/26'), '2025-12-28');
  });
  test('unparseable → null', () => {
    assert.strictEqual(isoWeekStartFromEnd('not-a-date'), null);
    assert.strictEqual(isoWeekStartFromEnd(''), null);
    assert.strictEqual(isoWeekStartFromEnd(null), null);
  });
});

describe('weeklyFromScorecard', () => {
  const salesWeeks = [
    { weekEnd: '01/03/2026', stores: [{ pc: '304863', lwSale: 23507 }, { pc: '354561', lwSale: 23266 }] },
    { weekEnd: '10/11/2025', stores: [{ pc: '304863', lwSale: 29308 }] },
    { weekEnd: '12/27/2025', stores: [{ pc: '304863', lwSale: 27220 }, { pc: '354561', lwSale: 23748 }] },
  ];

  test('maps a store to ascending {weekOf, sales} using lwSale', () => {
    const s = weeklyFromScorecard(salesWeeks, '304863');
    assert.deepStrictEqual(s, [
      { weekOf: '2025-10-05', sales: 29308 },
      { weekOf: '2025-12-21', sales: 27220 },
      { weekOf: '2025-12-28', sales: 23507 },
    ]);
  });

  test('drops weeks where the store is missing or sales <= 0', () => {
    const s = weeklyFromScorecard(salesWeeks, '354561');
    assert.deepStrictEqual(s.map((x) => x.weekOf), ['2025-12-21', '2025-12-28']);
  });

  test('feeds beforeAfter end-to-end (event week → before)', () => {
    const series = weeklyFromScorecard(salesWeeks, '304863');
    const r = beforeAfter(series, '2025-12-28', 13, null);
    assert.strictEqual(r.weeksBeforeUsed, 3);   // all 3 weeks are <= event date
    assert.strictEqual(r.weeksAfterUsed, 0);
  });

  test('empty / missing input → []', () => {
    assert.deepStrictEqual(weeklyFromScorecard(null, '304863'), []);
    assert.deepStrictEqual(weeklyFromScorecard([], '304863'), []);
  });
});
