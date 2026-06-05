const { test, describe } = require('node:test');
const assert = require('node:assert');
const { roleSatisfies, ROLE_RANK } = require('./roles');

describe('roleSatisfies', () => {
  test('higher roles satisfy lower requirements', () => {
    assert.ok(roleSatisfies('admin', 'view'));
    assert.ok(roleSatisfies('admin', 'edit'));
    assert.ok(roleSatisfies('edit', 'view'));
    assert.ok(roleSatisfies('edit', 'edit'));
    assert.ok(roleSatisfies('view', 'view'));
  });
  test('lower roles do not satisfy higher requirements', () => {
    assert.ok(!roleSatisfies('view', 'edit'));
    assert.ok(!roleSatisfies('view', 'admin'));
    assert.ok(!roleSatisfies('edit', 'admin'));
  });
  test('unknown / missing roles never satisfy', () => {
    assert.ok(!roleSatisfies(undefined, 'view'));
    assert.ok(!roleSatisfies('bogus', 'view'));
    assert.ok(!roleSatisfies('admin', 'bogus'));
  });
  test('ROLE_RANK exposes the ordering', () => {
    assert.ok(ROLE_RANK.admin > ROLE_RANK.edit && ROLE_RANK.edit > ROLE_RANK.view);
  });
});
