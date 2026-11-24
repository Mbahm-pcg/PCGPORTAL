import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReportList, missingFromIncoming, addDeleted, deletedIds, MAX_DELETED } from './report-index.mjs';

const e = (id, updatedAt, extra = {}) => ({ id, projectId: 1, date: '2026-11-24', updatedAt, ...extra });

test('a stale device no longer knocks a new report off the list', () => {
  const stored = [e('dr_2', 't2'), e(1, 't1')];           // phone just added dr_2
  const stale = [e(1, 't1')];                             // computer hasn't seen it yet
  assert.deepEqual(mergeReportList(stored, stale).map(r => r.id), [1, 'dr_2']);
  assert.deepEqual(missingFromIncoming(stored, stale), ['dr_2']);
});
test('newer copy wins for a report on both lists; incoming wins a tie', () => {
  const out = mergeReportList([e(1, '2026-11-24T10:00', { status: 'submitted' }), e(2, 'a', { status: 'old' })],
    [e(1, '2026-11-24T09:00', { status: 'draft' }), e(2, 'a', { status: 'new' })]);
  assert.equal(out[0].status, 'submitted');
  assert.equal(out[1].status, 'new');
});
test('deleted reports leave the list and cannot come back from a stale copy', () => {
  const deleted = new Set(['1', 'dr_9']);
  assert.deepEqual(mergeReportList([e(1, 'a'), e(2, 'a'), e('dr_9', 'a')], [e(1, 'b'), e(3, 'a')], { deleted }).map(r => r.id), [3, 2]);
});
test('ids compare as text (1 and "1" are one report), duplicates collapse, first save works', () => {
  assert.equal(mergeReportList([e('1', 'a')], [e(1, 'a'), e(1, 'a')]).length, 1);
  assert.deepEqual(mergeReportList(null, [e(1, 'a')]), [e(1, 'a')]);
  assert.deepEqual(mergeReportList([e(1, 'a')], []).map(r => r.id), [1]);
  assert.equal(mergeReportList([e(1, 'a')], { not: 'a list' }).not, 'a list');
});
test('legacy backup: a copy with its work logs beats a bare list entry', () => {
  const full = e(1, 'a', { workLogs: [{ name: 'Framing' }] });
  assert.equal(mergeReportList([full], [e(1, 'a')], { preferContent: true })[0], full);
  assert.equal(mergeReportList([full], [e(1, 'a')])[0].workLogs, undefined);
  const newer = e(1, 'b', { workLogs: [] });
  assert.equal(mergeReportList([full], [newer], { preferContent: true })[0], newer);
});
test('deleted record: add, read, capped to the most recent', () => {
  let rec = addDeleted(null, 5, '2026-11-24T10:00:00Z');
  rec = addDeleted(rec, 'dr_7', '2026-11-24T11:00:00Z');
  assert.deepEqual([...deletedIds(rec)].sort(), ['5', 'dr_7']);
  assert.equal(deletedIds([1, 2]).size, 0);
  let big = {};
  for (let i = 0; i < MAX_DELETED; i++) big[`x${i}`] = `2026-01-01T00:00:${String(i).padStart(6, '0')}`;
  big = addDeleted(big, 'newest', '2027-01-01');
  assert.equal(Object.keys(big).length, MAX_DELETED);
  assert.equal('newest' in big, true); assert.equal('x0' in big, false);
});
