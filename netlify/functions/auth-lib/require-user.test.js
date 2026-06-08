const { test } = require('node:test');
const assert = require('node:assert');
const { signToken } = require('../deal-lib/token');
const { requireUser, requireRole } = require('./require-user');

const SECRET = 'test-secret-portal';
const ev = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

test('requireUser accepts a valid portal token', () => {
  const token = signToken({ kind: 'portal', username: 'mike.bahm', userType: 'executive' }, SECRET);
  const u = requireUser(ev(token), { secret: SECRET });
  assert.ok(u);
  assert.equal(u.username, 'mike.bahm');
  assert.equal(u.userType, 'executive');
});

test('requireUser rejects a non-portal (deal) token signed with the same secret', () => {
  const dealToken = signToken({ username: 'mike.bahm', role: 'admin' }, SECRET); // no kind:'portal'
  assert.equal(requireUser(ev(dealToken), { secret: SECRET }), null);
});

test('requireUser rejects missing / garbage / wrong-secret tokens', () => {
  assert.equal(requireUser(ev(null), { secret: SECRET }), null);
  assert.equal(requireUser(ev('not.a.token'), { secret: SECRET }), null);
  const t = signToken({ kind: 'portal', username: 'x', userType: 'it' }, 'other-secret');
  assert.equal(requireUser(ev(t), { secret: SECRET }), null);
});

test('requireRole matches userType against a string or list', () => {
  const u = { username: 'a', userType: 'office_staff' };
  assert.equal(requireRole(u, 'office_staff'), true);
  assert.equal(requireRole(u, ['executive', 'it', 'office_staff']), true);
  assert.equal(requireRole(u, ['executive', 'it']), false);
  assert.equal(requireRole(null, 'executive'), false);
});
