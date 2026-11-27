import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DEAL_SESSION_SECRET = process.env.DEAL_SESSION_SECRET || 'test-secret-for-signing';
const { INTERNAL_HEADER, internalKey, isInternalCall } = await import('../netlify/functions/_shared/internal-key.mjs');
const req = (h) => new Request('https://x/.netlify/functions/paycor', { method: 'POST', headers: h });

test('only our own key counts as a server call', () => {
  assert.equal(isInternalCall(req({ [INTERNAL_HEADER]: internalKey() })), true);
  assert.equal(isInternalCall(req({})), false);                                   // a stranger
  assert.equal(isInternalCall(req({ [INTERNAL_HEADER]: 'guess' })), false);
  assert.equal(isInternalCall(req({ [INTERNAL_HEADER]: internalKey().replace(/.$/, '0') === internalKey() ? internalKey().replace(/.$/, '1') : internalKey().replace(/.$/, '0') })), false);
  assert.equal(isInternalCall(req({ authorization: `Bearer ${internalKey()}` })), false); // wrong place
});

test('no secret configured → nothing is internal', () => {
  const keep = process.env.DEAL_SESSION_SECRET;
  delete process.env.DEAL_SESSION_SECRET;
  assert.equal(internalKey(), '');
  assert.equal(isInternalCall(req({ [INTERNAL_HEADER]: '' })), false);
  process.env.DEAL_SESSION_SECRET = keep;
});
