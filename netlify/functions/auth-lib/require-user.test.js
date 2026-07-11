const { test } = require('node:test');
const assert = require('node:assert');
const { signToken } = require('../deal-lib/token');
const { requireUser, requireRole, requireActiveUser } = require('./require-user');

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

// requireActiveUser stubs the neon `db` sql tag as a plain async function — a
// tagged-template call `db\`...\`` invokes it exactly like any other function.
const stubDb = (rows) => async () => rows;

test('requireActiveUser attaches auditsAccess from the fresh per-request users row', async () => {
  const token = signToken({ kind: 'portal', sub: 42, username: 'grantee', userType: 'construction' }, SECRET);
  const db = stubDb([{ sessions_valid_from: null, active: true, audits_access: 'view' }]);
  const claims = await requireActiveUser(ev(token), db, { secret: SECRET });
  assert.ok(claims);
  assert.equal(claims.auditsAccess, 'view');
});

test('requireActiveUser normalizes a null audits_access column to null', () => {
  const token = signToken({ kind: 'portal', sub: 7, username: 'plain', userType: 'manager' }, SECRET);
  const db = stubDb([{ sessions_valid_from: null, active: true, audits_access: null }]);
  return requireActiveUser(ev(token), db, { secret: SECRET }).then((claims) => {
    assert.ok(claims);
    assert.equal(claims.auditsAccess, null);
  });
});

test('requireActiveUser still rejects a deactivated user regardless of auditsAccess', async () => {
  const token = signToken({ kind: 'portal', sub: 9, username: 'gone', userType: 'it' }, SECRET);
  const db = stubDb([{ sessions_valid_from: null, active: false, audits_access: 'full' }]);
  const claims = await requireActiveUser(ev(token), db, { secret: SECRET });
  assert.equal(claims, null);
});

test('requireActiveUser fails open (no auditsAccess mutation) on a DB error', async () => {
  const token = signToken({ kind: 'portal', sub: 1, username: 'x', userType: 'manager' }, SECRET);
  const db = async () => { throw new Error('db down'); };
  const claims = await requireActiveUser(ev(token), db, { secret: SECRET });
  assert.ok(claims); // fails open — token still valid
  assert.equal(claims.auditsAccess, undefined);
});

// Simulates a fresh deploy where audits_access hasn't been column-ensured yet by
// users.mjs/audits.mjs: the first (3-column) SELECT throws because the column doesn't
// exist; the retry drops audits_access from the query and should still succeed —
// active/session-revocation enforcement must stay in force, only auditsAccess degrades.
const stubDbMissingAuditsColumn = (rows) => async (strings) => {
  const text = strings.join('');
  if (text.includes('audits_access')) throw new Error('column "audits_access" does not exist');
  return rows;
};

test('requireActiveUser retries without audits_access and still enforces active/session when the column is missing', async () => {
  const token = signToken({ kind: 'portal', sub: 3, username: 'newcol', userType: 'manager' }, SECRET);
  const db = stubDbMissingAuditsColumn([{ sessions_valid_from: null, active: true }]);
  const claims = await requireActiveUser(ev(token), db, { secret: SECRET });
  assert.ok(claims);
  assert.equal(claims.auditsAccess, null); // degrades to null, not left unset / fail-open
});

test('requireActiveUser retry path still rejects a deactivated user when audits_access is missing', async () => {
  const token = signToken({ kind: 'portal', sub: 4, username: 'gone2', userType: 'manager' }, SECRET);
  const db = stubDbMissingAuditsColumn([{ sessions_valid_from: null, active: false }]);
  const claims = await requireActiveUser(ev(token), db, { secret: SECRET });
  assert.equal(claims, null); // active/session checks still ENFORCED, not fail-open
});

test('requireActiveUser retry path still rejects a revoked session when audits_access is missing', async () => {
  // Token issued "now" (so it's not simply expired) but sessions_valid_from is set an
  // hour into the future, i.e. a sign-out-everywhere happened after this token was minted.
  const token = signToken({ kind: 'portal', sub: 5, username: 'revoked2', userType: 'manager' }, SECRET);
  const futureCutoff = new Date(Date.now() + 3600_000).toISOString();
  const db = stubDbMissingAuditsColumn([{ sessions_valid_from: futureCutoff, active: true }]);
  const claims = await requireActiveUser(ev(token), db, { secret: SECRET });
  assert.equal(claims, null); // active/session checks still ENFORCED, not fail-open
});

test('requireActiveUser fails open only when the retry itself also errors', async () => {
  const token = signToken({ kind: 'portal', sub: 6, username: 'stilldown', userType: 'manager' }, SECRET);
  const db = async () => { throw new Error('db still down'); }; // both queries fail
  const claims = await requireActiveUser(ev(token), db, { secret: SECRET });
  assert.ok(claims); // fails open — token still valid
  assert.equal(claims.auditsAccess, undefined);
});
