const { test, describe } = require('node:test');
const assert = require('node:assert');
const { signToken, verifyToken } = require('./token');

const SECRET = 'test-secret-do-not-use-in-prod';
const NOW = 1_750_000_000_000;

describe('signToken / verifyToken', () => {
  test('round-trips a payload and returns it on verify', () => {
    const t = signToken({ sub: 1, username: 'mike.bahm', role: 'admin' }, SECRET, { nowMs: NOW, ttlSeconds: 3600 });
    const body = verifyToken(t, SECRET, { nowMs: NOW });
    assert.strictEqual(body.sub, 1);
    assert.strictEqual(body.username, 'mike.bahm');
    assert.strictEqual(body.role, 'admin');
    assert.strictEqual(body.exp, Math.floor(NOW / 1000) + 3600);
  });
  test('rejects a tampered payload', () => {
    const t = signToken({ role: 'view' }, SECRET, { nowMs: NOW });
    const [p, sig] = t.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ role: 'admin', exp: Math.floor(NOW / 1000) + 9999 })).toString('base64url');
    assert.strictEqual(verifyToken(`${forgedBody}.${sig}`, SECRET, { nowMs: NOW }), null);
  });
  test('rejects a wrong secret', () => {
    const t = signToken({ role: 'edit' }, SECRET, { nowMs: NOW });
    assert.strictEqual(verifyToken(t, 'other-secret', { nowMs: NOW }), null);
  });
  test('rejects an expired token', () => {
    const t = signToken({ role: 'view' }, SECRET, { nowMs: NOW, ttlSeconds: 60 });
    assert.strictEqual(verifyToken(t, SECRET, { nowMs: NOW + 61_000 }), null);
  });
  test('rejects malformed input', () => {
    assert.strictEqual(verifyToken('', SECRET, { nowMs: NOW }), null);
    assert.strictEqual(verifyToken('no-dot', SECRET, { nowMs: NOW }), null);
    assert.strictEqual(verifyToken(null, SECRET, { nowMs: NOW }), null);
  });
  test('rejects tokens with extra or missing segments', () => {
    const t = signToken({ role: 'admin' }, SECRET, { nowMs: NOW });
    assert.strictEqual(verifyToken(t + '.garbage', SECRET, { nowMs: NOW }), null);
    assert.strictEqual(verifyToken('.' + t.split('.')[1], SECRET, { nowMs: NOW }), null);
    assert.strictEqual(verifyToken('.', SECRET, { nowMs: NOW }), null);
  });
});
