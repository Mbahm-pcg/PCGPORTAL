import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRefPhoto, isRealReportPhoto, isPendingPhoto, cleanRef,
  splitReportForSave, mergeLoadedReport, stripReportPhotosForLocal,
  countReportPhotos, canUploadReportPhotos,
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
  assert.deepEqual(mergeLoadedReport(slimReport, photoMap), input);
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
