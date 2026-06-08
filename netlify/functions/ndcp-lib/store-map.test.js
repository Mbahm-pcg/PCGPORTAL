const { test } = require('node:test');
const assert = require('node:assert');
const { enrich, weekOf, dcpPct, STORE_BY_PC } = require('./store-map');

test('STORE_BY_PC has all 45 stores keyed by pc string', () => {
  assert.equal(Object.keys(STORE_BY_PC).length, 45);
  // Wadsworth (pc 339616) and Willits (pc 345986) are known anchors
  assert.equal(STORE_BY_PC['339616'].district, 1);
  assert.ok(STORE_BY_PC['345986']); // Willits
});

test('enrich joins an order to its store via account == pc', () => {
  const e = enrich({ account: '339616', store_name: 'KJ Donuts Inc', total_order: 100, date_ordered: '06/03/2026' });
  assert.equal(e.pc, '339616');
  assert.equal(e.district, 1);
  assert.ok(e.name && e.name !== 'KJ Donuts Inc'); // real store name, not billing entity
  assert.ok(e.dmName);
  assert.equal(e.unmapped, false);
  assert.equal(e.weekKey, '2026-05-31'); // Sun of the week containing Wed 06/03/2026
});

test('enrich flags an unknown account as unmapped, keeping the billing name', () => {
  const e = enrich({ account: '999999', store_name: 'MYSTERY LLC', total_order: 50 });
  assert.equal(e.pc, null);
  assert.equal(e.unmapped, true);
  assert.equal(e.name, 'MYSTERY LLC');
  assert.equal(e.district, null);
});

test('weekOf returns the Sunday (YYYY-MM-DD) of the week, handling Sun and Sat edges', () => {
  assert.equal(weekOf('06/03/2026'), '2026-05-31'); // Wed
  assert.equal(weekOf('05/31/2026'), '2026-05-31'); // Sun -> itself
  assert.equal(weekOf('06/06/2026'), '2026-05-31'); // Sat -> prior Sun
  assert.equal(weekOf('2026-06-07'), '2026-06-07'); // next Sun (ISO input)
  assert.equal(weekOf(''), null);
  assert.equal(weekOf(null), null);
});

test('dcpPct returns spend/sales*100, or null when sales missing/zero', () => {
  assert.equal(dcpPct(2000, 10000), 20);
  assert.equal(dcpPct(0, 10000), 0);
  assert.equal(dcpPct(2000, 0), null);
  assert.equal(dcpPct(2000, null), null);
  assert.equal(dcpPct(null, 10000), null);
});
