const { test, describe } = require('node:test');
const assert = require('node:assert');
const { canTransition, defaultDeadline, isOverdue } = require('./caps');

describe('canTransition', () => {
  test('owner can resolve their open or overdue CAP', () => {
    assert.ok(canTransition('manager', true, 'open', 'owner_resolved'));
    assert.ok(canTransition('manager', true, 'overdue', 'owner_resolved'));
  });
  test('non-owner manager cannot resolve someone else\'s CAP', () => {
    assert.ok(!canTransition('manager', false, 'open', 'owner_resolved'));
  });
  test('only auditor/executive/it can verify-close, and only from owner_resolved', () => {
    for (const ut of ['auditor', 'executive', 'it'])
      assert.ok(canTransition(ut, false, 'owner_resolved', 'verified_closed'));
    assert.ok(!canTransition('manager', true, 'owner_resolved', 'verified_closed'));
    assert.ok(!canTransition('dm', false, 'owner_resolved', 'verified_closed'));
    assert.ok(!canTransition('auditor', false, 'open', 'verified_closed'));
  });
  test('auditor can reject a resolution back to open', () => {
    assert.ok(canTransition('auditor', false, 'owner_resolved', 'open'));
    assert.ok(!canTransition('manager', true, 'owner_resolved', 'open'));
  });
  test('closed is terminal', () => {
    assert.ok(!canTransition('executive', false, 'verified_closed', 'open'));
  });
});

describe('defaultDeadline', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  test('critical 48h, high 72h, default 7d', () => {
    assert.strictEqual(defaultDeadline('critical', now), '2026-07-12T12:00:00.000Z');
    assert.strictEqual(defaultDeadline('high', now), '2026-07-13T12:00:00.000Z');
    assert.strictEqual(defaultDeadline('medium', now), '2026-07-17T12:00:00.000Z');
  });
});

describe('isOverdue', () => {
  const now = Date.parse('2026-07-10T12:00:00Z');
  test('open past deadline is overdue; resolved/closed never are', () => {
    assert.ok(isOverdue({ status: 'open', deadline: '2026-07-09T12:00:00Z' }, now));
    assert.ok(!isOverdue({ status: 'open', deadline: '2026-07-11T12:00:00Z' }, now));
    assert.ok(!isOverdue({ status: 'owner_resolved', deadline: '2026-07-01T12:00:00Z' }, now));
    assert.ok(!isOverdue({ status: 'verified_closed', deadline: '2026-07-01T12:00:00Z' }, now));
  });
});
