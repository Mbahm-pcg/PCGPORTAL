// Unit tests for sales-attribution.mjs — run: node netlify/functions/analyst-lib/sales-attribution.test.mjs
import assert from 'node:assert';
import { ticketAffectedCategories, detectCategoryDrops, attributeDrops, analyzeStoreMix } from './sales-attribution.mjs';

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log(`  ✓ ${name}`); };

// Build a history newest-first: today (dow=2/Tue) with a hot_beverages drop, plus prior Tuesdays.
const hist = [
  { date: '2026-07-01', dow: 2, categories: { hot_beverages: { sales: 300 }, bakery: { sales: 500 } } }, // today: hot -70%
  { date: '2026-06-24', dow: 2, categories: { hot_beverages: { sales: 1000 }, bakery: { sales: 510 } } },
  { date: '2026-06-17', dow: 2, categories: { hot_beverages: { sales: 1000 }, bakery: { sales: 490 } } },
  { date: '2026-06-10', dow: 2, categories: { hot_beverages: { sales: 1000 }, bakery: { sales: 500 } } },
];

test('ticketAffectedCategories maps espresso → hot_beverages', () => {
  const cats = ticketAffectedCategories({ title: 'Espresso machine down', category: 'Equipment' });
  assert(cats.has('hot_beverages'));
  assert(!cats.has('all'));
});

test('ticketAffectedCategories maps POS → all (throughput)', () => {
  assert(ticketAffectedCategories({ title: 'POS register frozen' }).has('all'));
});

test('detectCategoryDrops flags the hot_beverages drop, not bakery', () => {
  const drops = detectCategoryDrops(hist);
  const cats = drops.map(d => d.category);
  assert(cats.includes('hot_beverages'), 'should flag hot_beverages');
  assert(!cats.includes('bakery'), 'bakery is flat — should NOT flag');
  const hb = drops.find(d => d.category === 'hot_beverages');
  assert.strictEqual(hb.dropPct, 70);
  assert.strictEqual(hb.lostSales, 700);
});

test('attributeDrops prefers the SPECIFIC ticket over a generic POS ticket', () => {
  const drops = detectCategoryDrops(hist);
  const out = attributeDrops(drops, [
    { number: 'POS1', title: 'POS slow', status: 'Open', createdAt: '2026-06-30' },
    { number: 'ESP1', title: 'Espresso machine down', status: 'Open', createdAt: '2026-06-30' },
  ]);
  const hb = out.find(d => d.category === 'hot_beverages');
  assert.strictEqual(hb.cause.ticketNumber, 'ESP1', 'espresso ticket should win over POS');
  assert.strictEqual(hb.cause.confidence, 'high');
});

test('attributeDrops respects temporal causality (ticket opened AFTER the drop is not credited)', () => {
  const drops = detectCategoryDrops(hist);
  const out = attributeDrops(drops, [
    { number: 'LATE', title: 'Espresso machine down', status: 'Open', createdAt: '2026-07-05' }, // after 2026-07-01
  ]);
  const hb = out.find(d => d.category === 'hot_beverages');
  assert.strictEqual(hb.cause, null, 'a ticket opened after the drop day must not explain it');
});

test('closed tickets are ignored', () => {
  const out = analyzeStoreMix(hist, [
    { number: 'C1', title: 'Espresso machine down', status: 'Closed', createdAt: '2026-06-30' },
  ]);
  assert.strictEqual(out.find(d => d.category === 'hot_beverages').cause, null);
});

console.log(`\n${pass} tests passed.`);
