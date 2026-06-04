const { test, describe } = require('node:test');
const assert = require('node:assert');
const { lookupUnitCost } = require('./cost-lookup');

describe('lookupUnitCost', () => {
  test('resolves a known exact catalog item to a positive number', () => {
    const cost = lookupUnitCost('Bacon Egg & Cheese');
    assert.strictEqual(typeof cost, 'number');
    assert.ok(cost > 0, 'expected a positive unit cost');
  });

  test('returns undefined for an unknown item', () => {
    assert.strictEqual(lookupUnitCost('Totally Not A Real Menu Item 9999'), undefined);
  });

  test('returns undefined for empty / nullish input', () => {
    assert.strictEqual(lookupUnitCost(''), undefined);
    assert.strictEqual(lookupUnitCost(undefined), undefined);
  });
});
