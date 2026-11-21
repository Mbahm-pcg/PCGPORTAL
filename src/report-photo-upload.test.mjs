import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLimited, withRetry } from './report-photo-upload.mjs';

test('runLimited never runs more than the limit at once and keeps input order', async () => {
  let inFlight = 0, peak = 0;
  const out = await runLimited([30, 5, 20, 1, 10, 15, 2], 3, async (ms, i) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, ms));
    inFlight--;
    return i * 10;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out.map(r => r.value), [0, 10, 20, 30, 40, 50, 60]);
  assert.equal(out.every(r => r.ok), true);
});

test('runLimited: one failure does not stop the rest', async () => {
  const out = await runLimited([1, 2, 3, 4], 2, async (n) => { if (n === 2) throw new Error('boom'); return n; });
  assert.deepEqual(out.map(r => r.ok), [true, false, true, true]);
  assert.equal(out[1].error.message, 'boom');
  assert.deepEqual(await runLimited([], 3, async () => 1), []);
});

test('withRetry retries retryable errors, then gives up', async () => {
  const sleep = async () => {};
  let calls = 0;
  assert.equal(await withRetry(async () => { if (++calls < 3) throw new Error('net'); return 'ok'; }, { sleep }), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('net'); }, { sleep }), /net/);
  assert.equal(calls, 3); // first try + 2 retries
});

test('withRetry does not retry a rejected request (4xx)', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('403'), { retryable: false }); }, { sleep: async () => {} }), /403/);
  assert.equal(calls, 1);
});
