import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRefPhoto, isRealReportPhoto, isPendingPhoto, cleanRef,
  splitReportForSave, mergeLoadedReport, stripReportPhotosForLocal,
  countReportPhotos, canUploadReportPhotos, reconcileReportRefs, referencedPhotoIds,
} from './report-photos.mjs';

const DATA = 'data:image/jpeg;base64,' + 'A'.repeat(64);
const legacy = (n = 'a.jpg') => ({ data: DATA, name: n, timestamp: '2026-11-20T12:00:00' });
const ref = (id = 'pphoto_1', extra = {}) => ({
  photoId: id, fullKey: `pcg_project_photo_${id}`, medKey: `pcg_project_photo_${id}_med`,
  name: 'b.jpg', timestamp: '2026-11-20T12:00:00', ...extra,
});
const report = (photos) => ({ id: 7, projectId: 1, date: '2026-11-20', workLogs: [{ name: 'Carpenters', photos }] });

test('photo kind helpers', () => {
  assert.equal(isRefPhoto(ref()), true);
  assert.equal(isRefPhoto(legacy()), false);
  assert.equal(isRefPhoto(null), false);
  assert.equal(isRealReportPhoto(legacy()), true);
  assert.equal(isRealReportPhoto({ name: 'x', _photoStripped: true }), false);
  // a ref carrying a local preview is NOT a legacy photo
  assert.equal(isRealReportPhoto(ref('p', { data: DATA })), false);
  assert.equal(isPendingPhoto({ _status: 'uploading', data: DATA }), true);
  assert.equal(isPendingPhoto({ _status: 'failed', data: DATA }), true);
  assert.equal(isPendingPhoto(ref()), false);
});

test('cleanRef keeps only persistent fields', () => {
  assert.deepEqual(cleanRef(ref('p9', { data: DATA, _status: undefined, _localId: 'l1', _error: 'x' })), ref('p9'));
});

test('split: legacy-only log goes to the photo map', () => {
  const { slimReport, photoMap, hasReal } = splitReportForSave(report([legacy('1'), legacy('2')]));
  assert.deepEqual(slimReport.workLogs[0].photos, []);
  assert.equal(photoMap[0].length, 2);
  assert.equal(hasReal, true);
});

test('split: ref-only log stays in the report, without image data', () => {
  const { slimReport, photoMap, hasReal } = splitReportForSave(report([ref('p1', { data: DATA }), ref('p2')]));
  assert.deepEqual(slimReport.workLogs[0].photos, [ref('p1'), ref('p2')]);
  assert.deepEqual(photoMap, {});
  assert.equal(hasReal, false);
});

test('split: mixed log separates the two kinds', () => {
  const { slimReport, photoMap, hasReal } = splitReportForSave(report([legacy('1'), ref('p1'), legacy('2')]));
  assert.deepEqual(slimReport.workLogs[0].photos, [ref('p1')]);
  assert.deepEqual(photoMap[0].map(p => p.name), ['1', '2']);
  assert.equal(hasReal, true);
});

test('split: pending and stripped photos are never persisted', () => {
  const { slimReport, photoMap } = splitReportForSave(report([
    { _status: 'uploading', data: DATA, name: 'u' },
    { _status: 'failed', data: DATA, name: 'f' },
    { name: 's', _photoStripped: true },
  ]));
  assert.deepEqual(slimReport.workLogs[0].photos, []);
  assert.deepEqual(photoMap, {});
});

test('split: _photosLoaded is not persisted and input is not mutated', () => {
  const input = { ...report([legacy()]), _photosLoaded: true };
  const { slimReport } = splitReportForSave(input);
  assert.equal('_photosLoaded' in slimReport, false);
  assert.equal(input.workLogs[0].photos.length, 1);
  assert.equal(input._photosLoaded, true);
});

test('merge: legacy photos first, then refs', () => {
  const slim = report([ref('p1')]);
  const merged = mergeLoadedReport(slim, { 0: [legacy('1'), legacy('2')] });
  assert.deepEqual(merged.workLogs[0].photos.map(p => p.photoId || p.name), ['1', '2', 'p1']);
});

test('merge: no photo map keeps what the report already has', () => {
  assert.deepEqual(mergeLoadedReport(report([ref('p1')]), null).workLogs[0].photos, [ref('p1')]);
  // pre-split reports (photos inline in the report blob) are left alone
  assert.equal(mergeLoadedReport(report([legacy('1')]), null).workLogs[0].photos.length, 1);
});

test('merge: a map entry replaces inline legacy photos but never refs', () => {
  const merged = mergeLoadedReport(report([legacy('old'), ref('p1')]), { 0: [legacy('new')] });
  assert.deepEqual(merged.workLogs[0].photos.map(p => p.photoId || p.name), ['new', 'p1']);
});

test('split then merge round-trips a mixed report', () => {
  const input = report([legacy('1'), legacy('2'), ref('p1'), ref('p2')]);
  const { slimReport, photoMap } = splitReportForSave(input);
  assert.deepEqual(mergeLoadedReport(slimReport, photoMap), { ...input, _pv: 2 });
});

test('reconcile: a save from a stale or old copy keeps refs someone else added', () => {
  const stored = { id: 7, _pv: 2, workLogs: [{ name: 'A', photos: [ref('p1')] }, { name: 'B', photos: [ref('p2'), ref('p3')] }] };
  // pre-v23 code always saves photos: [] in the report blob
  const fromOld = { id: 7, updatedAt: 'later', workLogs: [{ name: 'A edited', photos: [] }, { name: 'B', photos: [] }] };
  const out = reconcileReportRefs(fromOld, stored);
  assert.equal(out.workLogs[0].name, 'A edited');
  assert.deepEqual(out.workLogs.map(w => w.photos.map(p => p.photoId)), [['p1'], ['p2', 'p3']]);
  assert.deepEqual(fromOld.workLogs[0].photos, []); // input untouched
  // a second person on current code, whose form was opened before p2/p3 were added
  const stale = { id: 7, _pv: 2, workLogs: [{ name: 'A', photos: [ref('p1'), ref('p9')] }, { name: 'B', photos: [] }] };
  assert.deepEqual(reconcileReportRefs(stale, stored).workLogs.map(w => w.photos.map(p => p.photoId)), [['p1', 'p9'], ['p2', 'p3']]);
});

test('reconcile: only a tombstone removes a ref — and it beats a stale copy that still has it', () => {
  const stored = { id: 7, workLogs: [{ photos: [ref('p1'), ref('p2')] }] };
  const removing = { id: 7, workLogs: [{ photos: [ref('p2')] }], removedPhotoIds: ['p1'] };
  const afterRemove = reconcileReportRefs(removing, stored);
  assert.deepEqual(afterRemove.workLogs[0].photos.map(p => p.photoId), ['p2']);
  assert.deepEqual(afterRemove.removedPhotoIds, ['p1']);
  // someone else's stale form still holds p1 and has no tombstones
  const stale = { id: 7, workLogs: [{ photos: [ref('p1'), ref('p2')] }] };
  const out = reconcileReportRefs(stale, afterRemove);
  assert.deepEqual(out.workLogs[0].photos.map(p => p.photoId), ['p2']);
  assert.deepEqual(out.removedPhotoIds, ['p1']);
});

test('reconcile: refs of a removed work log move to the last one; no duplicates when logs shift', () => {
  const stored = { id: 7, workLogs: [{ photos: [ref('p1')] }, { photos: [ref('p2')] }] };
  const fromOld = { id: 7, workLogs: [{ name: 'only', photos: [{ name: 'x', _photoStripped: true }] }] };
  assert.deepEqual(reconcileReportRefs(fromOld, stored).workLogs[0].photos.filter(p => p.photoId).map(p => p.photoId), ['p1', 'p2']);
  // a shell with no work logs at all (legacy fallback) still keeps the photos
  assert.deepEqual(reconcileReportRefs({ id: 7 }, stored).workLogs[0].photos.map(p => p.photoId), ['p1', 'p2']);
  // work log 0 deleted on purpose (its ref tombstoned): log 1 is now at index 0 — not duplicated
  const shifted = { id: 7, workLogs: [{ photos: [ref('p2')] }], removedPhotoIds: ['p1'] };
  assert.deepEqual(reconcileReportRefs(shifted, stored).workLogs.map(w => w.photos.map(p => p.photoId)), [['p2']]);
});

test('reconcile: nothing to do → the same object back; non-reports untouched', () => {
  const plain = { id: 7, workLogs: [{ photos: [] }] };
  assert.equal(reconcileReportRefs(plain, { id: 7, workLogs: [{ photos: [] }] }), plain);
  assert.equal(reconcileReportRefs(plain, null), plain);
  const arr = [1, 2];
  assert.equal(reconcileReportRefs(arr, { workLogs: [{ photos: [ref('p1')] }] }), arr);
  assert.equal(reconcileReportRefs('text', null), 'text');
  // legacy inline photos sitting in an old report blob are left exactly as they are
  const inline = { id: 7, workLogs: [{ photos: [legacy('1')] }] };
  assert.equal(reconcileReportRefs(inline, { id: 7, workLogs: [{ photos: [ref('p1')] }] }).workLogs[0].photos.length, 2);
});

test('split drops refs the report itself lists as removed; referencedPhotoIds', () => {
  const r = { ...report([ref('p1'), ref('p2')]), removedPhotoIds: ['p1'] };
  const { slimReport } = splitReportForSave(r);
  assert.deepEqual(slimReport.workLogs[0].photos.map(p => p.photoId), ['p2']);
  assert.deepEqual(slimReport.removedPhotoIds, ['p1']);
  assert.deepEqual([...referencedPhotoIds([report([ref('a'), legacy()]), report([ref('b')]), null])].sort(), ['a', 'b']);
});

test('strip for local storage', () => {
  const out = stripReportPhotosForLocal(report([legacy('1'), ref('p1', { data: DATA })]));
  assert.deepEqual(out.workLogs[0].photos, [
    { name: '1', timestamp: '2026-11-20T12:00:00', _photoStripped: true },
    ref('p1'),
  ]);
  assert.equal(stripReportPhotosForLocal(null), null);
});

test('counts', () => {
  const r = report([legacy(), ref(), ref('p2'), { _status: 'failed', data: DATA }, { name: 's', _photoStripped: true }]);
  assert.deepEqual(countReportPhotos(r), { total: 4, refs: 2, legacy: 2, pending: 1 });
  assert.deepEqual(countReportPhotos(null), { total: 0, refs: 0, legacy: 0, pending: 0 });
});

test('roles', () => {
  for (const t of ['executive', 'it', 'office_staff', 'construction']) assert.equal(canUploadReportPhotos(t), true);
  for (const t of ['manager', 'dm', '', undefined]) assert.equal(canUploadReportPhotos(t), false);
});

// ── v23.13: captions, time taken, converting old reports ──────────────────────────────────
import { cleanCaption, photoStampLabel, needsLegacyConversion, legacyPhotoSlots, applyConvertedRefs, MAX_CAPTION } from './report-photos.mjs';
const IMG2 = 'data:image/jpeg;base64,' + 'A'.repeat(64);
const ref2 = (id, extra = {}) => ({ photoId: id, fullKey: `k_${id}`, medKey: `k_${id}_med`, name: `${id}.jpg`, timestamp: '2026-11-20T12:00:00', ...extra });

test('a ref keeps its caption and times through save, local strip and reconcile', () => {
  const p = ref2('a', { caption: '  North wall \n framing ', takenAt: '2026-11-20T09:15:02', uploadedAt: '2026-11-20T15:00:00.000Z', _status: undefined, data: IMG2 });
  const { slimReport } = splitReportForSave({ id: 1, workLogs: [{ photos: [p] }] });
  assert.deepEqual(slimReport.workLogs[0].photos[0], { ...ref2('a'), caption: 'North wall framing', takenAt: '2026-11-20T09:15:02', uploadedAt: '2026-11-20T15:00:00.000Z' });
  assert.equal(stripReportPhotosForLocal({ workLogs: [{ photos: [p] }] }).workLogs[0].photos[0].caption, 'North wall framing');
  const stored = { workLogs: [{ photos: [ref2('a', { caption: 'kept' })] }] };
  assert.equal(reconcileReportRefs({ workLogs: [{ photos: [] }] }, stored).workLogs[0].photos[0].caption, 'kept');
  assert.equal('caption' in cleanRef(ref2('a', { caption: '   ', takenAt: 'yesterday', uploadedAt: 'nope' })), false);
  assert.equal(cleanCaption('x'.repeat(500)).length, MAX_CAPTION);
  assert.equal(cleanCaption(null), '');
});

test('photo stamp: taken time, else upload time, else the report date', () => {
  assert.equal(photoStampLabel({ takenAt: '2026-11-24T09:05:00', uploadedAt: '2026-11-24T20:00:00Z', timestamp: '2026-11-24T12:00:00' }), 'Taken 11/24/2026 9:05 AM');
  assert.equal(photoStampLabel({ takenAt: '2026-11-24T00:30:00' }), 'Taken 11/24/2026 12:30 AM');
  assert.equal(photoStampLabel({ takenAt: '2026-11-24T12:00:00' }), 'Taken 11/24/2026 12:00 PM');
  assert.equal(photoStampLabel({ uploadedAt: new Date(2026, 10, 24, 14, 7).toISOString(), timestamp: '2026-11-20T12:00:00' }), 'Uploaded 11/24/2026 2:07 PM');
  assert.equal(photoStampLabel({ timestamp: '2026-11-20T12:00:00' }), '11/20/2026');
  assert.equal(photoStampLabel({ takenAt: 'garbage', timestamp: '2026-11-20' }), '11/20/2026');
  assert.equal(photoStampLabel(null), '');
});

test('converting a report: legacy photos become refs in place, ahead of newer photos', () => {
  const report = { id: 77, workLogs: [
    { name: 'A', photos: [{ data: IMG2, name: 'one.jpg', timestamp: '2026-10-01T12:00:00', caption: 'old' }, { data: IMG2, name: 'two.jpg', timestamp: '2026-10-01T12:00:00' }, ref2('new1')] },
    { name: 'B', photos: [] },
    { name: 'C', photos: [{ data: IMG2, name: 'three.jpg', timestamp: '2026-10-01T12:00:00' }] },
  ] };
  assert.equal(needsLegacyConversion(report), true);
  const slots = legacyPhotoSlots(report);
  assert.deepEqual(slots.map(s => s.sourceRef), ['dr_77_0_0', 'dr_77_0_1', 'dr_77_2_0']);
  const refs = new Map(slots.map(s => [`${s.wi}:${s.pi}`, { photoId: `c${s.wi}${s.pi}`, fullKey: 'f', medKey: 'm' }]));
  const done = applyConvertedRefs(report, refs, '2026-11-24T15:00:00.000Z');
  assert.deepEqual(done.workLogs[0].photos.map(p => p.photoId), ['c00', 'c01', 'new1']);
  assert.deepEqual(done.workLogs[0].photos[0], { photoId: 'c00', fullKey: 'f', medKey: 'm', name: 'one.jpg', timestamp: '2026-10-01T12:00:00', caption: 'old' });
  assert.deepEqual(done.workLogs[2].photos.map(p => p.photoId), ['c20']);
  assert.equal(needsLegacyConversion(done), false);
  refs.delete('2:0');
  assert.throws(() => applyConvertedRefs(report, refs, 'x'), /not uploaded/);
  assert.equal(needsLegacyConversion({ workLogs: [{ photos: [{ name: 'x', _photoStripped: true }] }] }), true);
  assert.equal(needsLegacyConversion({ workLogs: [{ photos: [ref2('a')] }] }), false);
});

test('a converted report ignores its old photo map and stays converted', () => {
  const converted = { id: 77, legacyConvertedAt: '2026-11-24T15:00:00.000Z', workLogs: [{ photos: [ref2('c00')] }] };
  const staleMap = { 0: [{ data: IMG2, name: 'one.jpg' }] };
  assert.deepEqual(mergeLoadedReport(converted, staleMap).workLogs[0].photos.map(p => p.photoId), ['c00']);
  // a copy loaded before the conversion (inline photos, no flag) is saved afterwards
  const stale = { id: 77, workLogs: [{ photos: [{ data: IMG2, name: 'one.jpg' }] }] };
  const saved = reconcileReportRefs(splitReportForSave(stale).slimReport, converted);
  assert.equal(saved.legacyConvertedAt, converted.legacyConvertedAt);
  assert.deepEqual(saved.workLogs[0].photos.map(p => p.photoId), ['c00']);
  // and a converted copy never writes inline photos back
  const split = splitReportForSave({ ...converted, workLogs: [{ photos: [{ data: IMG2, name: 'one.jpg' }, ref2('c00')] }] });
  assert.equal(split.hasReal, false); assert.deepEqual(split.photoMap, {});
  assert.equal(reconcileReportRefs({ workLogs: [] }, { legacyConvertedAt: 'x', workLogs: [] }).legacyConvertedAt, 'x');
});
