const { test } = require('node:test');
const assert = require('node:assert');
const { hashPassword, verifyPassword, isHashed } = require('./passwords');

test('hashPassword produces a scrypt$salt$hash string', () => {
  const h = hashPassword('correct horse battery staple');
  assert.match(h, /^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.ok(isHashed(h));
});

test('verifyPassword accepts the right password, rejects the wrong one', () => {
  const h = hashPassword('S3cret!pw');
  assert.equal(verifyPassword('S3cret!pw', h), true);
  assert.equal(verifyPassword('s3cret!pw', h), false);
  assert.equal(verifyPassword('', h), false);
});

test('two hashes of the same password differ (random salt) but both verify', () => {
  const a = hashPassword('samePass');
  const b = hashPassword('samePass');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('samePass', a));
  assert.ok(verifyPassword('samePass', b));
});

test('verifyPassword rejects malformed / legacy plaintext stored values', () => {
  assert.equal(verifyPassword('x', 'PCG2024!'), false);   // legacy plaintext, not a hash
  assert.equal(verifyPassword('x', 'scrypt$only'), false);
  assert.equal(verifyPassword('x', ''), false);
  assert.equal(verifyPassword('x', null), false);
  assert.equal(isHashed('PCG2024!'), false);
});
