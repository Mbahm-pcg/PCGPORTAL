const { test, describe } = require('node:test');
const assert = require('node:assert');
const { summarizeProjects } = require('./ops-summaries');

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
