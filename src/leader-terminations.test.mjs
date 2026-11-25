import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTextbelt } from '../netlify/functions/textbelt-reply.mjs';
import { parseAnswer, digits } from '../netlify/functions/_shared/leader-terminations.mjs';

test('only a Textbelt-signed, fresh reply is accepted', () => {
  const key = 'k-test', ts = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify({ textId: '9', fromNumber: '+12155550123', text: 'YES', data: 'lt:4' });
  const sig = createHmac('sha256', key).update(ts + raw).digest('hex');
  assert.equal(verifyTextbelt(raw, ts, sig, key), true);
  assert.equal(verifyTextbelt(raw, ts, sig.toUpperCase(), key), true);
  assert.equal(verifyTextbelt(raw.replace('YES', 'NO'), ts, sig, key), false); // tampered
  assert.equal(verifyTextbelt(raw, ts, sig, 'other-key'), false);
  assert.equal(verifyTextbelt(raw, ts, '', key), false);
  const old = String(Number(ts) - 20 * 60);
  assert.equal(verifyTextbelt(raw, old, createHmac('sha256', key).update(old + raw).digest('hex'), key), false); // > 15 min
});

test('replies are read as YES / NO / opt-out, everything else asks again', () => {
  for (const t of ['YES', 'yes!', 'Y', 'Yeah do it', 'yep', 'approve']) assert.equal(parseAnswer(t), 'yes', t);
  for (const t of ['NO', 'no thanks', 'n', 'nope', 'skip']) assert.equal(parseAnswer(t), 'no', t);
  for (const t of ['STOP', 'unsubscribe']) assert.equal(parseAnswer(t), 'stop', t);
  for (const t of ['ok', 'who is this?', '', 'maybe']) assert.equal(parseAnswer(t), null, t);
});

test('phone numbers compare by their last 10 digits', () => {
  assert.equal(digits('+1 (215) 555-0123'), '2155550123');
  assert.equal(digits('215.555.0123'), '2155550123');
});
