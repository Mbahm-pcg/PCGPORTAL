import test from 'node:test';
import assert from 'node:assert/strict';
import { parseParadoxTime, readInterviewRow, interviewSource, pxUid } from './paradox-interviews.mjs';

test('parseParadoxTime: explicit zones are trusted', () => {
  assert.equal(parseParadoxTime('2026-11-04T15:30:00Z'), '2026-11-04T15:30:00.000Z');
  assert.equal(parseParadoxTime('2026-11-04T10:30:00-05:00'), '2026-11-04T15:30:00.000Z');
  assert.equal(parseParadoxTime('2026-11-04 10:30:00-0500'), '2026-11-04T15:30:00.000Z');
});

test('parseParadoxTime: naive time read as UTC or as store-local ET (DST-aware)', () => {
  assert.equal(parseParadoxTime('2026-11-04 15:30:00'), '2026-11-04T15:30:00.000Z');
  assert.equal(parseParadoxTime('2026-11-04 10:30:00', 'America/New_York'), '2026-11-04T15:30:00.000Z'); // EST
  assert.equal(parseParadoxTime('2026-10-28T10:30', 'America/New_York'), '2026-10-28T14:30:00.000Z');   // EDT
});

test('parseParadoxTime: epoch seconds/ms; junk → null', () => {
  assert.equal(parseParadoxTime(1793806200), new Date(1793806200000).toISOString());
  assert.equal(parseParadoxTime('1793806200000'), new Date(1793806200000).toISOString());
  assert.equal(parseParadoxTime('soon'), null);
  assert.equal(parseParadoxTime(null), null);
});

test('readInterviewRow: booked interview → invite row; done or missing time → null', () => {
  const row = { candidate: { OID: 77, name: 'Jane Roe' }, interview: { scheduled_at: '2026-11-04T15:30:00Z', interviewed: '0' } };
  assert.deepEqual(readInterviewRow(row, 339616), { uid: 'px:77', pc: '339616', candidate: 'Jane Roe', start: '2026-11-04T15:30:00.000Z', summary: 'Interview' });
  assert.equal(readInterviewRow({ ...row, interview: { ...row.interview, interviewed: '1' } }, 1), null);
  assert.equal(readInterviewRow({ candidate: { OID: 1 }, interview: {} }, 1), null);
});

test('interviewSource / pxUid', () => {
  assert.equal(interviewSource({ source: 'paradox' }), 'paradox');
  assert.equal(interviewSource({}), 'email');
  assert.equal(pxUid(5), 'px:5');
});
