const { test } = require('node:test');
const assert = require('node:assert');
const { summarize } = require('./summary');

test('summarize rolls enriched orders into totals, byWeek, byDistrict, byStore', () => {
  const orders = [
    { account: '339616', total_order: 1000, date_ordered: '06/03/2026' }, // D1, week 05-31
    { account: '339616', total_order:  500, date_ordered: '06/10/2026' }, // D1, week 06-07
    { account: '345986', total_order:  200, date_ordered: '06/04/2026' }, // D7, week 05-31
    { account: '999999', total_order:   50, date_ordered: '06/04/2026' }, // unmapped
  ];
  const s = summarize(orders);
  assert.equal(s.totals.orders, 4);
  assert.equal(s.totals.spend, 1750);
  assert.equal(s.byWeek['2026-05-31'].spend, 1250); // 1000+200+50 (unmapped also counted in byWeek)
  assert.equal(s.byWeek['2026-06-07'].spend, 500);
  assert.equal(s.byDistrict['1'].spend, 1500);
  assert.equal(s.byDistrict['1'].dmName, 'Taylor Cormier');
  assert.equal(s.byStore['339616'].spend, 1500);
  assert.equal(s.byStore['339616'].name, 'Wadsworth');
  assert.equal(s.unmapped.spend, 50); // never silently dropped
});
