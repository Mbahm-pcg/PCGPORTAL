const { test, describe } = require('node:test');
const assert = require('node:assert');
const { computeStorePnL, computeCogs, DEFAULT_COGS_PCT, BOM_COVERAGE_THRESHOLD } = require('./pnl-calc');

// Deterministic cost lookup for tests: latte $1, sandwich $2, everything else unknown.
const costOf = (name) => ({ Latte: 1, Sandwich: 2 }[name]);

describe('computeCogs', () => {
  test('zero / missing revenue → cogs 0, est', () => {
    assert.deepStrictEqual(computeCogs([], costOf, 0, 0.29), { cogs: 0, method: 'est', coverage: 0 });
  });

  test('no menu mix → category-% fallback (est)', () => {
    const r = computeCogs([], costOf, 1000, 0.29);
    assert.strictEqual(r.method, 'est');
    assert.strictEqual(r.cogs, 290); // 1000 * 0.29
  });

  test('high coverage → BOM (covered cost + estimated tail)', () => {
    // 900 of 1000 revenue is covered by known-cost items (90% ≥ 85% threshold)
    const mix = [
      { name: 'Latte',    slsCnt: 100, slsTtl: 600 }, // cost 100
      { name: 'Sandwich', slsCnt: 100, slsTtl: 300 }, // cost 200
      { name: 'Mystery',  slsCnt: 50,  slsTtl: 100 }, // unknown
    ];
    const r = computeCogs(mix, costOf, 1000, 0.29);
    assert.strictEqual(r.method, 'BOM');
    // covered cost 300 + tail (1000-900)*0.29 = 29 → 329
    assert.strictEqual(r.cogs, 329);
    assert.ok(r.coverage >= BOM_COVERAGE_THRESHOLD);
  });

  test('mid coverage below threshold → est fallback', () => {
    // 800 of 1000 covered = 80% < 85% → est on full revenue
    const mix = [
      { name: 'Latte',    slsCnt: 100, slsTtl: 500 },
      { name: 'Sandwich', slsCnt: 100, slsTtl: 300 },
      { name: 'Mystery',  slsCnt: 50,  slsTtl: 200 },
    ];
    const r = computeCogs(mix, costOf, 1000, 0.29);
    assert.strictEqual(r.method, 'est');
    assert.strictEqual(r.cogs, 290);
  });

  test('low coverage → est fallback on full revenue', () => {
    const mix = [{ name: 'Latte', slsCnt: 10, slsTtl: 50 }]; // only 50 of 1000 covered
    const r = computeCogs(mix, costOf, 1000, 0.29);
    assert.strictEqual(r.method, 'est');
    assert.strictEqual(r.cogs, 290);
  });

  test('invalid cogsPct falls back to DEFAULT_COGS_PCT', () => {
    const r = computeCogs([], costOf, 1000, 0);
    assert.strictEqual(r.cogs, Math.round(1000 * DEFAULT_COGS_PCT * 100) / 100);
  });
});

describe('computeStorePnL', () => {
  test('contribution = revenue − labor − cogs, with percentages', () => {
    const mix = [
      { name: 'Latte',    slsCnt: 100, slsTtl: 600 }, // 90% coverage → BOM
      { name: 'Sandwich', slsCnt: 100, slsTtl: 300 },
      { name: 'Mystery',  slsCnt: 50,  slsTtl: 100 },
    ];
    const p = computeStorePnL({ revenue: 1000, labor: 250, menuMix: mix, cogsPct: 0.29 }, costOf);
    assert.strictEqual(p.cogs, 329);          // covered 300 + tail (100)*0.29 = 29
    assert.strictEqual(p.contribution, 421);  // 1000 - 250 - 329
    assert.strictEqual(p.marginPct, 42.1);
    assert.strictEqual(p.laborPct, 25);
    assert.strictEqual(p.cogsPct, 32.9);
    assert.strictEqual(p.method, 'BOM');
  });

  test('zero-revenue guard → all percentages 0, no divide-by-zero', () => {
    const p = computeStorePnL({ revenue: 0, labor: 0, menuMix: [], cogsPct: 0.29 }, costOf);
    assert.strictEqual(p.marginPct, 0);
    assert.strictEqual(p.laborPct, 0);
    assert.strictEqual(p.cogsPct, 0);
    assert.strictEqual(p.contribution, 0);
  });
});
