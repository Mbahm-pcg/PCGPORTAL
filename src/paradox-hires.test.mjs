import test from 'node:test';
import assert from 'node:assert/strict';
import { readHiredRow, newHires, hireSource } from './paradox-hires.mjs';

test('readHiredRow: OID, name, job req, hire time from updated_at when hired_date is empty', () => {
  const r = readHiredRow({ candidate: { OID: 123, name: ' John Doe ', email: 'j@x.com', job_req_id: 'P1-7129402-2', candidate_journey_status: 'Hire: Hired', hired_date: null, updated_at: '2026-11-03T14:05:00Z' } });
  assert.deepEqual(r, { oid: '123', name: 'John Doe', email: 'j@x.com', jobReqId: 'P1-7129402-2', status: 'Hire: Hired', hiredAt: '2026-11-03T14:05:00.000Z' });
});

test('readHiredRow: no OID → null; bad date → now', () => {
  assert.equal(readHiredRow({ candidate: { name: 'X' } }), null);
  assert.equal(readHiredRow({ candidate: { OID: 'a', updated_at: 'nope' } }, '2026-11-03T00:00:00.000Z').hiredAt, '2026-11-03T00:00:00.000Z');
});

test('newHires: skips seen, duplicate and not-actually-hired rows', () => {
  const rows = [
    { oid: '1', status: 'Hire: Hired' },
    { oid: '2', status: 'Hire: Hired' },
    { oid: '2', status: 'Hire: Hired' },
    { oid: '3', status: 'Interview: Interview Scheduled' },
  ];
  assert.deepEqual(newHires(rows, new Set(['1'])).map(r => r.oid), ['2']);
});

test('hireSource defaults to email unless explicitly paradox', () => {
  assert.equal(hireSource({ source: 'paradox' }), 'paradox');
  assert.equal(hireSource({}), 'email');
  assert.equal(hireSource(null), 'email');
  assert.equal(hireSource({ source: 'weird' }), 'email');
});
