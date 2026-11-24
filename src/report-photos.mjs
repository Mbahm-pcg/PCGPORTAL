// Daily Report photos — pure storage-shape logic, shared by app.jsx and the nightly
// backup (netlify/functions/reports-backup.mjs). No DOM, no network.
// Spec: docs/superpowers/specs/2026-11-21-daily-report-photos-design.md
//
// A work log's `photos` array can hold two kinds of entries:
//   legacy — { data, name, timestamp }                     image inline as a base64 data URL;
//            persisted together in the pcg_dr_{id}_photos blob (the "photo map").
//   ref    — { photoId, fullKey, medKey, name, timestamp }  image lives in its own blobs
//            (project_photos row); persisted inside the report blob itself. Optional:
//            caption (typed by the crew), takenAt (camera's own capture time, local
//            'YYYY-MM-DDTHH:MM:SS'), uploadedAt (ISO instant the upload finished).
// `timestamp` is the REPORT's date (noon) on every photo — kept for old code and sorting.
// A report whose legacy photos were converted to refs carries `legacyConvertedAt`; from then
// on its photo map is ignored (a stale copy must not bring the inline photos back).
// While a form is open a photo may also carry transient fields (_status, _localId, _error,
// and for refs a local `data` preview). Those never reach storage.

export const PHOTO_FORMAT_VERSION = 2; // stamped on every report blob saved by v23.11+ code
export const REPORT_PHOTO_ROLES = ['executive', 'it', 'office_staff', 'construction'];
export const canUploadReportPhotos = (userType) => REPORT_PHOTO_ROLES.includes(userType);

export const isRefPhoto = (p) => !!(p && typeof p.photoId === 'string' && p.photoId.length > 0);

export const isPendingPhoto = (p) => !!(p && (p._status === 'uploading' || p._status === 'failed'));

// A legacy photo with real image data (not a `_photoStripped` placeholder / empty entry).
export const isRealReportPhoto = (p) =>
  !!(p && !isRefPhoto(p) && !isPendingPhoto(p) && typeof p.data === 'string' && p.data.length > 32);

export const MAX_CAPTION = 200;
export const cleanCaption = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION) : '');
const LOCAL_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

export function cleanRef(p) {
  const out = { photoId: p.photoId, fullKey: p.fullKey, medKey: p.medKey, name: p.name, timestamp: p.timestamp };
  const caption = cleanCaption(p.caption);
  if (caption) out.caption = caption;
  if (typeof p.takenAt === 'string' && LOCAL_TIME.test(p.takenAt)) out.takenAt = p.takenAt;
  if (typeof p.uploadedAt === 'string' && !Number.isNaN(Date.parse(p.uploadedAt))) out.uploadedAt = p.uploadedAt;
  return out;
}

// The line printed on a photo: when it was really taken if the camera recorded that, else
// when it was uploaded, else (older photos) just the report's date.
const clock = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
export function photoStampLabel(p) {
  if (!p) return '';
  const t = typeof p.takenAt === 'string' ? LOCAL_TIME.exec(p.takenAt) : null;
  if (t) return `Taken ${t[2]}/${t[3]}/${t[1]} ${clock(Number(t[4]), Number(t[5]))}`;
  const up = typeof p.uploadedAt === 'string' ? new Date(p.uploadedAt) : null;
  if (up && !Number.isNaN(up.getTime())) {
    const two = (n) => String(n).padStart(2, '0');
    return `Uploaded ${two(up.getMonth() + 1)}/${two(up.getDate())}/${up.getFullYear()} ${clock(up.getHours(), up.getMinutes())}`;
  }
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(p.timestamp || ''));
  return d ? `${d[2]}/${d[3]}/${d[1]}` : String(p.timestamp || '');
}

// → { slimReport, photoMap, hasReal }
//   slimReport — what goes in pcg_dr_{id}: everything except legacy image data.
//   photoMap   — { [workLogIndex]: legacyPhoto[] } for pcg_dr_{id}_photos.
//   hasReal    — this copy carries at least one legacy photo with real data.
export function splitReportForSave(report) {
  const photoMap = {};
  let hasReal = false;
  const { _photosLoaded, ...rest } = report || {};
  const gone = new Set(Array.isArray(rest.removedPhotoIds) ? rest.removedPhotoIds : []);
  const slimReport = {
    ...rest,
    _pv: PHOTO_FORMAT_VERSION,
    workLogs: (rest.workLogs || []).map((w, i) => {
      const photos = w.photos || [];
      const real = rest.legacyConvertedAt ? [] : photos.filter(isRealReportPhoto);
      if (real.length > 0) { photoMap[i] = real; hasReal = true; }
      return { ...w, photos: photos.filter(p => isRefPhoto(p) && !isPendingPhoto(p) && !gone.has(p.photoId)).map(cleanRef) };
    }),
  };
  return { slimReport, photoMap, hasReal };
}

// Recombine a loaded report blob with its photo map. Legacy photos come first so their
// position (used by the Project Gallery's "dr_<report>_<log>_<n>" source_ref) never shifts.
export function mergeLoadedReport(report, photoMap) {
  if (!report) return report;
  if (report.legacyConvertedAt) { // converted: refs only, whatever a leftover photo map says
    return { ...report, workLogs: (report.workLogs || []).map(w => ({ ...w, photos: (w.photos || []).filter(isRefPhoto) })) };
  }
  if (!photoMap || typeof photoMap !== 'object') return report;
  return {
    ...report,
    workLogs: (report.workLogs || []).map((w, i) => {
      const fromMap = photoMap[i];
      if (!Array.isArray(fromMap)) return { ...w, photos: w.photos || [] };
      return { ...w, photos: [...fromMap, ...(w.photos || []).filter(isRefPhoto)] };
    }),
  };
}

// Photo refs are reconciled on the SERVER every time a report blob is saved (storage.mjs),
// because the copy doing the saving can be out of date: a second person with the same report
// open, a phone that missed an update, Force Sync, or a browser still running pre-v23.11 code
// (which saves every report with `photos: []`). Any of those used to be able to drop refs
// that someone else had just added.
//
// Rule: a ref leaves a report ONLY by being listed in `removedPhotoIds` (a tombstone, written
// by the form the user removed it in). So:
//   - refs in the stored copy that the incoming copy lacks are carried over (same work-log
//     position; refs of a work log that no longer exists move to the last one), and
//   - a tombstoned ref is dropped even if a stale copy still carries it.
//   → the report to store (the `incoming` object itself when there is nothing to reconcile)
export const MAX_TOMBSTONES = 1000;
const BLANK_LOG = () => ({ name: '', description: '', quantity: '', totalHours: '', hoursToDate: '', photos: [] });
const idList = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []);

export function reconcileReportRefs(incoming, existing) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const removed = new Set([...idList(existing?.removedPhotoIds), ...idList(incoming.removedPhotoIds)]);
  const oldLogs = Array.isArray(existing?.workLogs) ? existing.workLogs : [];
  const storedHasRefs = oldLogs.some(w => (w?.photos || []).some(isRefPhoto));
  // A copy from before the conversion must not un-convert the report.
  const converted = incoming.legacyConvertedAt || existing?.legacyConvertedAt;
  if (!storedHasRefs && removed.size === 0) return converted && !incoming.legacyConvertedAt ? { ...incoming, legacyConvertedAt: converted } : incoming;

  const logs = (Array.isArray(incoming.workLogs) ? incoming.workLogs : []).map(w => ({
    ...w,
    photos: (w?.photos || []).filter(p => !(isRefPhoto(p) && removed.has(p.photoId))),
  }));
  const have = new Set();
  logs.forEach(w => w.photos.forEach(p => { if (isRefPhoto(p)) have.add(p.photoId); }));
  oldLogs.forEach((w, i) => {
    const carry = (w?.photos || []).filter(p => isRefPhoto(p) && !removed.has(p.photoId) && !have.has(p.photoId)).map(cleanRef);
    if (!carry.length) return;
    if (!logs.length) logs.push(BLANK_LOG());
    const target = logs[Math.min(i, logs.length - 1)];
    target.photos = [...target.photos, ...carry];
    carry.forEach(p => have.add(p.photoId));
  });
  return { ...incoming, ...(converted ? { legacyConvertedAt: converted } : {}), workLogs: logs, removedPhotoIds: [...removed].slice(-MAX_TOMBSTONES) };
}

// Every photo id a report still points at (used by the nightly purge to never delete one).
export function referencedPhotoIds(reports) {
  const ids = new Set();
  for (const r of (reports || [])) for (const w of (r?.workLogs || [])) for (const p of (w?.photos || [])) {
    if (isRefPhoto(p)) ids.add(p.photoId);
  }
  return ids;
}

// For localStorage: no image data at all. Refs keep their keys (they are tiny).
export function stripReportPhotosForLocal(report) {
  if (!report) return report;
  return {
    ...report,
    workLogs: (report.workLogs || []).map(w => ({
      ...w,
      photos: (w.photos || []).filter(p => !isPendingPhoto(p)).map(p =>
        isRefPhoto(p) ? cleanRef(p) : { name: p.name, timestamp: p.timestamp, _photoStripped: true }),
    })),
  };
}

// total = photos that belong to the report (refs + legacy, incl. stripped placeholders);
// pending = still uploading / failed in an open form (not part of total).
export function countReportPhotos(report) {
  const out = { total: 0, refs: 0, legacy: 0, pending: 0 };
  for (const w of (report?.workLogs || [])) {
    for (const p of (w.photos || [])) {
      if (!p) continue;
      if (isPendingPhoto(p)) out.pending++;
      else if (isRefPhoto(p)) { out.refs++; out.total++; }
      else { out.legacy++; out.total++; }
    }
  }
  return out;
}

// ── Converting old reports (legacy inline photos → refs) ──────────────────────────────────
// Needs converting: still has legacy photos (real, or placeholders in a stripped copy).
export const needsLegacyConversion = (report) => !!report && !report.legacyConvertedAt && countReportPhotos(report).legacy > 0;

// The legacy photos of a fully loaded report, with their position. `pi` is the photo's index
// in its work log — the same number the Project Gallery used in "dr_<report>_<log>_<n>".
export function legacyPhotoSlots(report) {
  const out = [];
  (report?.workLogs || []).forEach((w, wi) => (w.photos || []).forEach((p, pi) => {
    if (isRealReportPhoto(p)) out.push({ wi, pi, photo: p, sourceRef: `dr_${report.id}_${wi}_${pi}` });
  }));
  return out;
}

// → the report with every legacy photo replaced by its uploaded ref (same order, still ahead
//   of the photos added later), stamped legacyConvertedAt. `refs` = Map "wi:pi" → ref fields.
//   Throws if a legacy photo has no ref — a half-converted report would lose that photo.
export function applyConvertedRefs(report, refs, at) {
  return {
    ...report,
    legacyConvertedAt: at,
    workLogs: (report.workLogs || []).map((w, wi) => {
      const converted = [], later = [];
      (w.photos || []).forEach((p, pi) => {
        if (isRefPhoto(p)) { later.push(p); return; }
        if (!isRealReportPhoto(p)) return;
        const ref = refs.get(`${wi}:${pi}`);
        if (!ref || !ref.photoId) throw new Error(`Photo ${pi + 1} of work log ${wi + 1} was not uploaded`);
        converted.push(cleanRef({ ...ref, name: p.name, timestamp: p.timestamp, caption: p.caption }));
      });
      return { ...w, photos: [...converted, ...later] };
    }),
  };
}
