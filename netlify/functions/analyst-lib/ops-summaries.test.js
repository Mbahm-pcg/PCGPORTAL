const { test, describe } = require('node:test');
const assert = require('node:assert');
const { summarizeProjects, summarizeTickets, summarizeCash, summarizeFoodCost, compactComputed } = require('./ops-summaries');

// Small store fixture (mirrors STORES shape)
const STORES_FIX = [
  { pc: '342144', name: 'Westchester', district: 6 },
  { pc: '339616', name: 'Wadsworth', district: 1 },
];
const NOW = new Date('2026-06-09T12:00:00Z');

describe('summarizeProjects', () => {
  test('empty/missing blob → available:false', () => {
    assert.deepStrictEqual(summarizeProjects(null, null, NOW, STORES_FIX), { available: false });
    assert.deepStrictEqual(summarizeProjects([], null, NOW, STORES_FIX), { available: false });
  });

  test('derives district from pc, daysBehind from target, variance from budget', () => {
    const raw = [{
      id: 1, nickname: 'West Chester', pc: '342144', district: null, type: 'Remodel',
      dueDate: '2026-07-01', constructionCompleteBy: '2026-06-01', completed: false,
      totalBudget: '$100,000', spentToDate: '120000', gc: 'Jane Doe', gcCompany: 'Premier',
      utilities: { electric: { provider: 'Peco', status: 'In Progress' } },
      dcpDeliveryDate: '2026-06-20', notes: 'on it',
    }];
    const r = summarizeProjects(raw, null, NOW, STORES_FIX);
    assert.strictEqual(r.available, true);
    const p = r.projects[0];
    assert.strictEqual(p.district, 6);              // from STORES, not the null on the record
    assert.strictEqual(p.targetCompletion, '2026-06-01'); // constructionCompleteBy wins over dueDate
    assert.strictEqual(p.daysBehind, 8);            // 6/1 → 6/9
    assert.strictEqual(p.atRisk, true);
    assert.strictEqual(p.budget, 100000);           // '$100,000' coerced
    assert.strictEqual(p.actualCost, 120000);       // '120000' coerced
    assert.strictEqual(p.variancePct, 20);          // (120k-100k)/100k
    assert.strictEqual(p.gc, 'Jane Doe');
    assert.deepStrictEqual(p.utilities, ['electric: In Progress (Peco)']);
    assert.strictEqual(p.nextMilestone, 'DCP delivery 2026-06-20');
    assert.strictEqual(r.counts.behind, 1);
  });

  test('district filter excludes other districts; completed excluded from list', () => {
    const raw = [
      { id: 1, nickname: 'A', pc: '342144', type: 'Remodel', dueDate: '2026-08-01', completed: false },
      { id: 2, nickname: 'B', pc: '339616', type: 'Remodel', dueDate: '2026-08-01', completed: false },
      { id: 3, nickname: 'C', pc: '342144', type: 'Remodel', dueDate: '2026-01-01', completed: true },
    ];
    const r = summarizeProjects(raw, 6, NOW, STORES_FIX);
    assert.strictEqual(r.projects.length, 1);
    assert.strictEqual(r.projects[0].name, 'A');
    assert.strictEqual(r.counts.completed, 1);      // counts still see scope-wide completed
  });

  test('no budget → variancePct null; FK vendor ids are not exposed', () => {
    const raw = [{ id: 1, nickname: 'A', pc: '342144', type: 'Remodel', dueDate: '2026-08-01', completed: false, attorney: 'att1' }];
    const p = summarizeProjects(raw, null, NOW, STORES_FIX).projects[0];
    assert.strictEqual(p.budget, null);
    assert.strictEqual(p.variancePct, null);
    assert.ok(!JSON.stringify(p).includes('att1'));
  });

  test('garbage money strings coerce to null, empty string to null', () => {
    const raw = [{ id: 1, nickname: 'A', pc: '342144', type: 'Remodel', dueDate: '2026-08-01', completed: false, totalBudget: 'TBD', spentToDate: '' }];
    const p = summarizeProjects(raw, null, NOW, STORES_FIX).projects[0];
    assert.strictEqual(p.budget, null);
    assert.strictEqual(p.actualCost, null);
  });
});

describe('summarizeTickets', () => {
  const mkTicket = (over = {}) => ({
    id: 1780950032935, number: 'T-0001', title: 'Ice machine down', storePC: '339616',
    storeName: 'Wadsworth', category: 'Equipment Repair / Maintenance', priority: 'Medium',
    dueDate: '2026-06-11', status: 'In Progress', ticketOwner: 'Clarence Jackson',
    createdAt: '2026-06-01T08:00:00Z',
    attachments: [{ name: 'image.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }],
    comments: [{ text: 'big blob of chatter' }],
    ...over,
  });

  test('empty → available:false', () => {
    assert.deepStrictEqual(summarizeTickets(null, null, NOW, STORES_FIX), { available: false });
  });

  test('open ticket summarized with ageDays, owner; attachments/comments stripped', () => {
    const r = summarizeTickets([mkTicket()], null, NOW, STORES_FIX);
    assert.strictEqual(r.totalOpen, 1);
    const t = r.tickets[0];
    assert.strictEqual(t.owner, 'Clarence Jackson');
    assert.strictEqual(t.ageDays, 8);
    assert.strictEqual(t.district, 1);
    const s = JSON.stringify(r);
    assert.ok(!s.includes('dataUrl') && !s.includes('base64') && !s.includes('chatter'));
  });

  test('closed statuses excluded; aging buckets and critical list', () => {
    const r = summarizeTickets([
      mkTicket({ id: 1, status: 'Completed' }),
      mkTicket({ id: 2, createdAt: '2026-05-20T08:00:00Z', priority: 'High' }), // 20 days old
      mkTicket({ id: 3, createdAt: '2026-06-08T08:00:00Z' }),                   // 1 day old
    ], null, NOW, STORES_FIX);
    assert.strictEqual(r.totalOpen, 2);
    assert.deepStrictEqual(r.aging, { gt7: 1, gt14: 1 });
    assert.strictEqual(r.critical.length, 1);
    assert.strictEqual(r.tickets[0].ageDays, 20); // oldest first
    assert.strictEqual(r.openByStore[0].open, 2);
  });

  test('district filter', () => {
    const r = summarizeTickets([mkTicket()], 6, NOW, STORES_FIX); // Wadsworth is district 1
    assert.strictEqual(r.totalOpen, 0);
  });

  test('critical list is sorted oldest-first before the cap', () => {
    const r = summarizeTickets([
      mkTicket({ id: 1, createdAt: '2026-06-05T08:00:00Z', priority: 'High' }), // 4 days
      mkTicket({ id: 2, createdAt: '2026-05-20T08:00:00Z', priority: 'High' }), // 20 days
    ], null, NOW, STORES_FIX);
    assert.strictEqual(r.critical[0].ageDays, 20);
  });

  test('openByStore keys by PC — same display name at two PCs does not collide', () => {
    const r = summarizeTickets([
      mkTicket({ id: 1, storePC: '339616', storeName: 'Twin' }),
      mkTicket({ id: 2, storePC: '342144', storeName: 'Twin' }),
    ], null, NOW, STORES_FIX);
    assert.strictEqual(r.openByStore.length, 2);
    assert.ok(r.openByStore.every(s => s.open === 1));
  });
});

describe('summarizeCash', () => {
  const dep = (over = {}) => ({
    id: 'dep_1', depositDate: '2026-06-05', businessDates: ['2026-06-04'],
    pc: '339616', llcName: 'Rao 7 Inc', amount: 356.18, ...over,
  });

  test('empty → available:false', () => {
    assert.deepStrictEqual(summarizeCash(null, null, NOW, STORES_FIX), { available: false });
  });

  test('deposit detail with store name/district + totals', () => {
    const r = summarizeCash([dep()], null, NOW, STORES_FIX);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.deposits[0].store, 'Wadsworth');
    assert.strictEqual(r.deposits[0].district, 1);
    assert.strictEqual(r.last7Total, 356.18);
    assert.strictEqual(r.last30Total, 356.18);
  });

  test('missing deposits: uncovered business dates in window, 2-day buffer excluded', () => {
    // Store covered 6/1-6/4 only. Window = 5/26..6/7 (14 days back, minus 6/8 & 6/9 buffer).
    const deposits = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04']
      .map((d, i) => dep({ id: 'd' + i, businessDates: [d], depositDate: d }));
    const r = summarizeCash(deposits, null, NOW, STORES_FIX);
    const dates = r.missingDeposits.filter(m => m.store === 'Wadsworth').map(m => m.date);
    assert.ok(dates.includes('2026-05-31'));   // in window, uncovered
    assert.ok(dates.includes('2026-06-07'));   // in window, uncovered
    assert.ok(!dates.includes('2026-06-08'));  // buffer
    assert.ok(!dates.includes('2026-06-02'));  // covered
    // Westchester never deposited → not a participating store → no gaps reported
    assert.ok(!r.missingDeposits.some(m => m.store === 'Westchester'));
  });

  test('district filter', () => {
    const r = summarizeCash([dep()], 6, NOW, STORES_FIX);
    assert.deepStrictEqual(r.deposits, []);
  });
});

describe('summarizeFoodCost', () => {
  const tables = {
    beverages: { 'Latte M': 1.50, 'Latte L': 2.00, 'Cold Brew': 1.00 },
    food: { Sandwich: 2.00 },
    empty: {},
  };

  test('no tables → available:false', () => {
    assert.deepStrictEqual(summarizeFoodCost({}, null), { available: false });
  });

  test('per-category counts, averages, items sorted by cost desc; empty category dropped', () => {
    const r = summarizeFoodCost(tables, null);
    assert.strictEqual(r.available, true);
    assert.strictEqual(r.categories.length, 2);
    const bev = r.categories.find(c => c.category === 'beverages');
    assert.strictEqual(bev.itemCount, 3);
    assert.strictEqual(bev.avgUnitCost, 1.5);
    assert.strictEqual(bev.items[0].item, 'Latte L');
    assert.strictEqual(r.computed, undefined);
  });

  test('computed overlay included when present', () => {
    const r = summarizeFoodCost(tables, { beverages: { asOf: '2026-06-08', storeCount: 45 } });
    assert.deepStrictEqual(r.computed, { beverages: { asOf: '2026-06-08', storeCount: 45 } });
  });

  test('non-number values excluded from itemCount and average', () => {
    const r = summarizeFoodCost({ mixed: { Good: 2.00, Bad: 'n/a', Also: null } }, null);
    const c = r.categories[0];
    assert.strictEqual(c.itemCount, 1);
    assert.strictEqual(c.avgUnitCost, 2);
  });
});

describe('compactComputed', () => {
  test('keeps scalars, replaces arrays/objects with sizes', () => {
    assert.deepStrictEqual(
      compactComputed({ asOf: 'x', pct: 0.28, rows: [1, 2, 3], nested: { a: 1 }, big: 'y'.repeat(500) }),
      { asOf: 'x', pct: 0.28, rows: '[3 items]', nested: '[object]' }
    );
  });
  test('non-object passthrough → null', () => {
    assert.strictEqual(compactComputed(null), null);
    assert.strictEqual(compactComputed('str'), null);
  });
  test('nothing survives the trim → null, not {}', () => {
    assert.strictEqual(compactComputed({ big: 'y'.repeat(500) }), null);
  });
});
