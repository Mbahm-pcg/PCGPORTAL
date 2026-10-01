import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePunchLogResponse } from './paycor-punch-resolve.mjs';

test('404 is pending, never resolved', () => {
  assert.deepEqual(resolvePunchLogResponse(404, null), { state: 'pending' });
});

test('401 is unresolved, not success (the real bug this guards against)', () => {
  assert.equal(resolvePunchLogResponse(401, { error: 'unauthorized' }).state, 'unresolved');
});

test('403 is unresolved, not success', () => {
  assert.equal(resolvePunchLogResponse(403, {}).state, 'unresolved');
});

test('500 is unresolved, not success', () => {
  assert.equal(resolvePunchLogResponse(500, {}).state, 'unresolved');
});

test('200 with no records resolves with nothing succeeded or failed', () => {
  assert.deepEqual(resolvePunchLogResponse(200, { records: [] }), { state: 'resolved', succeeded: [], failed: [] });
});

test('200 with a mix of clean and errored records splits them correctly', () => {
  const body = { records: [{ punchId: 'p1' }, { punchId: 'p2', errors: ['Invalid DepartmentId'] }] };
  const r = resolvePunchLogResponse(200, body);
  assert.equal(r.state, 'resolved');
  assert.equal(r.succeeded.length, 1);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].record.punchId, 'p2');
});

test('handles PascalCase Records/Errors shape too', () => {
  const body = { Records: [{ PunchId: 'p1', Errors: ['bad'] }] };
  assert.equal(resolvePunchLogResponse(200, body).failed.length, 1);
});
