// Unit tests for sales-mix-compare.mjs — run: node netlify/functions/analyst-lib/sales-mix-compare.test.mjs
import assert from 'node:assert';
import { storeMixProfile, districtAverageShares, compareCrossStore, analyzeCrossStoreMix } from './sales-mix-compare.mjs';

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };

// A store whose mix is 20% hot / 80% bakery over two days.
const hist = [
  { date: '2026-07-01', dow: 2, categories: { hot_beverages: { sales: 200 }, bakery: { sales: 800 } } },
  { date: '2026-06-24', dow: 2, categories: { hot_beverages: { sales: 200 }, bakery: { sales: 800 } } },
];

test('storeMixProfile computes volume-weighted share-of-mix', () => {
  const p = storeMixProfile(hist);
  assert.strictEqual(p.shares.hot_beverages, 20);
  assert.strictEqual(p.shares.bakery, 80);
  assert.strictEqual(p.totalSales, 2000);
  assert.strictEqual(p.samples, 2);
});

test('storeMixProfile returns null below the total-sales floor', () => {
  assert.strictEqual(storeMixProfile([{ categories: { hot_beverages: { sales: 10 } } }]), null);
});

test('districtAverageShares divides by full peer count (a zero-espresso store drags the avg down)', () => {
  const avg = districtAverageShares([
    { shares: { hot_beverages: 30 } },
    { shares: { hot_beverages: 30 } },
    { shares: { bakery: 100 } }, // sells no hot_beverages
  ]);
  assert.strictEqual(avg.avgShares.hot_beverages, 20); // (30+30+0)/3
  assert.strictEqual(avg.storeCount, 3);
});

test('compareCrossStore flags a store ~40% below district espresso share', () => {
  const profiles = [
    { pc: 220, name: 'Store 220', district: 1, totalSales: 1000, shares: { hot_beverages: 18, bakery: 82 } },
    { pc: 221, name: 'Store 221', district: 1, totalSales: 1000, shares: { hot_beverages: 30, bakery: 70 } },
    { pc: 222, name: 'Store 222', district: 1, totalSales: 1000, shares: { hot_beverages: 30, bakery: 70 } },
    { pc: 223, name: 'Store 223', district: 1, totalSales: 1000, shares: { hot_beverages: 30, bakery: 70 } },
  ];
  const out = compareCrossStore(profiles);
  const s220 = out.find(r => r.pc === 220);
  const hb = s220.outliers.find(o => o.category === 'hot_beverages');
  assert.strictEqual(hb.direction, 'below');
  // district avg hot = (18+30+30+30)/4 = 27; gap = (27-18)/27 ≈ 33%
  assert.strictEqual(hb.gapPct, 33);
});

test('compareCrossStore needs minPeers — a 2-store district yields nothing', () => {
  const out = compareCrossStore([
    { pc: 1, name: 'A', district: 9, totalSales: 1000, shares: { hot_beverages: 10, bakery: 90 } },
    { pc: 2, name: 'B', district: 9, totalSales: 1000, shares: { hot_beverages: 50, bakery: 50 } },
  ], { minPeers: 3 });
  assert.strictEqual(out.length, 0);
});

test('analyzeCrossStoreMix end-to-end from histories', () => {
  const low = [ { categories: { hot_beverages: { sales: 100 }, bakery: { sales: 900 } } } ];
  const norm = [ { categories: { hot_beverages: { sales: 300 }, bakery: { sales: 700 } } } ];
  const out = analyzeCrossStoreMix([
    { store: { pc: 1, name: 'Low', district: 5 }, history: low },
    { store: { pc: 2, name: 'N2', district: 5 }, history: norm },
    { store: { pc: 3, name: 'N3', district: 5 }, history: norm },
    { store: { pc: 4, name: 'N4', district: 5 }, history: norm },
  ]);
  const lowStore = out.find(r => r.pc === 1);
  assert(lowStore && lowStore.outliers.some(o => o.category === 'hot_beverages' && o.direction === 'below'));
});

console.log(`\n${pass} tests passed.`);
