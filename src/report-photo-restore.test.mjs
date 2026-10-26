import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRealPhoto, realCounts, mergePhotoMaps, considerBackup, summarizePlan, photoMapFromReport } from './report-photo-restore.mjs';

const img = (n) => ({ data: 'data:image/jpeg;base64,' + 'A'.repeat(60) + n, name: `p${n}.jpg`, timestamp: '2026-10-20T12:00:00' });
const stub = (n) => ({ name: `p${n}.jpg`, timestamp: '2026-10-20T12:00:00', _photoStripped: true });

test('isRealPhoto / realCounts: placeholders and empty entries are not photos', () => {
  assert.equal(isRealPhoto(img(1)), true);
  assert.equal(isRealPhoto(stub(1)), false);
  assert.deepEqual(realCounts({ 0: [img(1), stub(2)], 1: [] }), { 0: 1, 1: 0 });
});

test('mergePhotoMaps: the Force Sync case — empty / placeholder map gets the backup photos back', () => {
  const backup = { 0: [img(1), img(2)], 2: [img(3)] };
  assert.deepEqual(mergePhotoMaps({}, backup).restored, 3);
  const r = mergePhotoMaps({ 0: [stub(1), stub(2)] }, backup);
  assert.equal(r.restored, 3);
  assert.deepEqual(r.map[0].map(p => p.name), ['p1.jpg', 'p2.jpg']);
  assert.equal(r.map[0].every(isRealPhoto), true);
});

test('mergePhotoMaps: never removes photos added after the backup, per work log', () => {
  const current = { 0: [img(1), img(2), img(9)], 1: [] };
  const backup = { 0: [img(1), img(2)], 1: [img(5)] };
  const r = mergePhotoMaps(current, backup);
  assert.equal(r.map[0].length, 3); // current had more → kept
  assert.equal(r.map[1].length, 1); // restored
  assert.equal(r.restored, 1);
});

test('considerBackup: newest backup wins unless an older one restores more', () => {
  const current = { 7: {}, 8: {} };
  const best = new Map();
  // newest first
  considerBackup(best, current, 'bk_26', '2026-10-26', [{ id: 7, date: '2026-10-22', workLogs: [{ photos: [img(1)] }] }, { id: 8, workLogs: [{ photos: [] }] }]);
  considerBackup(best, current, 'bk_25', '2026-10-25', [{ id: 7, workLogs: [{ photos: [img(1)] }] }, { id: 8, date: '2026-10-21', workLogs: [{ photos: [img(1), img(2)] }] }]);
  considerBackup(best, current, 'bk_24', '2026-10-24', [{ id: 7, workLogs: [{ photos: [img(1), img(2)] }] }]);
  assert.equal(best.get('7').backupKey, 'bk_24');     // older backup has more for report 7
  assert.equal(best.get('8').backupKey, 'bk_25');
  const s = summarizePlan(best);
  assert.deepEqual([s.reports, s.photos], [2, 4]);
});

test('considerBackup: nothing to restore when the current photos are complete', () => {
  const best = considerBackup(new Map(), { 7: { 0: [img(1)] } }, 'bk', 'x', [{ id: 7, workLogs: [{ photos: [img(1)] }] }]);
  assert.equal(best.size, 0);
  assert.deepEqual(photoMapFromReport({ workLogs: [{ photos: [] }, { photos: [img(1)] }] }), { 1: [img(1)] });
});
