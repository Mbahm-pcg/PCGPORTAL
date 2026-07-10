const { test, describe } = require('node:test');
const assert = require('node:assert');
const { TEMPLATE_V1, validateTemplate } = require('./template');

describe('TEMPLATE_V1', () => {
  test('weights sum to 1.0', () => {
    const sum = TEMPLATE_V1.sections.reduce((a, s) => a + s.weight, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9);
  });
  test('has the four spec sections in order', () => {
    assert.deepStrictEqual(TEMPLATE_V1.sections.map(s => s.id),
      ['food_safety', 'brand_guest', 'facility', 'safety']);
    assert.deepStrictEqual(TEMPLATE_V1.sections.map(s => s.weight), [0.40, 0.25, 0.20, 0.15]);
  });
  test('item ids are globally unique and every item has positive points', () => {
    const ids = TEMPLATE_V1.sections.flatMap(s => s.items.map(i => i.id));
    assert.strictEqual(new Set(ids).size, ids.length);
    for (const s of TEMPLATE_V1.sections) for (const i of s.items) assert.ok(i.points > 0);
  });
  test('critical items exist in food_safety and safety', () => {
    const crit = (sid) => TEMPLATE_V1.sections.find(s => s.id === sid).items.some(i => i.critical);
    assert.ok(crit('food_safety') && crit('safety'));
  });
});

describe('validateTemplate', () => {
  test('accepts TEMPLATE_V1', () => assert.deepStrictEqual(validateTemplate(TEMPLATE_V1), []));
  test('rejects bad weights and duplicate ids', () => {
    const bad = JSON.parse(JSON.stringify(TEMPLATE_V1));
    bad.sections[0].weight = 0.5;
    assert.ok(validateTemplate(bad).some(e => /weight/i.test(e)));
    const dup = JSON.parse(JSON.stringify(TEMPLATE_V1));
    dup.sections[0].items[1].id = dup.sections[0].items[0].id;
    assert.ok(validateTemplate(dup).some(e => /duplicate/i.test(e)));
  });
});
