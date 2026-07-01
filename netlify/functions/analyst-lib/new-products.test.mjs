// Unit tests for new-products.mjs — run: node netlify/functions/analyst-lib/new-products.test.mjs
import assert from 'node:assert';
import { productTerms, matchNewProducts, analyzeNewProducts } from './new-products.mjs';

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };

const registry = [
  { id: 'coldfoam', name: 'Cold Foam Coffee', terms: ['cold foam'], launchDate: '2026-06-15', category: 'cold_beverages' },
];

test('productTerms falls back to the name when no explicit terms', () => {
  assert.deepStrictEqual(productTerms({ name: 'Churro Donut' }), ['churro donut']);
});

test('matchNewProducts matches on a substring term', () => {
  assert.deepStrictEqual(matchNewProducts(registry, 'Medium Cold Foam Coffee'), ['coldfoam']);
  assert.deepStrictEqual(matchNewProducts(registry, 'Iced Latte'), []);
});

test('analyzeNewProducts rolls up adoption + ramp + top stores', () => {
  const histories = [
    { store: { pc: 1, name: 'A', district: 1 }, history: [
      { date: '2026-06-16', newProducts: { coldfoam: { units: 10, sales: 40 } } },
      { date: '2026-06-15', newProducts: { coldfoam: { units: 5, sales: 20 } } },
    ] },
    { store: { pc: 2, name: 'B', district: 1 }, history: [
      { date: '2026-06-16', newProducts: { coldfoam: { units: 3, sales: 12 } } },
    ] },
    { store: { pc: 3, name: 'C', district: 1 }, history: [] }, // not selling yet
  ];
  const [p] = analyzeNewProducts(registry, histories);
  assert.strictEqual(p.totalUnits, 18);
  assert.strictEqual(p.adoption.selling, 2);
  assert.strictEqual(p.adoption.of, 3);
  assert.strictEqual(p.adoption.pct, 67);
  assert.strictEqual(p.topStores[0].pc, 1); // A sold the most
  // ramp: day 0 (06-15)=5, day 1 (06-16)=13
  assert.deepStrictEqual(p.ramp, [{ day: 0, units: 5 }, { day: 1, units: 13 }]);
});

test('analyzeNewProducts ignores pre-launch sales', () => {
  const [p] = analyzeNewProducts(registry, [
    { store: { pc: 1, name: 'A', district: 1 }, history: [
      { date: '2026-06-10', newProducts: { coldfoam: { units: 99, sales: 400 } } }, // before launch
      { date: '2026-06-16', newProducts: { coldfoam: { units: 4, sales: 16 } } },
    ] },
  ]);
  assert.strictEqual(p.totalUnits, 4);
});

console.log(`\n${pass} tests passed.`);
